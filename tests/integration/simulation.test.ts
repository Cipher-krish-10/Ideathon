import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { FakePaymentProvider } from "@/integrations/razorpay";
import { approveIntervention, submitForApproval } from "@/server/services/approval.service";
import { executeIntervention } from "@/server/services/execution.service";
import { getDashboardMetrics } from "@/server/services/read.service";
import { simulatePaymentForArtifact } from "@/server/services/simulation.service";
import {
  advanceSimulationTime, getActivityFeed, getSimulationState,
  resetDemoState, resetSimulationClock,
} from "@/server/services/simulation";
import {
  DEFAULT_TEST_POLICY_RULES, buildInterventionFixture, createScratchMerchant,
  createTestClient, purgeMerchant,
} from "../helpers/db";

/**
 * The demo simulation layer.
 *
 * It is presentation and orchestration only: these tests exist mostly to prove
 * it cannot reach past the real pipeline.
 */
describe("simulation layer", () => {
  let prisma: PrismaClient;
  const scratchIds: string[] = [];
  const MIDDAY = new Date("2026-09-06T08:30:00Z");

  beforeAll(() => { prisma = createTestClient(); });
  afterEach(async () => {
    while (scratchIds.length > 0) await purgeMerchant(prisma, scratchIds.pop()!);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  async function merchantWithIntervention() {
    const merchant = await createScratchMerchant(prisma, "sim");
    scratchIds.push(merchant.id);
    const fixture = await buildInterventionFixture(prisma, merchant.id);
    await prisma.intervention.update({
      where: { id: fixture.intervention.id }, data: { state: "PROPOSED" },
    });
    await prisma.guardrailPolicy.updateMany({
      where: { merchantId: merchant.id, version: 1 },
      data: { rules: { ...DEFAULT_TEST_POLICY_RULES } },
    });
    await prisma.interventionTarget.create({
      data: {
        interventionId: fixture.intervention.id, customerId: fixture.customer.id,
        transactionId: fixture.transaction.id, amountPaise: 250_000,
        perTargetRef: `rp_${Math.random().toString(36).slice(2, 12)}`,
      },
    });
    await prisma.playbookStat.create({
      data: {
        merchantId: merchant.id, playbookId: fixture.playbook.id,
        failureReason: "INSUFFICIENT_FUNDS", tierScope: "ALL",
        alphaMilli: 10_000, betaMilli: 30_000,
        seededAlphaMilli: 10_000, seededBetaMilli: 30_000, observationCount: 0,
      },
    });
    return { merchant, fixture };
  }

  async function executeFully(merchantId: string, fixture: Awaited<ReturnType<typeof buildInterventionFixture>>) {
    const submitted = await submitForApproval(fixture.intervention.id, { client: prisma, evaluatedAt: MIDDAY });
    const approved = await approveIntervention(fixture.intervention.id, {
      userId: fixture.user.id, expectedVersion: submitted.version, client: prisma, evaluatedAt: MIDDAY,
    });
    const executed = await executeIntervention(fixture.intervention.id, {
      userId: fixture.user.id,
      expectedVersion: approved.status === "APPROVED" ? approved.version : 0,
      provider: new FakePaymentProvider(), client: prisma, evaluatedAt: MIDDAY,
    });
    expect(executed.status).toBe("EXECUTED");
    return prisma.razorpayArtifact.findFirstOrThrow({ where: { merchantId } });
  }

  describe("clock", () => {
    it("starts deterministically at the end of the historical baseline", async () => {
      const merchant = await createScratchMerchant(prisma, "clock");
      scratchIds.push(merchant.id);

      const state = await getSimulationState(merchant.id, prisma);
      // Not the system clock: the instant the merchant's history stops.
      expect(state.simulatedNow.toISOString()).toBe(merchant.datasetReferenceAt.toISOString());
      expect(state.baselineAt.toISOString()).toBe(merchant.datasetReferenceAt.toISOString());
      expect(state.status).toBe("IDLE");
      expect(state.advancedMinutes).toBe(0);

      // Reading it twice gives the same answer.
      const again = await getSimulationState(merchant.id, prisma);
      expect(again.simulatedNow.toISOString()).toBe(state.simulatedNow.toISOString());
    });

    it("advances forward and accumulates", async () => {
      const merchant = await createScratchMerchant(prisma, "advance");
      scratchIds.push(merchant.id);
      const start = (await getSimulationState(merchant.id, prisma)).simulatedNow;

      await advanceSimulationTime(merchant.id, 1, prisma);
      const after = await advanceSimulationTime(merchant.id, 5, prisma);

      expect(after.simulatedNow.getTime()).toBe(start.getTime() + 6 * 60_000);
      expect(after.advancedMinutes).toBe(6);
    });

    it("refuses to move backwards or by an absurd amount", async () => {
      const merchant = await createScratchMerchant(prisma, "guard");
      scratchIds.push(merchant.id);
      for (const minutes of [0, -5, 10_000, 1.5]) {
        await expect(advanceSimulationTime(merchant.id, minutes, prisma)).rejects.toThrow();
      }
    });

    it("returns to baseline on reset", async () => {
      const merchant = await createScratchMerchant(prisma, "clockreset");
      scratchIds.push(merchant.id);
      await advanceSimulationTime(merchant.id, 30, prisma);

      const reset = await resetSimulationClock(merchant.id, prisma);
      expect(reset.simulatedNow.toISOString()).toBe(merchant.datasetReferenceAt.toISOString());
      expect(reset.advancedMinutes).toBe(0);
      expect(reset.status).toBe("IDLE");
    });

    it("is never read by the financial pipeline", async () => {
      // Advancing the clock must not change a detector, estimator, guardrail or
      // attribution outcome. If it could, demo results would depend on clicks.
      const { merchant, fixture } = await merchantWithIntervention();
      await advanceSimulationTime(merchant.id, 600, prisma);

      const submitted = await submitForApproval(fixture.intervention.id, {
        client: prisma, evaluatedAt: MIDDAY,
      });
      expect(submitted.state).toBe("PENDING_APPROVAL");
      expect(submitted.evaluation.blocked).toBe(false);
    });
  });

  describe("activity feed", () => {
    it("is derived from real audit entries, newest last", async () => {
      const { merchant, fixture } = await merchantWithIntervention();
      await executeFully(merchant.id, fixture);

      const feed = await getActivityFeed(merchant.id, { client: prisma });
      expect(feed.length).toBeGreaterThan(3);

      const labels = feed.map((entry) => entry.label);
      expect(labels).toContain("Merchant approved the intervention");
      expect(labels).toContain("Razorpay Test Mode payment links created");

      // Ordered oldest first, so it reads like a transcript.
      const seqs = feed.map((entry) => entry.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

      // Every entry corresponds to a real audit row.
      const auditCount = await prisma.auditLog.count({ where: { merchantId: merchant.id } });
      expect(feed.length).toBeLessThanOrEqual(auditCount);
    });

    it("is empty before the agent has done anything", async () => {
      const merchant = await createScratchMerchant(prisma, "emptyfeed");
      scratchIds.push(merchant.id);
      expect(await getActivityFeed(merchant.id, { client: prisma })).toHaveLength(0);
    });

    it("labels simulated payment events as simulated", async () => {
      const { merchant, fixture } = await merchantWithIntervention();
      const artifact = await executeFully(merchant.id, fixture);
      await simulatePaymentForArtifact(artifact.id, { client: prisma });

      const feed = await getActivityFeed(merchant.id, { client: prisma });
      const webhookEntry = feed.find((entry) => entry.label.includes("webhook received"));
      expect(webhookEntry?.simulated).toBe(true);
    });

    it("surfaces real figures from the audited payload", async () => {
      const { merchant, fixture } = await merchantWithIntervention();
      const artifact = await executeFully(merchant.id, fixture);
      await simulatePaymentForArtifact(artifact.id, { client: prisma });

      const feed = await getActivityFeed(merchant.id, { client: prisma });
      const attribution = feed.find((entry) => entry.label === "Attribution confirmed");
      expect(attribution?.detail).toContain("DIRECT_REF");
      expect(attribution?.detail).toContain("HIGH");
    });
  });

  describe("reset", () => {
    it("clears agent output and restores the baseline", async () => {
      const { merchant, fixture } = await merchantWithIntervention();
      const artifact = await executeFully(merchant.id, fixture);
      await simulatePaymentForArtifact(artifact.id, { client: prisma });
      await advanceSimulationTime(merchant.id, 20, prisma);

      const before = await getDashboardMetrics(merchant.id);
      expect(before.recoveredAmountPaise).toBeGreaterThan(0);

      const summary = await resetDemoState(merchant.id, prisma);
      expect(summary.interventionsRemoved).toBeGreaterThan(0);

      // Nothing the agent produced survives.
      const where = { merchantId: merchant.id };
      expect(await prisma.intervention.count({ where })).toBe(0);
      expect(await prisma.opportunity.count({ where })).toBe(0);
      expect(await prisma.attributionRecord.count({ where })).toBe(0);
      expect(await prisma.webhookEvent.count({ where })).toBe(0);
      expect(await prisma.razorpayArtifact.count({ where })).toBe(0);
      expect(await prisma.auditLog.count({ where })).toBe(0);
      expect(await getActivityFeed(merchant.id, { client: prisma })).toHaveLength(0);

      const after = await getDashboardMetrics(merchant.id);
      expect(after.recoveredAmountPaise).toBe(0);
      expect(after.executedInterventions).toBe(0);

      // The clock is back at the baseline.
      const clock = await getSimulationState(merchant.id, prisma);
      expect(clock.simulatedNow.toISOString()).toBe(merchant.datasetReferenceAt.toISOString());
    });

    it("restores learning counters to their seeded priors", async () => {
      const { merchant, fixture } = await merchantWithIntervention();
      const artifact = await executeFully(merchant.id, fixture);
      await simulatePaymentForArtifact(artifact.id, { client: prisma });

      const learned = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });
      expect(learned.alphaMilli).toBeGreaterThan(learned.seededAlphaMilli);

      await resetDemoState(merchant.id, prisma);

      const reset = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });
      expect(reset.alphaMilli).toBe(reset.seededAlphaMilli);
      expect(reset.betaMilli).toBe(reset.seededBetaMilli);
      expect(reset.observationCount).toBe(0);
    });

    it("never touches the merchant's historical records", async () => {
      const { merchant, fixture } = await merchantWithIntervention();
      const before = {
        customers: await prisma.customer.count({ where: { merchantId: merchant.id } }),
        products: await prisma.product.count({ where: { merchantId: merchant.id } }),
        transactions: await prisma.transaction.count({ where: { merchantId: merchant.id } }),
      };

      const artifact = await executeFully(merchant.id, fixture);
      await simulatePaymentForArtifact(artifact.id, { client: prisma });
      await resetDemoState(merchant.id, prisma);

      expect(await prisma.customer.count({ where: { merchantId: merchant.id } })).toBe(before.customers);
      expect(await prisma.product.count({ where: { merchantId: merchant.id } })).toBe(before.products);
      expect(await prisma.transaction.count({ where: { merchantId: merchant.id } })).toBe(before.transactions);

      // A recovered transaction is returned to its historical FAILED state.
      const transaction = await prisma.transaction.findUniqueOrThrow({
        where: { id: fixture.transaction.id },
      });
      expect(transaction.status).toBe("FAILED");
      expect(await prisma.paymentAttempt.count({
        where: { merchantId: merchant.id, sourceRef: { startsWith: "pa_recovered_" } },
      })).toBe(0);
    });

    it("restores guardrail policy v1 as active", async () => {
      const { merchant } = await merchantWithIntervention();
      await prisma.guardrailPolicy.updateMany({
        where: { merchantId: merchant.id }, data: { isActive: false },
      });
      await prisma.guardrailPolicy.create({
        data: {
          merchantId: merchant.id, version: 2, isActive: true,
          rules: { ...DEFAULT_TEST_POLICY_RULES } as unknown as object,
        },
      });

      await resetDemoState(merchant.id, prisma);

      const policies = await prisma.guardrailPolicy.findMany({ where: { merchantId: merchant.id } });
      expect(policies).toHaveLength(1);
      expect(policies[0]!.version).toBe(1);
      expect(policies[0]!.isActive).toBe(true);
    });
  });

  describe("demo boundaries", () => {
    it("cannot mark an intervention converted without attribution", async () => {
      // The simulator has no shortcut: break the reference and it must refuse.
      const { merchant, fixture } = await merchantWithIntervention();
      const artifact = await executeFully(merchant.id, fixture);
      await prisma.razorpayArtifact.update({
        where: { id: artifact.id }, data: { raw: { reference_id: "rp_unrelated" } },
      });

      const result = await simulatePaymentForArtifact(artifact.id, { client: prisma });
      expect(result.status).toBe("PROCESSED");
      if (result.status !== "PROCESSED") return;
      expect(result.attribution?.attributed).toBe(false);
      expect((await prisma.intervention.findUniqueOrThrow({
        where: { id: fixture.intervention.id },
      })).state).toBe("OBSERVING");
    });

    it("cannot increment learning directly", async () => {
      const { merchant, fixture } = await merchantWithIntervention();
      const artifact = await executeFully(merchant.id, fixture);
      const before = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });

      await prisma.razorpayArtifact.update({
        where: { id: artifact.id }, data: { raw: { reference_id: "rp_unrelated" } },
      });
      await simulatePaymentForArtifact(artifact.id, { client: prisma });

      // No attribution, so no learning.
      const after = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });
      expect(after.alphaMilli).toBe(before.alphaMilli);
      expect(after.observationCount).toBe(0);
    });

    it("keeps historical opportunity distinct from recovered revenue", async () => {
      const { merchant, fixture } = await merchantWithIntervention();
      const opportunityBefore = await prisma.opportunity.findUniqueOrThrow({
        where: { id: fixture.opportunity.id },
      });

      const artifact = await executeFully(merchant.id, fixture);
      await simulatePaymentForArtifact(artifact.id, { client: prisma });

      const metrics = await getDashboardMetrics(merchant.id);
      const opportunityAfter = await prisma.opportunity.findUniqueOrThrow({
        where: { id: fixture.opportunity.id },
      });

      // Potential is unchanged by a recovery: they are different concepts, and
      // one never overwrites the other. (Their VALUES may coincide in a
      // single-target fixture; what matters is the independent sourcing.)
      expect(opportunityAfter.recoverableAmountPaise).toBe(opportunityBefore.recoverableAmountPaise);
      expect(metrics.recoveredAmountPaise).toBeGreaterThan(0);

      // Recovered revenue is sourced solely from attribution records.
      const attributed = await prisma.attributionRecord.aggregate({
        where: { merchantId: merchant.id }, _sum: { attributedAmountPaise: true },
      });
      expect(metrics.recoveredAmountPaise).toBe(attributed._sum.attributedAmountPaise);
    });
  });
});
