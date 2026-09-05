import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { createTestClient, createScratchMerchant, getDemoMerchant, purgeMerchant } from "../helpers/db";

/**
 * Payment attempts are the detector's primary evidence, so the relationship
 * between a transaction and its chain has to be exact, not approximately right.
 */
describe("transaction <-> payment attempt relationships", () => {
  let prisma: PrismaClient;
  let merchantId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    merchantId = (await getDemoMerchant(prisma)).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps attemptCount equal to the real chain length", async () => {
    const mismatched = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT t."id" FROM "transaction" t
        LEFT JOIN (SELECT "transactionId", COUNT(*) AS n FROM "payment_attempt" GROUP BY "transactionId") a
          ON a."transactionId" = t."id"
       WHERE COALESCE(a.n, 0) <> t."attemptCount"`;
    expect(mismatched).toHaveLength(0);
  });

  it("derives transaction status from the chain, never independently", async () => {
    const disagreeing = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT t."id" FROM "transaction" t
       WHERE (EXISTS (SELECT 1 FROM "payment_attempt" a
                       WHERE a."transactionId" = t."id" AND a."status" = 'SUCCESS')
              AND t."status" NOT IN ('CAPTURED', 'REFUNDED'))
          OR (NOT EXISTS (SELECT 1 FROM "payment_attempt" a
                           WHERE a."transactionId" = t."id" AND a."status" = 'SUCCESS')
              AND t."status" <> 'FAILED')`;
    expect(disagreeing).toHaveLength(0);
  });

  it("allows at most one SUCCESS, always terminal", async () => {
    const multiple = await prisma.$queryRaw<Array<{ transactionId: string }>>`
      SELECT "transactionId" FROM "payment_attempt" WHERE "status" = 'SUCCESS'
       GROUP BY "transactionId" HAVING COUNT(*) > 1`;
    expect(multiple).toHaveLength(0);

    const notTerminal = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s."id" FROM "payment_attempt" s
       WHERE s."status" = 'SUCCESS'
         AND EXISTS (SELECT 1 FROM "payment_attempt" l
                      WHERE l."transactionId" = s."transactionId" AND l."attemptNo" > s."attemptNo")`;
    expect(notTerminal).toHaveLength(0);
  });

  it("forms an unbroken retry chain in chronological order", async () => {
    const broken = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c."id" FROM "payment_attempt" c
        JOIN "payment_attempt" p ON p."id" = c."retryOfAttemptId"
       WHERE p."transactionId" <> c."transactionId"
          OR p."attemptNo" <> c."attemptNo" - 1
          OR c."occurredAt" < p."occurredAt"`;
    expect(broken).toHaveLength(0);
  });

  it("exposes the operative failure reason as the LAST failed attempt", async () => {
    // A chain that starts with insufficient_funds and ends with expired_card is
    // an expired-card problem. Verified on a real multi-attempt transaction.
    const multi = await prisma.transaction.findFirst({
      where: { merchantId, attemptCount: { gt: 2 }, status: "FAILED" },
      include: { paymentAttempts: { orderBy: { attemptNo: "asc" } } },
    });
    expect(multi).not.toBeNull();
    const chain = multi!.paymentAttempts;
    expect(chain.length).toBeGreaterThan(2);

    const operative = [...chain].reverse().find((a) => a.status === "FAILED");
    expect(operative?.attemptNo).toBe(chain.length);
    expect(operative?.failureReason).not.toBeNull();
  });

  it("rejects a FAILED attempt with no reason", async () => {
    const scratch = await createScratchMerchant(prisma, "reason");
    try {
      const { transaction, customer } = await seedOneTransaction(prisma, scratch.id);
      await expect(
        prisma.paymentAttempt.create({
          data: {
            merchantId: scratch.id, transactionId: transaction.id, customerId: customer.id,
            sourceRef: "pa_bad", amountPaise: 250_000, status: "FAILED",
            failureReason: null, method: "CARD", attemptNo: 2,
            retryOfAttemptId: null, occurredAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await purgeMerchant(prisma, scratch.id);
    }
  });

  it("rejects a SUCCESS attempt that carries a failure reason", async () => {
    const scratch = await createScratchMerchant(prisma, "success");
    try {
      const { transaction, customer } = await seedOneTransaction(prisma, scratch.id);
      await expect(
        prisma.paymentAttempt.create({
          data: {
            merchantId: scratch.id, transactionId: transaction.id, customerId: customer.id,
            sourceRef: "pa_bad2", amountPaise: 250_000, status: "SUCCESS",
            failureReason: "EXPIRED_CARD", method: "CARD", attemptNo: 1,
            occurredAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await purgeMerchant(prisma, scratch.id);
    }
  });

  it("requires a retry link on every attempt after the first", async () => {
    const scratch = await createScratchMerchant(prisma, "retry");
    try {
      const { transaction, customer } = await seedOneTransaction(prisma, scratch.id);
      // attemptNo 2 with no parent violates payment_attempt_retry_link_matches_no.
      await expect(
        prisma.paymentAttempt.create({
          data: {
            merchantId: scratch.id, transactionId: transaction.id, customerId: customer.id,
            sourceRef: "pa_orphan", amountPaise: 250_000, status: "FAILED",
            failureReason: "EXPIRED_CARD", method: "CARD", attemptNo: 2,
            retryOfAttemptId: null, occurredAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    } finally {
      await purgeMerchant(prisma, scratch.id);
    }
  });

  it("cascades attempts when their transaction is deleted", async () => {
    const scratch = await createScratchMerchant(prisma, "cascade");
    try {
      const { transaction, customer } = await seedOneTransaction(prisma, scratch.id);
      await prisma.paymentAttempt.create({
        data: {
          merchantId: scratch.id, transactionId: transaction.id, customerId: customer.id,
          sourceRef: "pa_cascade", amountPaise: 250_000, status: "FAILED",
          failureReason: "EXPIRED_CARD", method: "CARD", attemptNo: 1, occurredAt: new Date(),
        },
      });
      await prisma.transaction.delete({ where: { id: transaction.id } });
      expect(
        await prisma.paymentAttempt.count({ where: { transactionId: transaction.id } }),
      ).toBe(0);
    } finally {
      await purgeMerchant(prisma, scratch.id);
    }
  });
});

async function seedOneTransaction(prisma: PrismaClient, merchantId: string) {
  const customer = await prisma.customer.create({
    data: {
      merchantId, sourceRef: "cust_x", externalRef: "EXT-X",
      maskedEmail: "te****@test.local", maskedPhone: "+91*****0000", city: "Pune",
      signupAt: new Date("2026-01-01T00:00:00Z"),
      historicalValuePaise: 0, lifetimeValuePaise: 250_000, tier: "MEDIUM",
    },
  });
  const product = await prisma.product.create({
    data: { merchantId, sourceRef: "prod_x", name: "P", category: "SUBSCRIPTION", pricePaise: 250_000 },
  });
  const transaction = await prisma.transaction.create({
    data: {
      merchantId, customerId: customer.id, productId: product.id, sourceRef: "txn_x",
      quantity: 1, amountPaise: 250_000, status: "FAILED", method: "CARD", attemptCount: 1,
      occurredAt: new Date("2026-08-01T00:00:00Z"), settledAt: new Date("2026-08-01T00:00:00Z"),
    },
  });
  return { customer, product, transaction };
}
