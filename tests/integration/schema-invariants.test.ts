import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  buildInterventionFixture,
  createScratchMerchant,
  createTestClient,
  getDemoMerchant,
  purgeMerchant,
} from "../helpers/db";

/**
 * The invariants RevenuePilot claims in ARCHITECTURE.md, asserted against the
 * database itself. Application code can be bypassed; these constraints cannot.
 */
describe("schema invariants", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createTestClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("money is integer paise, structurally", () => {
    it("declares every *Paise column as INTEGER", async () => {
      const columns = await prisma.$queryRaw<Array<{ table_name: string; column_name: string; data_type: string }>>`
        SELECT table_name, column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name LIKE '%Paise'`;
      expect(columns.length).toBeGreaterThan(10);
      expect(columns.filter((c) => c.data_type !== "integer")).toHaveLength(0);
    });

    it("has no floating-point column anywhere", async () => {
      // Not one float in the schema — including the Beta priors, which are
      // stored as milli-units so learning updates stay exactly reproducible.
      const floats = await prisma.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND data_type IN ('double precision', 'real', 'numeric')`;
      expect(floats).toHaveLength(0);
    });

    it("rejects a non-positive transaction amount", async () => {
      const scratch = await createScratchMerchant(prisma, "money");
      try {
        const customer = await prisma.customer.create({
          data: {
            merchantId: scratch.id, sourceRef: "c1", externalRef: "E1",
            maskedEmail: "a****@t.local", maskedPhone: "+91*****0000", city: "Pune",
            signupAt: new Date(), historicalValuePaise: 0, lifetimeValuePaise: 0, tier: "LOW",
          },
        });
        const product = await prisma.product.create({
          data: { merchantId: scratch.id, sourceRef: "p1", name: "P", category: "ADDON", pricePaise: 100 },
        });
        await expect(
          prisma.transaction.create({
            data: {
              merchantId: scratch.id, customerId: customer.id, productId: product.id,
              sourceRef: "t1", quantity: 1, amountPaise: 0, status: "FAILED",
              method: "UPI", attemptCount: 1, occurredAt: new Date(), settledAt: new Date(),
            },
          }),
        ).rejects.toThrow();
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });
  });

  describe("uniqueness constraints", () => {
    it("rejects a duplicate sourceRef within one merchant", async () => {
      const scratch = await createScratchMerchant(prisma, "unique");
      try {
        const data = {
          merchantId: scratch.id, sourceRef: "cust_dupe", externalRef: "E",
          maskedEmail: "a****@t.local", maskedPhone: "+91*****0000", city: "Pune",
          signupAt: new Date(), historicalValuePaise: 0, lifetimeValuePaise: 0, tier: "LOW" as const,
        };
        await prisma.customer.create({ data });
        await expect(prisma.customer.create({ data })).rejects.toThrow();
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });

    it("rejects two attempts sharing an attemptNo on one transaction", async () => {
      const scratch = await createScratchMerchant(prisma, "attemptno");
      try {
        const { transaction, customer } = await minimalTransaction(prisma, scratch.id);
        const base = {
          merchantId: scratch.id, transactionId: transaction.id, customerId: customer.id,
          amountPaise: 250_000, status: "FAILED" as const, failureReason: "EXPIRED_CARD" as const,
          method: "CARD" as const, attemptNo: 1, occurredAt: new Date(),
        };
        await prisma.paymentAttempt.create({ data: { ...base, sourceRef: "pa_1" } });
        await expect(
          prisma.paymentAttempt.create({ data: { ...base, sourceRef: "pa_2" } }),
        ).rejects.toThrow();
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });

    it("rejects a duplicate execution idempotency key", async () => {
      const scratch = await createScratchMerchant(prisma, "idem");
      try {
        const fixture = await buildInterventionFixture(prisma, scratch.id);
        await prisma.approval.create({
          data: {
            merchantId: scratch.id, interventionId: fixture.intervention.id,
            userId: fixture.user.id, decision: "APPROVED", interventionVersion: 0,
          },
        });

        const key = "sha256-fixed-key";
        await prisma.executionAttempt.create({
          data: {
            merchantId: scratch.id, interventionId: fixture.intervention.id,
            attemptNo: 1, idempotencyKey: key,
          },
        });
        // A retry after a crash must reuse the key, and must not double-act.
        await expect(
          prisma.executionAttempt.create({
            data: {
              merchantId: scratch.id, interventionId: fixture.intervention.id,
              attemptNo: 2, idempotencyKey: key,
            },
          }),
        ).rejects.toThrow();
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });

    it("allows only one approval decision per intervention", async () => {
      const scratch = await createScratchMerchant(prisma, "approval");
      try {
        const fixture = await buildInterventionFixture(prisma, scratch.id);
        const data = {
          merchantId: scratch.id, interventionId: fixture.intervention.id,
          userId: fixture.user.id, decision: "APPROVED" as const, interventionVersion: 0,
        };
        await prisma.approval.create({ data });
        await expect(prisma.approval.create({ data })).rejects.toThrow();
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });
  });

  describe("the approval gate", () => {
    it("refuses to move an intervention into EXECUTING without an approval", async () => {
      // This is the product's central safety promise, enforced in the database
      // so that no code path -- agent, API, script, or manual SQL -- can skip it.
      const scratch = await createScratchMerchant(prisma, "gate");
      try {
        const fixture = await buildInterventionFixture(prisma, scratch.id);
        await expect(
          prisma.intervention.update({
            where: { id: fixture.intervention.id },
            data: { state: "EXECUTING" },
          }),
        ).rejects.toThrow(/without an APPROVED approval/);
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });

    it("refuses every downstream execution state too", async () => {
      const scratch = await createScratchMerchant(prisma, "gate2");
      try {
        const fixture = await buildInterventionFixture(prisma, scratch.id);
        for (const state of ["EXECUTED", "OBSERVING", "CONVERTED", "LEARNED"] as const) {
          await expect(
            prisma.intervention.update({
              where: { id: fixture.intervention.id }, data: { state },
            }),
          ).rejects.toThrow();
        }
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });

    it("refuses an execution attempt for an unapproved intervention", async () => {
      const scratch = await createScratchMerchant(prisma, "gate3");
      try {
        const fixture = await buildInterventionFixture(prisma, scratch.id);
        await expect(
          prisma.executionAttempt.create({
            data: {
              merchantId: scratch.id, interventionId: fixture.intervention.id,
              attemptNo: 1, idempotencyKey: "unapproved-key",
            },
          }),
        ).rejects.toThrow(/requires an APPROVED approval/);
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });

    it("treats a REJECTED decision as no approval at all", async () => {
      const scratch = await createScratchMerchant(prisma, "gate4");
      try {
        const fixture = await buildInterventionFixture(prisma, scratch.id);
        await prisma.approval.create({
          data: {
            merchantId: scratch.id, interventionId: fixture.intervention.id,
            userId: fixture.user.id, decision: "REJECTED", interventionVersion: 0,
          },
        });
        await expect(
          prisma.intervention.update({
            where: { id: fixture.intervention.id }, data: { state: "EXECUTING" },
          }),
        ).rejects.toThrow(/without an APPROVED approval/);
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });

    it("permits execution once an APPROVED decision exists", async () => {
      const scratch = await createScratchMerchant(prisma, "gate5");
      try {
        const fixture = await buildInterventionFixture(prisma, scratch.id);
        await prisma.approval.create({
          data: {
            merchantId: scratch.id, interventionId: fixture.intervention.id,
            userId: fixture.user.id, decision: "APPROVED", interventionVersion: 0,
          },
        });
        const updated = await prisma.intervention.update({
          where: { id: fixture.intervention.id },
          data: { state: "EXECUTING", version: { increment: 1 } },
        });
        expect(updated.state).toBe("EXECUTING");
        expect(updated.version).toBe(1);

        const attempt = await prisma.executionAttempt.create({
          data: {
            merchantId: scratch.id, interventionId: fixture.intervention.id,
            attemptNo: 1, idempotencyKey: `key-${fixture.intervention.id}`,
          },
        });
        expect(attempt.status).toBe("PENDING");
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });

    it("allows non-execution states without an approval", async () => {
      const scratch = await createScratchMerchant(prisma, "gate6");
      try {
        const fixture = await buildInterventionFixture(prisma, scratch.id);
        for (const state of ["GUARDRAIL_BLOCKED", "REJECTED", "EXPIRED", "CANCELLED"] as const) {
          const updated = await prisma.intervention.update({
            where: { id: fixture.intervention.id }, data: { state },
          });
          expect(updated.state).toBe(state);
        }
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });
  });

  describe("the audit log is append-only", () => {
    it("accepts appends and rejects updates", async () => {
      const scratch = await createScratchMerchant(prisma, "audit");
      try {
        const entry = await prisma.auditLog.create({
          data: {
            merchantId: scratch.id, seq: 1n, actorType: "SYSTEM",
            entityType: "Merchant", entityId: scratch.id, action: "MERCHANT_CREATED",
            prevHash: "0".repeat(64), hash: "a".repeat(64),
          },
        });
        expect(entry.seq).toBe(1n);

        await expect(
          prisma.auditLog.update({ where: { id: entry.id }, data: { action: "TAMPERED" } }),
        ).rejects.toThrow(/append-only/);
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });

    it("rejects deletes unless a session explicitly opts in", async () => {
      const scratch = await createScratchMerchant(prisma, "audit2");
      try {
        const entry = await prisma.auditLog.create({
          data: {
            merchantId: scratch.id, seq: 1n, actorType: "USER",
            entityType: "Intervention", entityId: "x", action: "APPROVED",
            prevHash: "0".repeat(64), hash: "b".repeat(64),
          },
        });
        await expect(prisma.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(
          /append-only/,
        );
        // The opt-in exists so teardown is possible, but never accidental.
        await prisma.$transaction(async (tx) => {
          await tx.$executeRawUnsafe("SET LOCAL revenuepilot.allow_audit_purge = 'on'");
          await tx.auditLog.delete({ where: { id: entry.id } });
        });
        expect(await prisma.auditLog.findUnique({ where: { id: entry.id } })).toBeNull();
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });

    it("keeps seq unique per merchant", async () => {
      const scratch = await createScratchMerchant(prisma, "audit3");
      try {
        const base = {
          merchantId: scratch.id, actorType: "SYSTEM" as const,
          entityType: "X", entityId: "y", action: "A", prevHash: "0".repeat(64),
        };
        await prisma.auditLog.create({ data: { ...base, seq: 1n, hash: "c".repeat(64) } });
        await expect(
          prisma.auditLog.create({ data: { ...base, seq: 1n, hash: "d".repeat(64) } }),
        ).rejects.toThrow();
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });
  });

  describe("estimate arithmetic", () => {
    it("rejects an estimate whose net does not equal gross minus cost", async () => {
      // A number that does not add up must never reach the database, because
      // every figure the UI shows is meant to trace to a row.
      const scratch = await createScratchMerchant(prisma, "estimate");
      try {
        const fixture = await buildInterventionFixture(prisma, scratch.id);
        await expect(
          prisma.estimate.create({
            data: {
              merchantId: scratch.id, opportunityId: fixture.opportunity.id,
              playbookId: fixture.playbook.id,
              expectedGrossPaise: 100_000, discountCostPaise: 0, channelCostPaise: 50,
              gatewayFeePaise: 1_950, costPaise: 2_000,
              expectedNetPaise: 99_999, // should be 98,000
              pRecoverAvgBps: 3_000, confidence: "MEDIUM",
              inputsSnapshot: {}, estimatorVersion: "test",
            },
          }),
        ).rejects.toThrow();
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });

    it("rejects a recovery probability outside 0..10000 bps", async () => {
      const scratch = await createScratchMerchant(prisma, "bps");
      try {
        const fixture = await buildInterventionFixture(prisma, scratch.id);
        await expect(
          prisma.estimate.create({
            data: {
              merchantId: scratch.id, opportunityId: fixture.opportunity.id,
              playbookId: fixture.playbook.id,
              expectedGrossPaise: 100_000, discountCostPaise: 0, channelCostPaise: 0,
              gatewayFeePaise: 0, costPaise: 0, expectedNetPaise: 100_000,
              pRecoverAvgBps: 10_001, confidence: "HIGH",
              inputsSnapshot: {}, estimatorVersion: "test",
            },
          }),
        ).rejects.toThrow();
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });
  });

  describe("suppression state", () => {
    it("requires a suppression date and reason to travel together", async () => {
      const scratch = await createScratchMerchant(prisma, "suppress");
      try {
        await expect(
          prisma.customer.create({
            data: {
              merchantId: scratch.id, sourceRef: "c_s", externalRef: "E",
              maskedEmail: "a****@t.local", maskedPhone: "+91*****0000", city: "Pune",
              signupAt: new Date(), historicalValuePaise: 0, lifetimeValuePaise: 0, tier: "LOW",
              doNotContactUntil: new Date("2027-01-01"), suppressionReason: null,
            },
          }),
        ).rejects.toThrow();
      } finally {
        await purgeMerchant(prisma, scratch.id);
      }
    });
  });

  describe("the demo merchant is in TEST mode", () => {
    it("never carries LIVE mode in this build", async () => {
      const merchant = await getDemoMerchant(prisma);
      expect(merchant.mode).toBe("TEST");
    });
  });
});

async function minimalTransaction(prisma: PrismaClient, merchantId: string) {
  const customer = await prisma.customer.create({
    data: {
      merchantId, sourceRef: "cust_m", externalRef: "EM",
      maskedEmail: "a****@t.local", maskedPhone: "+91*****0000", city: "Pune",
      signupAt: new Date(), historicalValuePaise: 0, lifetimeValuePaise: 250_000, tier: "MEDIUM",
    },
  });
  const product = await prisma.product.create({
    data: { merchantId, sourceRef: "prod_m", name: "P", category: "SUBSCRIPTION", pricePaise: 250_000 },
  });
  const transaction = await prisma.transaction.create({
    data: {
      merchantId, customerId: customer.id, productId: product.id, sourceRef: "txn_m",
      quantity: 1, amountPaise: 250_000, status: "FAILED", method: "CARD", attemptCount: 1,
      occurredAt: new Date(), settledAt: new Date(),
    },
  });
  return { customer, product, transaction };
}
