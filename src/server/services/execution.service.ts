import "server-only";

import { createHash } from "node:crypto";

import type { GuardrailEvaluationResult } from "@/core/guardrails";
import { applyBps } from "@/lib/money";
import type { Prisma } from "@/generated/prisma/client";
import type {
  CreatePaymentLinkCommand, PaymentLinkArtifact, PaymentProvider,
} from "@/integrations/razorpay";
import { FakePaymentProvider, ProviderError, RazorpayProvider } from "@/integrations/razorpay";
import { getEnv } from "@/lib/env";
import { appendAuditEntry } from "@/server/audit/audit-logger";
import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";
import { evaluateInterventionGuardrails } from "./guardrail.service";
import { TransitionError, transitionIntervention } from "./intervention-state.service";

/**
 * The executor.
 *
 * The only component that causes an effect outside RevenuePilot, and the one
 * with the most ways to go wrong. Its order of operations is the whole design:
 *
 *   1. verify the intervention is APPROVED and a real Approval exists
 *   2. re-run PRE_EXECUTION guardrails against FRESH state
 *   3. persist an ExecutionAttempt BEFORE any external call
 *   4. call the provider
 *   5. persist the artifact
 *   6. APPROVED -> EXECUTING -> EXECUTED -> OBSERVING
 *
 * EXECUTED means "the action was created at the provider". It does NOT mean
 * revenue was recovered, and nothing here writes a recovered figure.
 */

const MAX_ATTEMPTS_PER_TARGET = 3;
const RETRY_BACKOFF_MS = [250, 1_000];

export interface ExecuteOptions {
  userId: string;
  expectedVersion: number;
  provider?: PaymentProvider;
  evaluatedAt?: Date;
  client?: PrismaClient;
}

export interface ExecutedArtifact {
  targetRef: string;
  customerRef: string;
  providerEntityId: string;
  shortUrl: string;
  amountPaise: number;
  status: string;
  reconciled: boolean;
}

export type ExecutionOutcome =
  | {
      status: "EXECUTED";
      interventionId: string;
      version: number;
      artifacts: ExecutedArtifact[];
      failedTargets: number;
      evaluation: GuardrailEvaluationResult;
    }
  | {
      status: "BLOCKED";
      interventionId: string;
      version: number;
      evaluation: GuardrailEvaluationResult;
      blockingRules: { ruleId: string; message: string }[];
    }
  | {
      status: "EXECUTION_FAILED";
      interventionId: string;
      version: number;
      errors: { targetRef: string; message: string; kind: string }[];
    };

/**
 * Choose a provider.
 *
 * Defaults to the fake. Real calls require PAYMENT_PROVIDER="razorpay" AND
 * credentials AND RAZORPAY_MODE="test" — the adapter refuses to construct
 * otherwise, so a misconfiguration fails loudly at startup rather than
 * silently doing nothing.
 */
export function resolvePaymentProvider(): PaymentProvider {
  const env = getEnv();
  if (env.PAYMENT_PROVIDER !== "razorpay") return new FakePaymentProvider();

  return new RazorpayProvider({
    keyId: env.RAZORPAY_KEY_ID!,
    keySecret: env.RAZORPAY_KEY_SECRET!,
    mode: env.RAZORPAY_MODE ?? "",
  });
}

export async function executeIntervention(
  interventionId: string,
  options: ExecuteOptions,
): Promise<ExecutionOutcome> {
  const db = options.client ?? prisma;
  const provider = options.provider ?? resolvePaymentProvider();
  const evaluatedAt = options.evaluatedAt ?? new Date();

  // ---- 1. State and approval ------------------------------------------------
  const intervention = await db.intervention.findUnique({
    where: { id: interventionId },
    include: {
      merchant: { select: { mode: true, currency: true } },
      estimate: true,
      playbook: { select: { key: true, name: true, defaultDiscountBps: true } },
      approval: true,
      targets: { include: { customer: { select: { sourceRef: true } } }, orderBy: { id: "asc" } },
    },
  });
  if (!intervention) throw new TransitionError(`Unknown intervention: ${interventionId}`, "NOT_FOUND");

  if (!["APPROVED", "EXECUTION_FAILED"].includes(intervention.state)) {
    throw new TransitionError(
      `Only an APPROVED intervention can be executed; this one is ${intervention.state}.`,
      "ILLEGAL_TRANSITION", intervention.version, intervention.state,
    );
  }
  // Belt and braces with the database trigger: no approval, no execution.
  if (!intervention.approval || intervention.approval.decision !== "APPROVED") {
    throw new TransitionError(
      "This intervention has no recorded APPROVED approval.",
      "ILLEGAL_TRANSITION", intervention.version, intervention.state,
    );
  }
  if (intervention.version !== options.expectedVersion) {
    throw new TransitionError(
      `This intervention changed since you loaded it (you have version ` +
        `${options.expectedVersion}, current is ${intervention.version}). Reload and review it again.`,
      "STALE_VERSION", intervention.version, intervention.state,
    );
  }
  // The provider itself is test-only, but assert the merchant too.
  if (intervention.merchant.mode !== "TEST") {
    throw new TransitionError(
      `Merchant is in ${intervention.merchant.mode} mode. This build executes in TEST mode only.`,
      "ILLEGAL_TRANSITION", intervention.version, intervention.state,
    );
  }

  await audit(db, intervention.merchantId, {
    actorId: options.userId, entityId: interventionId, action: "EXECUTION_REQUESTED",
    after: { provider: provider.name, mode: provider.mode, targetCount: intervention.targets.length },
  });

  // ---- 2. PRE_EXECUTION guardrails, against state as it is right now --------
  const { evaluation } = await evaluateInterventionGuardrails(interventionId, {
    phase: "PRE_EXECUTION", evaluatedAt, client: db,
  });

  if (evaluation.blocked) {
    const blocked = await transitionIntervention(interventionId, {
      to: "GUARDRAIL_BLOCKED", expectedVersion: intervention.version,
      actorType: "USER", actorId: options.userId,
      action: "EXECUTION_BLOCKED_BY_GUARDRAIL",
      metadata: {
        phase: "PRE_EXECUTION", decision: evaluation.decision,
        blockingRules: evaluation.failures.filter((f) => f.severity === "BLOCK").map((f) => f.ruleId),
      },
      data: { closedAt: evaluatedAt }, evaluatedAt, client: db,
    });
    return {
      status: "BLOCKED", interventionId, version: blocked.version, evaluation,
      blockingRules: evaluation.failures
        .filter((f) => f.severity === "BLOCK")
        .map((f) => ({ ruleId: f.ruleId, message: f.message })),
    };
  }

  // ---- 3. EXECUTING ---------------------------------------------------------
  const executing = await transitionIntervention(interventionId, {
    to: "EXECUTING", expectedVersion: intervention.version,
    actorType: "USER", actorId: options.userId, action: "EXECUTION_STARTED",
    metadata: { provider: provider.name }, data: { executedAt: evaluatedAt },
    evaluatedAt, client: db,
  });

  // The amount the customer actually pays, after the approved discount.
  const discountBps = readDiscountBps(
    intervention.estimate.inputsSnapshot, intervention.playbook.defaultDiscountBps,
  );
  const message = (intervention.customerMessage ?? {}) as Record<string, unknown>;
  const description = typeof message.subject === "string" && message.subject.length > 0
    ? message.subject.slice(0, 2_048)
    : `Complete your payment with ${intervention.playbook.name}`;
  const expiresAt = intervention.expiresAt ?? new Date(evaluatedAt.getTime() + 7 * 86_400_000);

  const artifacts: ExecutedArtifact[] = [];
  const errors: { targetRef: string; message: string; kind: string }[] = [];
  let attemptCounter = await db.executionAttempt.count({ where: { interventionId } });

  for (const target of intervention.targets) {
    const payable = target.amountPaise - applyBps(target.amountPaise, discountBps);
    const command: CreatePaymentLinkCommand = {
      amountPaise: payable,
      currency: intervention.merchant.currency,
      description,
      // Stable across retries: Razorpay enforces uniqueness on it, which is
      // what makes a retry safe rather than duplicating a link.
      referenceId: target.perTargetRef,
      attributionRef: intervention.attributionRef,
      interventionId,
      customerRef: target.customer.sourceRef,
      expiresAt,
    };

    try {
      const artifact = await createWithRetries(db, {
        provider, command, interventionId, merchantId: intervention.merchantId,
        targetId: target.id, startingAttemptNo: attemptCounter + 1, userId: options.userId,
      });
      attemptCounter += artifact.attemptsUsed;

      await db.razorpayArtifact.create({
        data: {
          merchantId: intervention.merchantId, interventionId,
          executionAttemptId: artifact.executionAttemptId,
          artifactType: "PAYMENT_LINK",
          providerEntityId: artifact.artifact.providerEntityId,
          shortUrl: artifact.artifact.shortUrl,
          amountPaise: artifact.artifact.amountPaise,
          status: artifact.artifact.status,
          raw: artifact.artifact.raw as Prisma.InputJsonValue,
        },
      });

      artifacts.push({
        targetRef: target.perTargetRef, customerRef: target.customer.sourceRef,
        providerEntityId: artifact.artifact.providerEntityId,
        shortUrl: artifact.artifact.shortUrl, amountPaise: artifact.artifact.amountPaise,
        status: artifact.artifact.status, reconciled: artifact.artifact.reconciled,
      });
    } catch (error) {
      const providerError = error instanceof ProviderError
        ? error
        : new ProviderError((error as Error).message, "TRANSIENT");
      errors.push({
        targetRef: target.perTargetRef, message: providerError.message, kind: providerError.kind,
      });
      // Attempts consumed even on failure, so the next target's numbering is
      // still unique within the intervention.
      attemptCounter += MAX_ATTEMPTS_PER_TARGET;
    }
  }

  // One audit entry for the batch rather than one per artifact. Each audit
  // append takes a per-merchant advisory lock, so 26 separate transactions
  // would serialise the whole execution behind the lock. The itemised record
  // lives in RazorpayArtifact and ExecutionAttempt, which are queryable.
  if (artifacts.length > 0) {
    await audit(db, intervention.merchantId, {
      actorId: options.userId, entityType: "Intervention", entityId: interventionId,
      action: "ARTIFACTS_CREATED",
      after: {
        count: artifacts.length,
        reconciled: artifacts.filter((a) => a.reconciled).length,
        totalAmountPaise: artifacts.reduce((sum, a) => sum + a.amountPaise, 0),
        // "created" is the link's state, not a payment.
        providerEntityIds: artifacts.slice(0, 30).map((a) => a.providerEntityId),
      },
    });
  }

  // ---- Outcome --------------------------------------------------------------
  if (artifacts.length === 0) {
    const failed = await transitionIntervention(interventionId, {
      to: "EXECUTION_FAILED", expectedVersion: executing.version,
      actorType: "SYSTEM", actorId: options.userId, action: "EXECUTION_FAILED",
      metadata: { errorCount: errors.length, kinds: [...new Set(errors.map((e) => e.kind))] },
      evaluatedAt, client: db,
    });
    return { status: "EXECUTION_FAILED", interventionId, version: failed.version, errors };
  }

  const executed = await transitionIntervention(interventionId, {
    to: "EXECUTED", expectedVersion: executing.version,
    actorType: "SYSTEM", actorId: options.userId, action: "EXECUTION_SUCCEEDED",
    metadata: {
      artifactCount: artifacts.length, failedTargets: errors.length,
      // Stated explicitly so the audit trail cannot be misread later.
      note: "Payment links created at the provider. No revenue has been recovered.",
    },
    evaluatedAt, client: db,
  });

  // Awaiting payment. Not converted -- that needs a real payment event.
  const observing = await transitionIntervention(interventionId, {
    to: "OBSERVING", expectedVersion: executed.version,
    actorType: "SYSTEM", actorId: options.userId, action: "OBSERVING_STARTED",
    metadata: { awaiting: "payment", artifactCount: artifacts.length },
    data: { observedAt: evaluatedAt }, evaluatedAt, client: db,
  });

  return {
    status: "EXECUTED", interventionId, version: observing.version,
    artifacts, failedTargets: errors.length, evaluation,
  };
}

/**
 * Create one payment link, with bounded retries.
 *
 * The ExecutionAttempt is written BEFORE the call, so a crash between issue and
 * response leaves evidence. On an ambiguous or transient failure the executor
 * RECONCILES BY REFERENCE before retrying: a lost response must never produce a
 * second payment link.
 */
async function createWithRetries(
  db: PrismaClient,
  args: {
    provider: PaymentProvider; command: CreatePaymentLinkCommand;
    interventionId: string; merchantId: string; targetId: string;
    startingAttemptNo: number; userId: string;
  },
): Promise<{ artifact: PaymentLinkArtifact; executionAttemptId: string; attemptsUsed: number }> {
  let lastError: ProviderError | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS_PER_TARGET; attempt += 1) {
    const attemptNo = args.startingAttemptNo + attempt;
    const idempotencyKey = createHash("sha256")
      .update(`${args.interventionId}:${args.targetId}:${attemptNo}`)
      .digest("hex");

    // Before anything leaves the process.
    const row = await db.executionAttempt.create({
      data: {
        merchantId: args.merchantId, interventionId: args.interventionId,
        targetId: args.targetId, attemptNo, idempotencyKey, status: "PENDING",
        request: {
          // The request body minus nothing sensitive: no credential is ever here.
          amountPaise: args.command.amountPaise, currency: args.command.currency,
          referenceId: args.command.referenceId, provider: args.provider.name,
        } as Prisma.InputJsonObject,
      },
      select: { id: true },
    });

    // On a retry, ask whether the previous attempt actually landed.
    if (attempt > 0) {
      const existing = await args.provider
        .findPaymentLinkByReference(args.command.referenceId)
        .catch(() => null);
      if (existing) {
        await db.executionAttempt.update({
          where: { id: row.id },
          data: {
            status: "SUCCEEDED", finishedAt: new Date(),
            response: { reconciled: true, providerEntityId: existing.providerEntityId } as Prisma.InputJsonObject,
          },
        });
        return { artifact: existing, executionAttemptId: row.id, attemptsUsed: attempt + 1 };
      }
    }

    try {
      const artifact = await args.provider.createPaymentLink(args.command);
      await db.executionAttempt.update({
        where: { id: row.id },
        data: {
          status: "SUCCEEDED", responseStatus: 200, finishedAt: new Date(),
          response: {
            providerEntityId: artifact.providerEntityId, status: artifact.status,
            amountPaise: artifact.amountPaise,
          } as Prisma.InputJsonObject,
        },
      });
      return { artifact, executionAttemptId: row.id, attemptsUsed: attempt + 1 };
    } catch (error) {
      const providerError = error instanceof ProviderError
        ? error
        : new ProviderError((error as Error).message, "TRANSIENT");
      lastError = providerError;

      await db.executionAttempt.update({
        where: { id: row.id },
        data: {
          status: "FAILED", finishedAt: new Date(),
          ...(providerError.httpStatus === undefined ? {} : { responseStatus: providerError.httpStatus }),
          error: `${providerError.kind}: ${providerError.message}`,
        },
      });

      // A validation or auth error will not resolve by asking again.
      if (!providerError.isRetryable) throw providerError;

      const backoff = RETRY_BACKOFF_MS[attempt];
      if (backoff !== undefined && attempt < MAX_ATTEMPTS_PER_TARGET - 1) {
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }
  }

  throw lastError ?? new ProviderError("Execution failed after retries", "TRANSIENT");
}

async function audit(
  db: PrismaClient,
  merchantId: string,
  args: { actorId: string; entityId: string; action: string; entityType?: string; after?: unknown },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await appendAuditEntry(tx, {
      merchantId, actorType: "USER", actorId: args.actorId,
      entityType: args.entityType ?? "Intervention", entityId: args.entityId,
      action: args.action, after: args.after,
    });
  });
}

function readDiscountBps(snapshot: unknown, fallback: number): number {
  if (snapshot && typeof snapshot === "object") {
    const value = (snapshot as Record<string, unknown>).discountBps;
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return fallback;
}
