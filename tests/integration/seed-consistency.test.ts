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

    const policy = await prisma.guardrailPolicy.findFirst({ where: { merchantId, version: 1 } });
    expect(policy).not.toBeNull();
    expect(policy?.isActive).toBe(true);
    expect(Object.keys(policy?.rules as Record<string, unknown>)).toHaveLength(10);

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

  it("holds source of truth only — nothing derived is seeded", async () => {
    // If any of these are non-zero, the seed has started doing the detector's job.
    const where = { merchantId };
    expect(await prisma.opportunity.count({ where })).toBe(0);
    expect(await prisma.estimate.count({ where })).toBe(0);
    expect(await prisma.intervention.count({ where })).toBe(0);
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
