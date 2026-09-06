import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { datasetSummarySchema } from "@/server/dataset/config";
import { createTestClient, getDemoMerchant } from "../helpers/db";

/**
 * The database must agree with the approved dataset's own summary. This is the
 * same baseline the Python validator checks, asserted from the other side.
 */
const summary = datasetSummarySchema.parse(
  JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "dataset_summary.json"), "utf8")),
);

describe("seed consistency with the approved dataset", () => {
  let prisma: PrismaClient;
  let merchantId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    merchantId = (await getDemoMerchant(prisma)).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("loads the exact row counts", async () => {
    const where = { merchantId };
    expect(await prisma.customer.count({ where })).toBe(summary.row_counts.customers);
    expect(await prisma.product.count({ where })).toBe(summary.row_counts.products);
    expect(await prisma.transaction.count({ where })).toBe(summary.row_counts.transactions);
    expect(await prisma.paymentAttempt.count({ where })).toBe(summary.row_counts.payment_attempts);
  });

  it("loads the exact failed/successful attempt split", async () => {
    expect(
      await prisma.paymentAttempt.count({ where: { merchantId, status: "FAILED" } }),
    ).toBe(summary.row_counts.failed_payment_attempts);
    expect(
      await prisma.paymentAttempt.count({ where: { merchantId, status: "SUCCESS" } }),
    ).toBe(summary.row_counts.successful_payment_attempts);
  });

  it("reproduces every money total exactly", async () => {
    const sumFor = async (status?: "CAPTURED" | "FAILED" | "REFUNDED") =>
      (
        await prisma.transaction.aggregate({
          where: status ? { merchantId, status } : { merchantId },
          _sum: { amountPaise: true },
        })
      )._sum.amountPaise ?? 0;

    expect(await sumFor()).toBe(summary.money_paise.total_transaction_value);
    expect(await sumFor("CAPTURED")).toBe(summary.money_paise.captured_revenue);
    expect(await sumFor("REFUNDED")).toBe(summary.money_paise.refunded_value);
    expect(await sumFor("FAILED")).toBe(summary.money_paise.failed_payment_value);
  });

  it("reproduces the transaction status distribution", async () => {
    const rows = await prisma.transaction.groupBy({
      by: ["status"], where: { merchantId }, _count: { _all: true },
    });
    for (const [status, expected] of Object.entries(summary.transactions.status_distribution)) {
      expect(rows.find((r) => r.status === status)?._count._all ?? 0).toBe(expected);
    }
  });

  it("reproduces the customer tier distribution", async () => {
    const rows = await prisma.customer.groupBy({
      by: ["tier"], where: { merchantId }, _count: { _all: true },
    });
    for (const [tier, expected] of Object.entries(summary.customers.tier_distribution)) {
      expect(rows.find((r) => r.tier === tier)?._count._all ?? 0).toBe(expected);
    }
  });

  it("distinguishes active from expired suppression using the dataset reference date", async () => {
    // Suppression is a date, not a flag. A detector that merely checked for
    // presence would wrongly exclude the 9 expired rows.
    const merchant = await getDemoMerchant(prisma);
    const referenceAt = merchant.datasetReferenceAt;

    expect(
      await prisma.customer.count({ where: { merchantId, doNotContactUntil: { gt: referenceAt } } }),
    ).toBe(summary.customers.actively_suppressed);
    expect(
      await prisma.customer.count({ where: { merchantId, doNotContactUntil: { lte: referenceAt } } }),
    ).toBe(summary.customers.expired_suppression);
  });

  it("seeds configuration from merchant_config.json", async () => {
    expect(await prisma.playbook.count({ where: { merchantId } })).toBe(3);
    expect(await prisma.playbookStat.count({ where: { merchantId } })).toBe(15);

    // The seed creates version 1 with all ten rules. Later versions are
    // legitimate — a merchant editing policy is the point of the Policies page —
    // so the invariant is that v1 exists and exactly one version is active.
    const policies = await prisma.guardrailPolicy.findMany({ where: { merchantId } });
    const v1 = policies.find((policy) => policy.version === 1);
    expect(v1).toBeDefined();
    expect(Object.keys(v1?.rules as Record<string, unknown>)).toHaveLength(10);
    expect(policies.filter((policy) => policy.isActive)).toHaveLength(1);

    const users = await prisma.user.findMany({ where: { merchantId } });
    expect(users.map((u) => u.role).sort()).toEqual(["ADMIN", "APPROVER"]);
  });

  it("seeds priors unmodified, so learned movement stays visible", async () => {
    const stats = await prisma.playbookStat.findMany({ where: { merchantId } });
    expect(stats).toHaveLength(15);
    for (const stat of stats) {
      expect(stat.alphaMilli).toBe(stat.seededAlphaMilli);
      expect(stat.betaMilli).toBe(stat.seededBetaMilli);
      expect(stat.observationCount).toBe(0);
    }
  });

  it("holds source of truth only — the seed derives nothing", async () => {
    const where = { merchantId };

    // Opportunities are legitimately created by a detector run, so the
    // assertion is about PROVENANCE, not emptiness: nothing derived may exist
    // that a detector cannot account for. A seed-created opportunity would
    // carry no detector stamp.
    const opportunities = await prisma.opportunity.findMany({ where });
    for (const opportunity of opportunities) {
      expect(opportunity.detectorKey).toBeTruthy();
      expect(opportunity.detectorVersion).toBeTruthy();
    }

    // Estimates come from the estimator, so provenance again: every row must
    // name the version that scored it.
    const estimates = await prisma.estimate.findMany({ where });
    for (const estimate of estimates) {
      expect(estimate.estimatorVersion).toBeTruthy();
      expect(estimate.expectedNetPaise).toBe(
        estimate.expectedGrossPaise - estimate.costPaise,
      );
    }

    // Interventions come from the reasoner and may legitimately have been
    // approved and executed by a demo run. What must NOT exist is an outcome
    // state: those require a real payment event, which no phase can yet produce.
    const interventions = await prisma.intervention.findMany({ where });
    for (const intervention of interventions) {
      expect(intervention.reasoningMode).toBeTruthy();
      expect(["CONVERTED", "NOT_CONVERTED", "LEARNED"]).not.toContain(intervention.state);
      // Any intervention past the gate must have a recorded approval.
      if (["APPROVED", "EXECUTING", "EXECUTED", "OBSERVING"].includes(intervention.state)) {
        const approval = await prisma.approval.findUnique({
          where: { interventionId: intervention.id },
        });
        expect(approval?.decision).toBe("APPROVED");
      }
    }

    // Recovered revenue is realised money only. Nothing before the attribution
    // phase may write one of these.
    expect(await prisma.attributionRecord.count({ where })).toBe(0);
    expect(await prisma.approval.count({ where })).toBe(0);
    expect(await prisma.executionAttempt.count({ where })).toBe(0);
    expect(await prisma.attributionRecord.count({ where })).toBe(0);
  });

  it("preserves every dataset source ref for traceability", async () => {
    expect(
      await prisma.customer.count({ where: { merchantId, sourceRef: { startsWith: "cust_" } } }),
    ).toBe(summary.row_counts.customers);
    expect(
      await prisma.transaction.count({ where: { merchantId, sourceRef: { startsWith: "txn_" } } }),
    ).toBe(summary.row_counts.transactions);
    expect(
      await prisma.paymentAttempt.count({ where: { merchantId, sourceRef: { startsWith: "pa_" } } }),
    ).toBe(summary.row_counts.payment_attempts);
  });
});
