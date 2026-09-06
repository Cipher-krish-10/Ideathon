import "server-only";

import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";
import { resetSimulationClock } from "./clock.service";

/**
 * Reset the demo to its deterministic baseline.
 *
 * WHAT IT REMOVES — everything the agent produced during a session:
 *   opportunities and their targets · estimates · interventions and targets ·
 *   guardrail evaluations · approvals · execution attempts · payment link
 *   artifacts · webhook events · attribution records · LLM call records ·
 *   the audit log · policy versions above v1
 *
 * WHAT IT RESTORES:
 *   PlaybookStat counters back to their seeded priors · guardrail policy v1 as
 *   the active version · the simulation clock to the baseline instant
 *
 * WHAT IT NEVER TOUCHES:
 *   Customer, Product, Transaction, PaymentAttempt — the merchant's historical
 *   record — and nothing at all in data/*.csv. The source dataset is immutable;
 *   a reset that could alter it would make every later run unreproducible.
 *
 * Recovering payments mutate Transaction.status, so the historical rows are
 * returned to their dataset state as part of the reset. `npm run db:seed`
 * remains the authoritative full rebuild.
 */
export interface ResetSummary {
  opportunitiesRemoved: number;
  interventionsRemoved: number;
  webhookEventsRemoved: number;
  attributionsRemoved: number;
  auditEntriesRemoved: number;
  playbookStatsRestored: number;
  policiesDeactivated: number;
  transactionsRestored: number;
  simulatedNow: string;
}

export async function resetDemoState(
  merchantId: string,
  client: PrismaClient = prisma,
): Promise<ResetSummary> {
  const summary = await client.$transaction(async (tx) => {
    // The audit log is append-only by trigger; a purge must opt in explicitly.
    // That friction is the design: teardown is possible, never accidental.
    await tx.$executeRawUnsafe("SET LOCAL revenuepilot.allow_audit_purge = 'on'");

    // Captured first: these name every transaction a recovery mutated.
    const recoveredTransactionIds = (
      await tx.attributionRecord.findMany({
        where: { merchantId }, select: { transactionId: true },
      })
    ).map((record) => record.transactionId);

    const attributions = await tx.attributionRecord.deleteMany({ where: { merchantId } });
    const webhooks = await tx.webhookEvent.deleteMany({ where: { merchantId } });
    await tx.llmCall.deleteMany({ where: { merchantId } });
    await tx.razorpayArtifact.deleteMany({ where: { merchantId } });
    await tx.executionAttempt.deleteMany({ where: { merchantId } });
    await tx.approval.deleteMany({ where: { merchantId } });
    await tx.guardrailEvaluation.deleteMany({ where: { merchantId } });
    const interventions = await tx.intervention.deleteMany({ where: { merchantId } });
    await tx.estimate.deleteMany({ where: { merchantId } });
    const opportunities = await tx.opportunity.deleteMany({ where: { merchantId } });
    const audit = await tx.auditLog.deleteMany({ where: { merchantId } });

    // A recovery marks its transaction CAPTURED and adds a success attempt.
    // Undo both, so the historical baseline is exactly what the dataset says.
    await tx.paymentAttempt.deleteMany({
      where: { merchantId, sourceRef: { startsWith: "pa_recovered_" } },
    });
    for (const transactionId of new Set(recoveredTransactionIds)) {
      const remaining = await tx.paymentAttempt.count({ where: { transactionId } });
      await tx.transaction.update({
        where: { id: transactionId },
        data: { status: "FAILED", attemptCount: remaining },
      });
    }

    // Priors back to what the seed wrote, so learning starts from zero again.
    const stats = await tx.playbookStat.findMany({ where: { merchantId } });
    for (const stat of stats) {
      await tx.playbookStat.update({
        where: { id: stat.id },
        data: {
          alphaMilli: stat.seededAlphaMilli,
          betaMilli: stat.seededBetaMilli,
          observationCount: 0,
          lastUpdatedAt: null,
        },
      });
    }

    // Policy versions created during the demo go; v1 becomes active again.
    const removedPolicies = await tx.guardrailPolicy.deleteMany({
      where: { merchantId, version: { gt: 1 } },
    });
    await tx.guardrailPolicy.updateMany({
      where: { merchantId, version: 1 }, data: { isActive: true },
    });

    return {
      opportunitiesRemoved: opportunities.count,
      interventionsRemoved: interventions.count,
      webhookEventsRemoved: webhooks.count,
      attributionsRemoved: attributions.count,
      auditEntriesRemoved: audit.count,
      playbookStatsRestored: stats.length,
      policiesDeactivated: removedPolicies.count,
      transactionsRestored: new Set(recoveredTransactionIds).size,
    };
  });

  const clock = await resetSimulationClock(merchantId, client);
  return { ...summary, simulatedNow: clock.simulatedNow.toISOString() };
}
