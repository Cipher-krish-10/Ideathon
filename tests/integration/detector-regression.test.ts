import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DETECTOR_VERSION, detectFailedPaymentRecovery } from "@/core/detectors";
import type { PrismaClient } from "@/generated/prisma/client";
import { datasetSummarySchema, loadMerchantConfig } from "@/server/dataset/config";
import {
  toCustomerRecord,
  toDetectorConfig,
  toPaymentAttemptRecord,
  toTransactionRecord,
} from "@/server/services/detector-input";
import { runFailedPaymentRecoveryDetector } from "@/server/services/failed-payment-recovery.service";
import {
  createScratchMerchant,
  createTestClient,
  getDemoMerchant,
  purgeMerchant,
} from "../helpers/db";

/**
 * Regression against the real seeded dataset.
 *
 * These assertions run the DETECTOR over source records. They deliberately do
 * not count rows in an opportunity table: that would only prove the database
 * remembers what someone wrote, not that the detection logic still works.
 *
 * The expected figures come from data/dataset_summary.json, derived
 * independently by the Python validator. Two implementations, written in
 * different languages against the same evidence, must agree exactly.
 */
const summary = datasetSummarySchema.parse(
  JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "data", "dataset_summary.json"), "utf8"),
  ),
);
const expected = summary.derived_opportunity_view;

describe("detector regression against the seeded dataset", () => {
  let prisma: PrismaClient;
  let merchantId: string;
  let referenceAt: Date;

  beforeAll(async () => {
    prisma = createTestClient();
    const merchant = await getDemoMerchant(prisma);
    merchantId = merchant.id;
    referenceAt = merchant.datasetReferenceAt;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Read source records and run the pure detector over them. */
  async function detect() {
    const config = loadMerchantConfig();
    const [customers, transactions, paymentAttempts] = await Promise.all([
      prisma.customer.findMany({ where: { merchantId } }),
      prisma.transaction.findMany({ where: { merchantId } }),
      prisma.paymentAttempt.findMany({ where: { merchantId } }),
    ]);

    return detectFailedPaymentRecovery(
      {
        referenceAt,
        config: toDetectorConfig(config),
        customers: customers.map(toCustomerRecord),
        transactions: transactions.map(toTransactionRecord),
        paymentAttempts: paymentAttempts.map(toPaymentAttemptRecord),
      },
      { diagnostics: true },
    );
  }

  it("discovers exactly 26 qualifying candidates", async () => {
    const result = await detect();
    expect(result.candidates).toHaveLength(26);
    expect(result.aggregate.qualifyingTransactionCount).toBe(
      expected.qualifying_transactions,
    );
  });

  it("values them at exactly 51,427,400 paise (Rs 5,14,274)", async () => {
    const result = await detect();
    expect(result.aggregate.recoverableAmountPaise).toBe(51_427_400);
    expect(result.aggregate.recoverableAmountPaise).toBe(
      expected.recoverable_amount_paise,
    );
    // Integer paise, never a float.
    expect(Number.isInteger(result.aggregate.recoverableAmountPaise)).toBe(true);
  });

  it("counts affected CUSTOMERS, not attempts or transactions", async () => {
    const result = await detect();
    expect(result.aggregate.affectedCustomerCount).toBe(expected.distinct_customers);
    expect(new Set(result.candidates.map((c) => c.customerId)).size).toBe(
      result.aggregate.affectedCustomerCount,
    );
    // The candidates carry more failed attempts than there are candidates,
    // which is exactly why per-attempt counting would be wrong.
    const failedAttempts = result.candidates.reduce((n, c) => n + c.failedAttemptCount, 0);
    expect(failedAttempts).toBeGreaterThan(result.candidates.length);
  });

  it("reproduces the independently derived tier and failure-reason breakdowns", async () => {
    const result = await detect();
    expect(result.aggregate.tierBreakdown).toEqual(expected.by_tier);

    // dataset_summary uses the dataset's snake_case tokens; the database uses
    // the domain enum. Compare after normalising.
    const normalised = Object.fromEntries(
      Object.entries(result.aggregate.failureReasonBreakdown).map(([reason, count]) => [
        reason.toLowerCase(),
        count,
      ]),
    );
    expect(normalised).toEqual(expected.by_failure_reason);
  });

  it("rejects the other failed transactions across every exclusion category", async () => {
    const result = await detect();

    // 66 unpaid transactions exist; only 26 qualify. The detector must reject
    // 40 of them, for five distinct reasons.
    expect(result.scan.unpaidTransactions).toBe(66);
    expect(result.scan.transactionsScanned).toBe(1200);
    expect(result.scan.paymentAttemptsScanned).toBe(1223);
    expect(result.scan.orphanedPaymentAttempts).toBe(0);

    expect(result.exclusionCounts).toEqual({
      ALREADY_RECOVERED: 1134,
      NON_RECOVERABLE_FAILURE: 12,
      OUTSIDE_RECENCY_WINDOW: 10,
      BELOW_TICKET_FLOOR: 6,
      BELOW_LTV_FLOOR: 6,
      SUPPRESSED: 6,
      NO_FAILED_ATTEMPTS: 0,
      INCOMPLETE_EVIDENCE: 0,
    });

    const unpaidExcluded =
      result.exclusionCounts.NON_RECOVERABLE_FAILURE +
      result.exclusionCounts.OUTSIDE_RECENCY_WINDOW +
      result.exclusionCounts.BELOW_TICKET_FLOOR +
      result.exclusionCounts.BELOW_LTV_FLOOR +
      result.exclusionCounts.SUPPRESSED;
    expect(unpaidExcluded + result.candidates.length).toBe(66);
  });

  it("keeps repeated-failure transactions as single candidates", async () => {
    const result = await detect();
    const repeated = result.candidates.filter((c) => c.failedAttemptCount > 1);
    expect(repeated.length).toBeGreaterThanOrEqual(5);
    for (const candidate of repeated) {
      // The operative attempt is always the last one in the chain.
      expect(candidate.operativeAttemptRef).toBeTruthy();
      expect(candidate.failedAttemptCount).toBe(candidate.totalAttemptCount);
    }
    // Distinct transactions, so no transaction was counted twice.
    expect(new Set(result.candidates.map((c) => c.transactionId)).size).toBe(26);
  });

  it("produces byte-identical output on repeated runs", async () => {
    const [a, b] = await Promise.all([detect(), detect()]);
    expect(JSON.stringify(a.candidates)).toBe(JSON.stringify(b.candidates));
    expect(a.aggregate).toEqual(b.aggregate);
  });

  it("emits no projection on any candidate", async () => {
    const result = await detect();
    for (const candidate of result.candidates) {
      for (const key of [
        "expectedGrossPaise", "expectedNetPaise", "pRecover", "probability",
        "roi", "recommendedPlaybook", "rationale", "discountCostPaise",
      ]) {
        expect(candidate).not.toHaveProperty(key);
      }
    }
  });
});

describe("detector service: persistence and idempotency", () => {
  let prisma: PrismaClient;
  let scratchMerchantId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    const merchant = await createScratchMerchant(prisma, "detector");
    scratchMerchantId = merchant.id;
    await seedSmallFixture(prisma, scratchMerchantId);
  });

  afterAll(async () => {
    await purgeMerchant(prisma, scratchMerchantId);
    await prisma.$disconnect();
  });

  it("dry run writes nothing", async () => {
    const result = await runFailedPaymentRecoveryDetector(scratchMerchantId, {
      dryRun: true,
      client: prisma,
    });
    expect(result.detection.candidates).toHaveLength(2);
    expect(result.opportunityId).toBeNull();
    expect(
      await prisma.opportunity.count({ where: { merchantId: scratchMerchantId } }),
    ).toBe(0);
  });

  it("persists one Opportunity with its targets", async () => {
    const result = await runFailedPaymentRecoveryDetector(scratchMerchantId, {
      client: prisma,
    });
    expect(result.created).toBe(true);
    expect(result.targetsWritten).toBe(2);

    const opportunity = await prisma.opportunity.findUniqueOrThrow({
      where: { id: result.opportunityId! },
      include: { targets: true },
    });
    expect(opportunity.detectorVersion).toBe(DETECTOR_VERSION);
    expect(opportunity.detectorKey).toBe("FAILED_PAYMENT_RECOVERY");
    expect(opportunity.affectedCustomerCount).toBe(2);
    expect(opportunity.recoverableAmountPaise).toBe(1_000_000 + 800_000);
    expect(opportunity.targets).toHaveLength(2);

    // Each target names the specific failed attempt the decision rests on.
    for (const target of opportunity.targets) {
      expect(target.paymentAttemptId).toBeTruthy();
      expect(target.recoverableAmountPaise).toBeGreaterThan(0);
    }

    // Evidence records what was rejected, not just what was found.
    const evidence = opportunity.evidence as Record<string, unknown>;
    expect(evidence.detectorVersion).toBe(DETECTOR_VERSION);
    expect(evidence).toHaveProperty("exclusionCounts");
    expect(evidence).toHaveProperty("failureReasonBreakdown");
  });

  it("is idempotent for the same merchant, version, and reference date", async () => {
    const first = await runFailedPaymentRecoveryDetector(scratchMerchantId, {
      client: prisma,
    });
    const second = await runFailedPaymentRecoveryDetector(scratchMerchantId, {
      client: prisma,
    });

    expect(second.created).toBe(false);
    expect(second.opportunityId).toBe(first.opportunityId);

    expect(
      await prisma.opportunity.count({ where: { merchantId: scratchMerchantId } }),
    ).toBe(1);
    expect(
      await prisma.opportunityTarget.count({
        where: { opportunityId: first.opportunityId! },
      }),
    ).toBe(2);
  });

  it("treats a different reference date as a distinct run", async () => {
    const otherReference = new Date("2026-08-01T23:59:59+05:30");
    const result = await runFailedPaymentRecoveryDetector(scratchMerchantId, {
      referenceAt: otherReference,
      client: prisma,
    });
    expect(result.created).toBe(true);
    expect(
      await prisma.opportunity.count({ where: { merchantId: scratchMerchantId } }),
    ).toBe(2);
  });

  it("refuses to duplicate an opportunity even under a direct write", async () => {
    // The uniqueness key is a database index, not just a service-layer check.
    const existing = await prisma.opportunity.findFirstOrThrow({
      where: { merchantId: scratchMerchantId },
    });
    await expect(
      prisma.opportunity.create({
        data: {
          merchantId: scratchMerchantId,
          type: "FAILED_PAYMENT_RECOVERY",
          detectorKey: existing.detectorKey,
          detectorVersion: existing.detectorVersion,
          affectedCustomerCount: 0,
          recoverableAmountPaise: 0,
          evidence: {},
          referenceAt: existing.referenceAt,
        },
      }),
    ).rejects.toThrow();
  });
});

/**
 * Two qualifying transactions and one that must be excluded, so persistence is
 * tested against a result that required discrimination.
 */
async function seedSmallFixture(prisma: PrismaClient, merchantId: string) {
  const reference = new Date("2026-09-01T23:59:59+05:30");
  const daysAgo = (n: number) => new Date(reference.getTime() - n * 86_400_000);

  const product = await prisma.product.create({
    data: {
      merchantId, sourceRef: "prod_001", name: "Plan",
      category: "SUBSCRIPTION", pricePaise: 100_000,
    },
  });

  const specs = [
    { ref: "a", amount: 1_000_000, ltv: 5_000_000, reason: "EXPIRED_CARD" as const, qualifies: true },
    { ref: "b", amount: 800_000, ltv: 3_000_000, reason: "INSUFFICIENT_FUNDS" as const, qualifies: true },
    { ref: "c", amount: 900_000, ltv: 4_000_000, reason: "SUSPECTED_FRAUD" as const, qualifies: false },
  ];

  for (const [index, spec] of specs.entries()) {
    const customer = await prisma.customer.create({
      data: {
        merchantId, sourceRef: `cust_00${index}`, externalRef: `EXT-${index}`,
        maskedEmail: "te****@test.local", maskedPhone: "+91*****0000", city: "Pune",
        signupAt: daysAgo(400), historicalValuePaise: spec.ltv,
        lifetimeValuePaise: spec.ltv, tier: "HIGH",
      },
    });
    const transaction = await prisma.transaction.create({
      data: {
        merchantId, customerId: customer.id, productId: product.id,
        sourceRef: `txn_00${index}`, quantity: 1, amountPaise: spec.amount,
        status: "FAILED", method: "CARD", attemptCount: 1,
        occurredAt: daysAgo(5), settledAt: daysAgo(5),
      },
    });
    await prisma.paymentAttempt.create({
      data: {
        merchantId, transactionId: transaction.id, customerId: customer.id,
        sourceRef: `pa_00${index}`, amountPaise: spec.amount, status: "FAILED",
        failureReason: spec.reason, method: "CARD", attemptNo: 1,
        occurredAt: daysAgo(5),
      },
    });
  }
}
