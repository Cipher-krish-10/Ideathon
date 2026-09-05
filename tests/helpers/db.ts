import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";

/**
 * A dedicated client for tests, separate from the app singleton so a suite can
 * disconnect without tearing down anything else.
 */
export function createTestClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

export const DEMO_MERCHANT_SOURCE_REF = "merch_demo_001";

/** Resolve the seeded demo merchant, failing loudly if the seed has not run. */
export async function getDemoMerchant(prisma: PrismaClient) {
  const merchant = await prisma.merchant.findUnique({
    where: { sourceRef: DEMO_MERCHANT_SOURCE_REF },
  });
  if (!merchant) {
    throw new Error(
      `Demo merchant "${DEMO_MERCHANT_SOURCE_REF}" not found. Run: npm run db:seed`,
    );
  }
  return merchant;
}

/**
 * Delete a merchant and everything under it.
 *
 * The audit log is append-only by trigger, so a purge has to opt in explicitly.
 * That opt-in is the point: teardown is possible, but never accidental.
 */
export async function purgeMerchant(prisma: PrismaClient, merchantId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL revenuepilot.allow_audit_purge = 'on'");
    await tx.merchant.deleteMany({ where: { id: merchantId } });
  });
}

/** A throwaway merchant for tests that must not touch seeded demo data. */
export async function createScratchMerchant(prisma: PrismaClient, label: string) {
  return prisma.merchant.create({
    data: {
      sourceRef: `test_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: `Test Merchant ${label}`,
      businessType: "test",
      datasetReferenceAt: new Date("2026-09-01T23:59:59+05:30"),
      datasetSeed: 1,
      datasetVersion: "test",
    },
  });
}

/**
 * Build a minimal but complete graph down to an Intervention in DRAFT.
 *
 * Used by the tests that exercise the approval gate, which need every upstream
 * row to exist before the interesting constraint can even be reached.
 */
export async function buildInterventionFixture(
  prisma: PrismaClient,
  merchantId: string,
) {
  const suffix = Math.random().toString(36).slice(2, 10);

  const user = await prisma.user.create({
    data: { merchantId, email: `approver-${suffix}@test.local`, name: "Test Approver", role: "APPROVER" },
  });
  const customer = await prisma.customer.create({
    data: {
      merchantId, sourceRef: `cust_${suffix}`, externalRef: `EXT-${suffix}`,
      maskedEmail: "te****@test.local", maskedPhone: "+91*****0000", city: "Bengaluru",
      signupAt: new Date("2026-01-01T00:00:00Z"),
      historicalValuePaise: 500_000, lifetimeValuePaise: 500_000, tier: "MEDIUM",
    },
  });
  const product = await prisma.product.create({
    data: { merchantId, sourceRef: `prod_${suffix}`, name: "Test Plan", category: "SUBSCRIPTION", pricePaise: 250_000 },
  });
  const transaction = await prisma.transaction.create({
    data: {
      merchantId, customerId: customer.id, productId: product.id, sourceRef: `txn_${suffix}`,
      quantity: 1, amountPaise: 250_000, status: "FAILED", method: "CARD", attemptCount: 1,
      occurredAt: new Date("2026-08-20T10:00:00Z"), settledAt: new Date("2026-08-20T10:00:00Z"),
    },
  });
  const attempt = await prisma.paymentAttempt.create({
    data: {
      merchantId, transactionId: transaction.id, customerId: customer.id, sourceRef: `pa_${suffix}`,
      amountPaise: 250_000, status: "FAILED", failureReason: "INSUFFICIENT_FUNDS",
      method: "CARD", attemptNo: 1, occurredAt: new Date("2026-08-20T10:00:00Z"),
    },
  });
  const opportunity = await prisma.opportunity.create({
    data: {
      merchantId, type: "FAILED_PAYMENT_RECOVERY", detectorKey: "FAILED_PAYMENT_RECOVERY",
      detectorVersion: "test", affectedCustomerCount: 1, recoverableAmountPaise: 250_000,
      evidence: { failureReasons: { INSUFFICIENT_FUNDS: 1 } },
      referenceAt: new Date("2026-09-01T23:59:59+05:30"),
    },
  });
  const playbook = await prisma.playbook.create({
    data: {
      merchantId, key: `TEST_PLAYBOOK_${suffix}`, name: "Test Playbook",
      actionType: "PAYMENT_LINK_PLAIN", defaultDiscountBps: 0, channelCostPaise: 50,
    },
  });
  // Costs must satisfy the estimate CHECK constraints:
  //   cost = discount + channel + fee, and net = gross - cost.
  const expectedGrossPaise = 65_000;
  const discountCostPaise = 0;
  const channelCostPaise = 50;
  const gatewayFeePaise = 1_300;
  const costPaise = discountCostPaise + channelCostPaise + gatewayFeePaise;
  const estimate = await prisma.estimate.create({
    data: {
      merchantId, opportunityId: opportunity.id, playbookId: playbook.id,
      expectedGrossPaise, discountCostPaise, channelCostPaise, gatewayFeePaise, costPaise,
      expectedNetPaise: expectedGrossPaise - costPaise,
      pRecoverAvgBps: 2_600, confidence: "MEDIUM",
      inputsSnapshot: { note: "fixture" }, estimatorVersion: "test",
    },
  });
  const intervention = await prisma.intervention.create({
    data: {
      merchantId, opportunityId: opportunity.id, playbookId: playbook.id, estimateId: estimate.id,
      state: "PENDING_APPROVAL", reasoningMode: "DETERMINISTIC_FALLBACK",
      attributionRef: `rp_${suffix}`,
    },
  });

  return { user, customer, product, transaction, attempt, opportunity, playbook, estimate, intervention };
}
