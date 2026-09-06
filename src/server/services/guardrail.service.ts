import "server-only";

import type {
  ActionTarget,
  GuardrailEvaluationResult,
  GuardrailPhase,
  GuardrailPolicyRules,
  ProposedAction,
} from "@/core/guardrails";
import { evaluateGuardrails, guardrailPolicyRulesSchema } from "@/core/guardrails";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";

/**
 * Guardrail evaluation against live database state.
 *
 * The service's only job is to READ the world accurately and hand it to the
 * pure engine. No rule logic lives here — if it did, the PRE_APPROVAL and
 * PRE_EXECUTION runs could drift apart, which would defeat the purpose of
 * running twice.
 */

/** Interventions holding a live slot: proposed, awaiting a decision, or approved. */
const LIVE_STATES = ["PROPOSED", "PENDING_APPROVAL", "APPROVED"] as const;

/** States whose committed discount counts against the rolling budget. */
const COMMITTED_STATES = ["PENDING_APPROVAL", "APPROVED"] as const;

export interface EvaluateOptions {
  phase: GuardrailPhase;
  /** The instant to judge against. Defaults to now. */
  evaluatedAt?: Date;
  /** Persist the evaluation. Default true. */
  persist?: boolean;
  client?: PrismaClient;
}

export interface GuardrailServiceResult {
  evaluation: GuardrailEvaluationResult;
  /** Null when `persist` is false. */
  evaluationId: string | null;
  policyVersion: number;
}

/** Read the merchant's active policy, validating its shape. */
export async function loadActivePolicy(
  db: PrismaClient,
  merchantId: string,
): Promise<{ id: string; version: number; rules: GuardrailPolicyRules }> {
  const policy = await db.guardrailPolicy.findFirst({
    where: { merchantId, isActive: true },
    orderBy: { version: "desc" },
  });
  if (!policy) throw new Error(`No active guardrail policy for merchant ${merchantId}`);

  // A malformed policy fails loudly. A rule that silently stops running would
  // still render as a reassuring green row in the UI.
  const rules = guardrailPolicyRulesSchema.parse(policy.rules);
  return { id: policy.id, version: policy.version, rules };
}

/**
 * Evaluate guardrails for one intervention.
 *
 * Every fact is re-read at call time. That is what makes PRE_EXECUTION
 * meaningful: budget consumed, consent withdrawn, or contacts made since
 * approval all show up here and nowhere else.
 */
export async function evaluateInterventionGuardrails(
  interventionId: string,
  options: EvaluateOptions,
): Promise<GuardrailServiceResult> {
  const db = options.client ?? prisma;
  const evaluatedAt = options.evaluatedAt ?? new Date();
  const persist = options.persist ?? true;

  const intervention = await db.intervention.findUnique({
    where: { id: interventionId },
    include: {
      merchant: { select: { id: true, mode: true, timezone: true } },
      estimate: true,
      playbook: { select: { id: true, key: true, defaultDiscountBps: true } },
      targets: {
        include: { customer: { select: { id: true, sourceRef: true, doNotContactUntil: true } } },
      },
    },
  });
  if (!intervention) throw new Error(`Unknown intervention: ${interventionId}`);

  const merchantId = intervention.merchantId;
  const policy = await loadActivePolicy(db, merchantId);

  // ---- Live state ---------------------------------------------------------
  const contactWindowStart = new Date(
    evaluatedAt.getTime() - policy.rules.MAX_CONTACTS_PER_CUSTOMER.window_days * 86_400_000,
  );

  // Contacts already made to these customers, excluding this intervention's own
  // targets: an action must not count itself as prior contact.
  const priorContacts = await db.interventionTarget.groupBy({
    by: ["customerId"],
    where: {
      customerId: { in: intervention.targets.map((t) => t.customerId) },
      interventionId: { not: interventionId },
      intervention: {
        merchantId,
        state: { in: [...COMMITTED_STATES] },
        createdAt: { gte: contactWindowStart },
      },
    },
    _count: { _all: true },
  });
  const contactCounts = new Map(priorContacts.map((row) => [row.customerId, row._count._all]));

  const [committedDiscount, concurrentLive] = await Promise.all([
    db.estimate.aggregate({
      where: {
        merchantId,
        interventions: {
          some: {
            state: { in: [...COMMITTED_STATES] },
            id: { not: interventionId },
            createdAt: { gte: new Date(evaluatedAt.getTime() - 86_400_000) },
          },
        },
      },
      _sum: { discountCostPaise: true },
    }),
    db.intervention.count({
      where: { merchantId, state: { in: [...LIVE_STATES] }, id: { not: interventionId } },
    }),
  ]);

  const discountBps = readDiscountBps(intervention.estimate.inputsSnapshot, intervention.playbook.defaultDiscountBps);

  const targets: ActionTarget[] = intervention.targets.map((target) => ({
    customerId: target.customerId,
    customerRef: target.customer.sourceRef,
    transactionId: target.transactionId,
    amountPaise: target.amountPaise,
    recentContactCount: contactCounts.get(target.customerId) ?? 0,
    // Suppression is a date: a lapsed one does not suppress.
    isSuppressed:
      target.customer.doNotContactUntil !== null &&
      target.customer.doNotContactUntil.getTime() > evaluatedAt.getTime(),
  }));

  const action: ProposedAction = {
    interventionId,
    playbookId: intervention.playbookId,
    playbookKey: intervention.playbook.key,
    discountBps,
    // Money is copied from the Estimate, never recomputed here.
    expectedGrossPaise: intervention.estimate.expectedGrossPaise,
    expectedNetPaise: intervention.estimate.expectedNetPaise,
    discountCostPaise: intervention.estimate.discountCostPaise,
    costPaise: intervention.estimate.costPaise,
    confidence: intervention.estimate.confidence,
    targets,
  };

  const evaluation = evaluateGuardrails({
    phase: options.phase,
    evaluatedAt,
    action,
    policy: policy.rules,
    policyVersion: policy.version,
    state: {
      mode: intervention.merchant.mode,
      timezone: intervention.merchant.timezone,
      dailyDiscountCommittedPaise: committedDiscount._sum.discountCostPaise ?? 0,
      concurrentLiveCount: concurrentLive,
    },
  });

  if (!persist) {
    return { evaluation, evaluationId: null, policyVersion: policy.version };
  }

  const row = await db.guardrailEvaluation.create({
    data: {
      merchantId,
      interventionId,
      policyId: policy.id,
      policyVersion: policy.version,
      phase: options.phase,
      decision: evaluation.decision,
      ruleResults: {
        decision: evaluation.decision,
        evaluatedAt: evaluatedAt.toISOString(),
        results: evaluation.results.map((result) => ({ ...result })),
      } as unknown as Prisma.InputJsonObject,
      evaluatedAt,
    },
    select: { id: true },
  });

  return { evaluation, evaluationId: row.id, policyVersion: policy.version };
}

/** The discount actually scored, from the estimate's snapshot. */
function readDiscountBps(snapshot: unknown, fallback: number): number {
  if (snapshot && typeof snapshot === "object") {
    const value = (snapshot as Record<string, unknown>).discountBps;
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return fallback;
}
