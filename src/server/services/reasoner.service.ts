import "server-only";

import { createHash } from "node:crypto";

import type { ReasonedProposal, ReasonerInput, UntrustedContext } from "@/core/reasoner";
import { SYSTEM_PROMPT, reasonOverCandidates } from "@/core/reasoner";
import type { LlmValidationOutcome, Prisma } from "@/generated/prisma/client";
import type { LlmProvider } from "@/integrations/llm";
import { AnthropicProvider, GroqProvider, UnavailableLlmProvider } from "@/integrations/llm";
import { getEnv } from "@/lib/env";
import { appendAuditEntry } from "@/server/audit/audit-logger";
import { loadMerchantConfig } from "@/server/dataset/config";
import type { MerchantConfig } from "@/server/dataset/config";
import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";
import {
  toReasonerCandidates,
  toReasonerOpportunity,
  toReasonerPolicy,
} from "./reasoner-input";

/**
 * Application service for the reasoning phase.
 *
 * Loads the opportunity and its persisted estimates, asks the model to choose
 * among them, validates the answer, and records an Intervention in PROPOSED.
 *
 * IT STOPS AT PROPOSED. Nothing here approves, executes, or contacts anyone;
 * the database would refuse an execution state anyway, since no Approval row
 * exists.
 */

export interface RunReasonerOptions {
  provider?: LlmProvider;
  /** Free text of uncertain origin, fenced off in the prompt as data. */
  untrusted?: readonly UntrustedContext[];
  /** Reason but write nothing. */
  dryRun?: boolean;
  /** Propose again even if an open proposal already exists. */
  force?: boolean;
  allowRepair?: boolean;
  client?: PrismaClient;
  config?: MerchantConfig;
}

export interface RunReasonerResult {
  merchantId: string;
  opportunityId: string;
  proposal: ReasonedProposal;
  input: ReasonerInput;
  interventionId: string | null;
  llmCallIds: readonly string[];
  created: boolean;
  providerName: string;
  providerModel: string;
}

/**
 * Choose a provider.
 *
 * With no API key configured this returns an unavailable provider rather than
 * throwing: an absent credential is a degraded mode, not an error, and the
 * reasoner will fall back and label the proposal accordingly.
 */
export function resolveProvider(): LlmProvider {
  const env = getEnv();

  const anthropic = () =>
    new AnthropicProvider({ apiKey: env.ANTHROPIC_API_KEY!, model: env.ANTHROPIC_MODEL });
  const groq = () => new GroqProvider({ apiKey: env.GROQ_API_KEY!, model: env.GROQ_MODEL });

  switch (env.LLM_PROVIDER) {
    case "none":
      return new UnavailableLlmProvider("LLM_PROVIDER=none; reasoning is disabled.");

    case "anthropic":
      return env.ANTHROPIC_API_KEY
        ? anthropic()
        : new UnavailableLlmProvider("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.");

    case "groq":
      return env.GROQ_API_KEY
        ? groq()
        : new UnavailableLlmProvider("LLM_PROVIDER=groq but GROQ_API_KEY is not set.");

    case "auto":
    default:
      if (env.ANTHROPIC_API_KEY) return anthropic();
      if (env.GROQ_API_KEY) return groq();
      // An absent credential is a degraded mode, not an error: the reasoner
      // falls back deterministically and labels the proposal accordingly.
      return new UnavailableLlmProvider(
        "No LLM credential configured (set ANTHROPIC_API_KEY or GROQ_API_KEY); " +
          "reasoning is running in deterministic fallback mode.",
      );
  }
}

const OUTCOME_TO_ENUM: Record<string, LlmValidationOutcome> = {
  VALID: "VALID",
  EMPTY_RESPONSE: "EMPTY_RESPONSE",
  MALFORMED_JSON: "MALFORMED_JSON",
  SCHEMA_INVALID: "SCHEMA_INVALID",
  UNKNOWN_PLAYBOOK: "UNKNOWN_PLAYBOOK",
  NUMERIC_HALLUCINATION: "NUMERIC_HALLUCINATION",
  UNSUPPORTED_MESSAGE_CLAIM: "UNSUPPORTED_MESSAGE_CLAIM",
  CONFIDENCE_OVERCLAIM: "CONFIDENCE_OVERCLAIM",
  PROVIDER_ERROR: "PROVIDER_ERROR",
};

export async function runReasonerForOpportunity(
  opportunityId: string,
  options: RunReasonerOptions = {},
): Promise<RunReasonerResult> {
  const db = options.client ?? prisma;
  const provider = options.provider ?? resolveProvider();
  const merchantConfig = options.config ?? loadMerchantConfig();

  // ---- Load the opportunity and its deterministic estimates ---------------
  const opportunity = await db.opportunity.findUnique({
    where: { id: opportunityId },
    include: {
      merchant: { select: { id: true, mode: true } },
      estimates: {
        include: {
          playbook: {
            select: {
              id: true, key: true, name: true, actionType: true, defaultDiscountBps: true,
            },
          },
        },
      },
    },
  });
  if (!opportunity) throw new Error(`Unknown opportunity: ${opportunityId}`);

  const merchantId = opportunity.merchantId;

  if (opportunity.estimates.length === 0) {
    throw new Error(
      `Opportunity ${opportunityId} has no estimates. Run the estimator before reasoning.`,
    );
  }

  const input: ReasonerInput = {
    opportunity: toReasonerOpportunity(opportunity),
    candidates: toReasonerCandidates(opportunity.estimates),
    policy: toReasonerPolicy(merchantConfig, opportunity.merchant.mode),
    ...(options.untrusted ? { untrusted: options.untrusted } : {}),
  };

  // ---- Reason -------------------------------------------------------------
  // The provider is wrapped in a plain function, so the core reasoner never
  // sees an SDK type and cannot reach anything but text generation.
  //
  // A dry run writes NOTHING, audit included. An append-only log that fills up
  // with entries from runs that changed nothing is a log nobody will read.
  const dryRun = options.dryRun ?? false;

  if (!dryRun) {
    await recordAuditEvent(db, {
      merchantId,
      entityId: opportunityId,
      action: "REASONING_REQUESTED",
      after: {
        opportunityId,
        candidateCount: input.candidates.length,
        provider: provider.name,
        model: provider.model,
        providerAvailable: provider.isAvailable,
      },
    });
  }

  const proposal = await reasonOverCandidates(
    input,
    async (userPrompt) => {
      const response = await provider.generateDecision({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
      });
      return {
        text: response.text,
        latencyMs: response.latencyMs,
        ...(response.inputTokens === undefined ? {} : { inputTokens: response.inputTokens }),
        ...(response.outputTokens === undefined ? {} : { outputTokens: response.outputTokens }),
      };
    },
    { allowRepair: options.allowRepair ?? true },
  );

  if (dryRun) {
    return {
      merchantId,
      opportunityId,
      proposal,
      input,
      interventionId: null,
      llmCallIds: [],
      created: false,
      providerName: provider.name,
      providerModel: provider.model,
    };
  }

  // ---- Persist -------------------------------------------------------------
  const existing = options.force
    ? null
    : await db.intervention.findFirst({
        where: { opportunityId, state: { in: ["DRAFT", "PROPOSED", "PENDING_APPROVAL"] } },
        orderBy: { createdAt: "asc" },
      });

  const llmCallIds = await persistLlmCalls(db, {
    merchantId,
    opportunityId,
    provider,
    proposal,
  });

  if (existing) {
    await recordAuditEvent(db, {
      merchantId,
      entityId: existing.id,
      action: "REASONING_REUSED_EXISTING_PROPOSAL",
      after: { interventionId: existing.id, opportunityId },
    });
    return {
      merchantId,
      opportunityId,
      proposal,
      input,
      interventionId: existing.id,
      llmCallIds,
      created: false,
      providerName: provider.name,
      providerModel: provider.model,
    };
  }

  const interventionId = await createProposedIntervention(db, {
    merchantId,
    opportunityId,
    proposal,
  });

  // Link the calls to the intervention they produced.
  if (llmCallIds.length > 0) {
    await db.llmCall.updateMany({
      where: { id: { in: [...llmCallIds] } },
      data: { interventionId },
    });
  }

  return {
    merchantId,
    opportunityId,
    proposal,
    input,
    interventionId,
    llmCallIds,
    created: true,
    providerName: provider.name,
    providerModel: provider.model,
  };
}

/**
 * Record every attempt, including the rejected ones.
 *
 * A rejected response is the evidence that validation is doing its job, so it
 * is stored as deliberately as a successful one.
 */
async function persistLlmCalls(
  db: PrismaClient,
  args: {
    merchantId: string;
    opportunityId: string;
    provider: LlmProvider;
    proposal: ReasonedProposal;
  },
): Promise<string[]> {
  const ids: string[] = [];

  for (const attempt of args.proposal.attempts) {
    const row = await db.llmCall.create({
      data: {
        merchantId: args.merchantId,
        opportunityId: args.opportunityId,
        provider: args.provider.name,
        model: args.provider.model,
        // The prompt is PII-free by construction (aggregates only) and holds no
        // credential, so storing it whole is safe and makes the call auditable.
        promptHash: createHash("sha256").update(attempt.prompt).digest("hex"),
        promptText: attempt.prompt,
        rawResponse: attempt.rawResponse,
        parsedOutput: (attempt.parsedOutput ?? undefined) as Prisma.InputJsonValue | undefined,
        attemptNo: attempt.attemptNo,
        isValid: attempt.isValid,
        validationOutcome: OUTCOME_TO_ENUM[attempt.outcome] ?? "PROVIDER_ERROR",
        validationResult: {
          kind: attempt.kind,
          outcome: attempt.outcome,
          issues: attempt.issues.map((issue) => ({
            outcome: issue.outcome,
            field: issue.field,
            message: issue.message,
            observed: issue.observed ?? null,
          })),
        } as Prisma.InputJsonObject,
        latencyMs: attempt.latencyMs,
        inputTokens: attempt.inputTokens ?? null,
        outputTokens: attempt.outputTokens ?? null,
        errorMessage: attempt.errorMessage ?? null,
      },
      select: { id: true },
    });
    ids.push(row.id);

    await recordAuditEvent(db, {
      merchantId: args.merchantId,
      entityType: "LlmCall",
      entityId: row.id,
      action: attempt.isValid ? "LLM_RESPONSE_ACCEPTED" : "LLM_RESPONSE_REJECTED",
      after: {
        attemptNo: attempt.attemptNo,
        kind: attempt.kind,
        outcome: attempt.outcome,
        issueCount: attempt.issues.length,
        latencyMs: attempt.latencyMs,
      },
    });
  }

  return ids;
}

/**
 * Create the Intervention in PROPOSED, with its targets, in one transaction
 * alongside the audit entry.
 *
 * Targets are copied from the opportunity because a proposal has to say WHO
 * would be contacted; the guardrail phase needs them to evaluate contact
 * limits. Nothing about creating them contacts anybody.
 */
async function createProposedIntervention(
  db: PrismaClient,
  args: { merchantId: string; opportunityId: string; proposal: ReasonedProposal },
): Promise<string> {
  const { merchantId, opportunityId, proposal } = args;

  const targets = await db.opportunityTarget.findMany({
    where: { opportunityId },
    orderBy: { id: "asc" },
    select: { customerId: true, transactionId: true, recoverableAmountPaise: true },
  });

  return db.$transaction(async (tx) => {
    const attributionRef = `rp_${randomRef()}`;

    const intervention = await tx.intervention.create({
      data: {
        merchantId,
        opportunityId,
        playbookId: proposal.selectedCandidate.playbookId,
        estimateId: proposal.selectedCandidate.estimateId,
        // This phase stops here. Approval and execution are later, gated states.
        state: "PROPOSED",
        reasoningMode: proposal.reasoningMode,
        rationale: proposal.rationale,
        customerMessage: {
          subject: proposal.customerMessage.subject,
          body: proposal.customerMessage.body,
          risksIdentified: [...proposal.risksIdentified],
          confidenceNote: proposal.confidenceNote,
        } as Prisma.InputJsonObject,
        attributionRef,
        proposedAt: new Date(),
      },
      select: { id: true },
    });

    if (targets.length > 0) {
      await tx.interventionTarget.createMany({
        data: targets.map((target) => ({
          interventionId: intervention.id,
          customerId: target.customerId,
          transactionId: target.transactionId,
          amountPaise: target.recoverableAmountPaise,
          perTargetRef: `${attributionRef}_${randomRef()}`,
        })),
      });
    }

    await appendAuditEntry(tx, {
      merchantId,
      actorType: "AGENT",
      entityType: "Intervention",
      entityId: intervention.id,
      action: "INTERVENTION_PROPOSED",
      after: {
        opportunityId,
        state: "PROPOSED",
        reasoningMode: proposal.reasoningMode,
        playbookId: proposal.selectedCandidate.playbookId,
        playbookKey: proposal.selectedCandidate.playbookKey,
        estimateId: proposal.selectedCandidate.estimateId,
        // Money is copied from the Estimate, never from the model.
        expectedNetPaise: proposal.selectedCandidate.expectedNetPaise,
        expectedGrossPaise: proposal.selectedCandidate.expectedGrossPaise,
        costPaise: proposal.selectedCandidate.costPaise,
        confidence: proposal.selectedCandidate.confidence,
        targetCount: targets.length,
      },
    });

    return intervention.id;
  });
}

async function recordAuditEvent(
  db: PrismaClient,
  args: {
    merchantId: string;
    entityId: string;
    action: string;
    entityType?: string;
    after?: unknown;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await appendAuditEntry(tx, {
      merchantId: args.merchantId,
      actorType: "AGENT",
      entityType: args.entityType ?? "Opportunity",
      entityId: args.entityId,
      action: args.action,
      after: args.after,
    });
  });
}

function randomRef(): string {
  return createHash("sha256")
    .update(`${Date.now()}:${Math.random()}`)
    .digest("hex")
    .slice(0, 12);
}
