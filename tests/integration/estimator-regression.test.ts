import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ESTIMATOR_VERSION } from "@/core/estimator";
import type { PrismaClient } from "@/generated/prisma/client";
import { buildEstimatorConfig } from "@/server/config/estimator-config";
import { loadMerchantConfig } from "@/server/dataset/config";
import { runEstimatorForOpportunity } from "@/server/services/estimator.service";
import { runFailedPaymentRecoveryDetector } from "@/server/services/failed-payment-recovery.service";
import { createTestClient, getDemoMerchant } from "../helpers/db";

/**
 * Estimator regression against the real seeded database.
 *
 * Runs the actual detector, then scores its actual output. Assertions are about
 * INTERNAL CONSISTENCY and INVARIANTS rather than specific business outcomes —
 * "playbook X must win" is not a property of a correct estimator, and asserting
 * it would freeze a calibration choice into the test suite.
 */
describe("estimator regression against the seeded dataset", () => {
  let prisma: PrismaClient;
  let merchantId: string;
  let opportunityId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    merchantId = (await getDemoMerchant(prisma)).id;

    const detection = await runFailedPaymentRecoveryDetector(merchantId, {
      client: prisma,
      diagnostics: false,
    });
    opportunityId = detection.opportunityId!;
    expect(detection.detection.candidates).toHaveLength(26);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const score = () =>
    runEstimatorForOpportunity(opportunityId, { client: prisma, dryRun: true });

  it("scores all 26 qualifying targets", async () => {
    const result = await score();
    expect(result.targetCount).toBe(26);
    for (const candidate of result.candidates) {
      expect(candidate.inputsSnapshot.targets).toHaveLength(26);
      expect(candidate.inputsSnapshot.targetCount).toBe(26);
    }
  });

  it("evaluates every configured playbook", async () => {
    const config = loadMerchantConfig();
    const result = await score();
    expect(result.candidates).toHaveLength(config.playbooks.length);
    expect(result.candidates.map((c) => c.playbookKey).sort()).toEqual(
      config.playbooks.map((p) => p.key).sort(),
    );
  });

  it("totals the target amounts to the detector's recoverable value", async () => {
    // The estimator must be scoring exactly what the detector found: nothing
    // added, nothing dropped.
    const result = await score();
    for (const candidate of result.candidates) {
      expect(candidate.inputsSnapshot.totalTargetAmountPaise).toBe(51_427_400);
    }
  });

  it("populates every expected field", async () => {
    const result = await score();
    for (const candidate of result.candidates) {
      expect(candidate.opportunityId).toBe(opportunityId);
      expect(candidate.playbookId).toBeTruthy();
      expect(candidate.playbookKey).toBeTruthy();
      expect(candidate.estimatorVersion).toBe(ESTIMATOR_VERSION);
      expect(["LOW", "MEDIUM", "HIGH"]).toContain(candidate.confidence);
      expect(candidate.inputsSnapshot.playbookName).toBeTruthy();
      expect(candidate.inputsSnapshot.gatewayFeeBps).toBe(200);
      expect(candidate.inputsSnapshot.confidenceInputs.resolved).toBe(candidate.confidence);
    }
  });

  it("contains no invalid or negative money", async () => {
    const result = await score();
    for (const candidate of result.candidates) {
      expect(candidate.expectedGrossPaise).toBeGreaterThan(0);
      expect(candidate.discountCostPaise).toBeGreaterThanOrEqual(0);
      expect(candidate.channelCostPaise).toBeGreaterThanOrEqual(0);
      expect(candidate.gatewayFeePaise).toBeGreaterThanOrEqual(0);
      expect(candidate.costPaise).toBeGreaterThanOrEqual(0);
      for (const value of [
        candidate.expectedGrossPaise, candidate.discountCostPaise,
        candidate.channelCostPaise, candidate.gatewayFeePaise,
        candidate.costPaise, candidate.expectedNetPaise, candidate.pRecoverAvgBps,
      ]) {
        expect(Number.isInteger(value)).toBe(true);
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(candidate.pRecoverAvgBps).toBeGreaterThanOrEqual(0);
      expect(candidate.pRecoverAvgBps).toBeLessThanOrEqual(10_000);
    }
  });

  it("keeps the arithmetic internally consistent", async () => {
    const result = await score();
    for (const candidate of result.candidates) {
      // These are also database CHECK constraints; asserting them here catches
      // a drift before it becomes a write failure.
      expect(candidate.costPaise).toBe(
        candidate.discountCostPaise + candidate.channelCostPaise + candidate.gatewayFeePaise,
      );
      expect(candidate.expectedNetPaise).toBe(
        candidate.expectedGrossPaise - candidate.costPaise,
      );

      // Aggregates equal the sum of their per-target parts.
      const targets = candidate.inputsSnapshot.targets;
      expect(targets.reduce((n, t) => n + t.expectedGrossPaise, 0)).toBe(
        candidate.expectedGrossPaise,
      );
      expect(targets.reduce((n, t) => n + t.discountCostPaise, 0)).toBe(
        candidate.discountCostPaise,
      );
      expect(targets.reduce((n, t) => n + t.gatewayFeePaise, 0)).toBe(
        candidate.gatewayFeePaise,
      );
      expect(candidate.channelCostPaise).toBe(
        candidate.inputsSnapshot.channelCostPaisePerTarget * 26,
      );
    }
  });

  it("makes every probability traceable to its inputs", async () => {
    const result = await score();
    const config = buildEstimatorConfig(loadMerchantConfig());

    for (const candidate of result.candidates) {
      for (const target of candidate.inputsSnapshot.targets) {
        // Each factor is recorded, and their product is the stated probability.
        expect(target.baseRateBps).toBeGreaterThan(0);
        expect(target.recencyModifierBps).toBeGreaterThan(0);
        expect(target.tierModifierBps).toBeGreaterThan(0);
        expect(target.incentiveModifierBps).toBeGreaterThan(0);

        const expected = Math.round(
          (target.baseRateBps * target.recencyModifierBps * target.tierModifierBps *
            target.incentiveModifierBps) / 1_000_000_000_000,
        );
        expect(target.pRecoverBps).toBe(Math.min(expected, 10_000));

        expect(target.priorFound).toBe(true);
        expect(target.priorSampleSize).toBe(40);
        expect(target.tierModifierBps).toBe(
          config.tierModifiersBps[target.customerTier],
        );
      }
    }
  });

  it("resolves MEDIUM confidence — seeded priors, no real outcomes yet", async () => {
    const result = await score();
    for (const candidate of result.candidates) {
      expect(candidate.confidence).toBe("MEDIUM");
      expect(candidate.inputsSnapshot.confidenceInputs.totalRealObservations).toBe(0);
      expect(candidate.inputsSnapshot.confidenceInputs.dataCompletenessBps).toBe(10_000);
    }
  });

  it("charges a discount only on the offer playbook", async () => {
    const result = await score();
    for (const candidate of result.candidates) {
      if (candidate.inputsSnapshot.discountBps === 0) {
        expect(candidate.discountCostPaise).toBe(0);
      } else {
        expect(candidate.discountCostPaise).toBeGreaterThan(0);
      }
    }
  });

  it("produces identical results on repeated runs", async () => {
    const [a, b] = [await score(), await score()];
    expect(JSON.stringify(a.candidates)).toBe(JSON.stringify(b.candidates));
  });

  it("does not choose a winner", async () => {
    const result = await score();
    for (const candidate of result.candidates) {
      for (const key of ["selected", "winner", "recommended", "rank", "chosen"]) {
        expect(candidate).not.toHaveProperty(key);
      }
    }
    // Alphabetical, so the array itself carries no ranking.
    const keys = result.candidates.map((c) => c.playbookKey);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("estimator persistence and idempotency", () => {
  let prisma: PrismaClient;
  let opportunityId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    const merchant = await getDemoMerchant(prisma);
    const detection = await runFailedPaymentRecoveryDetector(merchant.id, {
      client: prisma, diagnostics: false,
    });
    opportunityId = detection.opportunityId!;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists one Estimate per playbook", async () => {
    const result = await runEstimatorForOpportunity(opportunityId, { client: prisma });
    expect(Object.keys(result.estimateIdsByPlaybookKey)).toHaveLength(3);

    const rows = await prisma.estimate.findMany({
      where: { opportunityId, estimatorVersion: ESTIMATOR_VERSION },
      include: { playbook: { select: { key: true } } },
    });
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.estimatorVersion).toBe(ESTIMATOR_VERSION);
      expect(row.expectedNetPaise).toBe(row.expectedGrossPaise - row.costPaise);
      expect(row.costPaise).toBe(
        row.discountCostPaise + row.channelCostPaise + row.gatewayFeePaise,
      );
      const snapshot = row.inputsSnapshot as Record<string, unknown>;
      expect(snapshot.estimatorVersion).toBe(ESTIMATOR_VERSION);
      expect(snapshot).toHaveProperty("targets");
      expect(snapshot).toHaveProperty("config");
      expect(snapshot).toHaveProperty("confidenceInputs");
    }
  });

  it("is idempotent for the same opportunity and estimator version", async () => {
    const first = await runEstimatorForOpportunity(opportunityId, { client: prisma });
    const second = await runEstimatorForOpportunity(opportunityId, { client: prisma });

    expect(second.created).toBe(0);
    expect(second.reused).toBe(3);
    expect(second.estimateIdsByPlaybookKey).toEqual(first.estimateIdsByPlaybookKey);

    expect(
      await prisma.estimate.count({ where: { opportunityId, estimatorVersion: ESTIMATOR_VERSION } }),
    ).toBe(3);
  });

  it("refuses a duplicate estimate even under a direct write", async () => {
    // The idempotency key is a database index, not just a service-layer check.
    const existing = await prisma.estimate.findFirstOrThrow({ where: { opportunityId } });
    await expect(
      prisma.estimate.create({
        data: {
          merchantId: existing.merchantId,
          opportunityId: existing.opportunityId,
          playbookId: existing.playbookId,
          expectedGrossPaise: 1, discountCostPaise: 0, channelCostPaise: 0,
          gatewayFeePaise: 0, costPaise: 0, expectedNetPaise: 1,
          pRecoverAvgBps: 100, confidence: "LOW",
          inputsSnapshot: {}, estimatorVersion: existing.estimatorVersion,
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects an estimate whose arithmetic does not add up", async () => {
    const existing = await prisma.estimate.findFirstOrThrow({ where: { opportunityId } });
    await expect(
      prisma.estimate.create({
        data: {
          merchantId: existing.merchantId,
          opportunityId: existing.opportunityId,
          playbookId: existing.playbookId,
          expectedGrossPaise: 100_000, discountCostPaise: 0, channelCostPaise: 50,
          gatewayFeePaise: 1_950, costPaise: 2_000,
          expectedNetPaise: 99_999, // should be 98,000
          pRecoverAvgBps: 3_000, confidence: "MEDIUM",
          inputsSnapshot: {}, estimatorVersion: "arithmetic-check:v0",
        },
      }),
    ).rejects.toThrow();
  });
});
