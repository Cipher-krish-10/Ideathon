import "server-only";

import { appendAuditEntry } from "@/server/audit/audit-logger";
import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";
import { transitionIntervention } from "./intervention-state.service";
import type { TransitionResult } from "./intervention-state.service";

/**
 * The LEARN step.
 *
 * A conversion increments alpha; a non-conversion increments beta. The next
 * estimator run reads base_rate = alpha / (alpha + beta), so an observed
 * outcome changes what the agent proposes next.
 *
 * IDEMPOTENCY comes from the state machine rather than a flag: the counters are
 * updated inside the same transaction that moves the intervention to LEARNED,
 * and LEARNED is terminal. A replayed webhook cannot re-enter it, so it cannot
 * increment twice.
 *
 * Counts are milli-units, matching PlaybookStat: one observation is 1000.
 */
const ONE_OBSERVATION_MILLI = 1_000;

export interface LearnOptions {
  outcome: "CONVERTED" | "NOT_CONVERTED";
  expectedVersion: number;
  /**
   * The transaction that actually converted.
   *
   * REQUIRED for a conversion. One payment is evidence about ONE failure-reason
   * cohort — the one the payer was in. Crediting every reason the intervention
   * happened to touch would inflate the priors by the number of cohorts and
   * corrupt every later estimate.
   */
  convertedTransactionId?: string;
  evaluatedAt?: Date;
  client?: PrismaClient;
}

export async function learnFromOutcome(
  interventionId: string,
  options: LearnOptions,
): Promise<TransitionResult> {
  const db = options.client ?? prisma;
  const evaluatedAt = options.evaluatedAt ?? new Date();

  const intervention = await db.intervention.findUniqueOrThrow({
    where: { id: interventionId },
    include: {
      playbook: { select: { id: true, key: true } },
      targets: {
        include: {
          transaction: {
            include: {
              paymentAttempts: {
                where: { status: "FAILED" }, orderBy: { attemptNo: "desc" }, take: 1,
              },
            },
          },
        },
      },
    },
  });

  // Learning is keyed on the failure reason the detector acted on, so an
  // updated prior applies to the situation it was actually observed in.
  //
  // A CONVERSION is evidence about exactly one cohort: the payer's. A LAPSE is
  // evidence against every cohort that was contacted and did not respond.
  const reasons = new Map<string, number>();
  const relevantTargets =
    options.outcome === "CONVERTED"
      ? intervention.targets.filter(
          (target) => target.transactionId === options.convertedTransactionId,
        )
      : intervention.targets;

  for (const target of relevantTargets) {
    const reason = target.transaction.paymentAttempts[0]?.failureReason;
    if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }

  // The transition and the counter updates share one transaction: a state
  // change without its learning, or learning without its state change, would
  // each be a way to count an outcome twice.
  return transitionIntervention(interventionId, {
    to: "LEARNED",
    expectedVersion: options.expectedVersion,
    actorType: "SYSTEM",
    action: "PLAYBOOK_STAT_UPDATED",
    metadata: {
      outcome: options.outcome,
      playbookKey: intervention.playbook.key,
      failureReasons: Object.fromEntries(reasons),
      increment: options.outcome === "CONVERTED" ? "alpha" : "beta",
      cohortsUpdated: reasons.size,
    },
    evaluatedAt,
    client: db,
    onCommit: async (tx) => {
      for (const [failureReason, _count] of reasons) {
        const stat = await tx.playbookStat.findFirst({
          where: {
            merchantId: intervention.merchantId,
            playbookId: intervention.playbookId,
            failureReason: failureReason as never,
            tierScope: "ALL",
          },
        });
        if (!stat) continue;

        await tx.playbookStat.update({
          where: { id: stat.id },
          data: {
            ...(options.outcome === "CONVERTED"
              ? { alphaMilli: { increment: ONE_OBSERVATION_MILLI } }
              : { betaMilli: { increment: ONE_OBSERVATION_MILLI } }),
            observationCount: { increment: 1 },
            lastUpdatedAt: evaluatedAt,
          },
        });

        await appendAuditEntry(tx, {
          merchantId: intervention.merchantId,
          actorType: "SYSTEM",
          entityType: "PlaybookStat",
          entityId: stat.id,
          action: "PLAYBOOK_STAT_INCREMENTED",
          before: { alphaMilli: stat.alphaMilli, betaMilli: stat.betaMilli, observationCount: stat.observationCount },
          after: {
            outcome: options.outcome,
            playbookKey: intervention.playbook.key,
            failureReason,
            alphaMilli: options.outcome === "CONVERTED" ? stat.alphaMilli + ONE_OBSERVATION_MILLI : stat.alphaMilli,
            betaMilli: options.outcome === "NOT_CONVERTED" ? stat.betaMilli + ONE_OBSERVATION_MILLI : stat.betaMilli,
          },
        });
      }
    },
  });
}

/**
 * Close out interventions whose attribution window has passed without a
 * qualifying payment.
 *
 * A non-conversion is evidence too: without it the priors would only ever move
 * upward, and the agent would grow more confident the more it was ignored.
 */
export async function closeLapsedObservations(
  merchantId: string,
  options: { evaluatedAt?: Date; windowDays: number; client?: PrismaClient },
): Promise<{ closed: number }> {
  const db = options.client ?? prisma;
  const evaluatedAt = options.evaluatedAt ?? new Date();
  const cutoff = new Date(evaluatedAt.getTime() - options.windowDays * 86_400_000);

  const lapsed = await db.intervention.findMany({
    where: {
      merchantId, state: "OBSERVING", executedAt: { lt: cutoff },
      attributionRecords: { none: {} },
    },
    select: { id: true, version: true },
  });

  for (const intervention of lapsed) {
    const notConverted = await transitionIntervention(intervention.id, {
      to: "NOT_CONVERTED", expectedVersion: intervention.version,
      actorType: "SYSTEM", action: "INTERVENTION_NOT_CONVERTED",
      metadata: { windowDays: options.windowDays, reason: "Attribution window elapsed with no qualifying payment." },
      data: { closedAt: evaluatedAt }, evaluatedAt, client: db,
    });
    await learnFromOutcome(intervention.id, {
      // No payment arrived for any cohort, so every one of them is evidence
      // against the playbook for its failure reason.
      outcome: "NOT_CONVERTED", expectedVersion: notConverted.version, evaluatedAt, client: db,
    });
  }

  return { closed: lapsed.length };
}
