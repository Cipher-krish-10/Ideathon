import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { MerchantScope, repositoriesFor } from "@/server/repositories";
import { createScratchMerchant, createTestClient, getDemoMerchant, purgeMerchant } from "../helpers/db";

/**
 * Tenant isolation. A single unscoped query is a cross-tenant data leak that
 * looks like ordinary code in review, so the scope has to be structural.
 */
describe("merchant scoping", () => {
  let prisma: PrismaClient;
  let demoMerchantId: string;
  let otherMerchantId: string;
  let otherCustomerId: string;

  beforeAll(async () => {
    prisma = createTestClient();
    demoMerchantId = (await getDemoMerchant(prisma)).id;

    const other = await createScratchMerchant(prisma, "scoping");
    otherMerchantId = other.id;
    const customer = await prisma.customer.create({
      data: {
        merchantId: other.id, sourceRef: "cust_0001", externalRef: "OTHER-1",
        maskedEmail: "ot****@test.local", maskedPhone: "+91*****1111", city: "Delhi",
        signupAt: new Date("2026-01-01T00:00:00Z"),
        historicalValuePaise: 0, lifetimeValuePaise: 9_999_999, tier: "HIGH",
      },
    });
    otherCustomerId = customer.id;
  });

  afterAll(async () => {
    await purgeMerchant(prisma, otherMerchantId);
    await prisma.$disconnect();
  });

  it("requires a non-empty merchantId to construct a scope", () => {
    expect(() => new MerchantScope("")).toThrow(/non-empty merchantId/);
  });

  it("applies the scope AFTER any caller-supplied filter, so it cannot be overridden", () => {
    const scope = new MerchantScope("merchant-a");
    // A caller passing someone else's id must not win.
    const where = scope.where({ merchantId: "merchant-b", tier: "HIGH" });
    expect(where.merchantId).toBe("merchant-a");
    expect(where).toEqual({ merchantId: "merchant-a", tier: "HIGH" });
  });

  it("never returns another merchant's rows from list queries", async () => {
    const repos = repositoriesFor(demoMerchantId, prisma);
    const customers = await repos.customers.list({ take: 1000 });
    expect(customers).toHaveLength(500);
    expect(customers.every((c) => c.merchantId === demoMerchantId)).toBe(true);
    expect(customers.some((c) => c.id === otherCustomerId)).toBe(false);
  });

  it("refuses to resolve a foreign row by its primary key", async () => {
    // findFirst-with-scope, not findUnique: a foreign id must resolve to null
    // rather than leaking the row.
    const repos = repositoriesFor(demoMerchantId, prisma);
    expect(await repos.customers.findById(otherCustomerId)).toBeNull();

    const otherRepos = repositoriesFor(otherMerchantId, prisma);
    expect((await otherRepos.customers.findById(otherCustomerId))?.id).toBe(otherCustomerId);
  });

  it("resolves the same sourceRef to a different row per merchant", async () => {
    // "cust_0001" exists for both merchants — natural keys are unique per
    // tenant, never globally.
    const demo = await repositoriesFor(demoMerchantId, prisma).customers.findBySourceRef("cust_0001");
    const other = await repositoriesFor(otherMerchantId, prisma).customers.findBySourceRef("cust_0001");

    expect(demo).not.toBeNull();
    expect(other).not.toBeNull();
    expect(demo!.id).not.toBe(other!.id);
    expect(demo!.merchantId).toBe(demoMerchantId);
    expect(other!.merchantId).toBe(otherMerchantId);
  });

  it("scopes counts and aggregates", async () => {
    const demo = repositoriesFor(demoMerchantId, prisma);
    const other = repositoriesFor(otherMerchantId, prisma);

    expect(await demo.customers.count()).toBe(500);
    expect(await other.customers.count()).toBe(1);

    expect(await demo.transactions.count()).toBe(1200);
    expect(await other.transactions.count()).toBe(0);
    expect(await other.transactions.sumAmountPaise()).toBe(0);
  });

  it("scopes the detector's primary reads", async () => {
    const demo = repositoriesFor(demoMerchantId, prisma);

    const unpaid = await demo.transactions.listUnpaidWithAttempts();
    expect(unpaid).toHaveLength(66);
    expect(unpaid.every((t) => t.merchantId === demoMerchantId)).toBe(true);
    // Every unpaid transaction arrives with its chain attached, in order.
    expect(unpaid.every((t) => t.paymentAttempts.length >= 1)).toBe(true);
    expect(
      unpaid.every((t) => t.paymentAttempts.every((a, i) => a.attemptNo === i + 1)),
    ).toBe(true);

    const failedAttempts = await demo.paymentAttempts.count({ status: "FAILED" });
    expect(failedAttempts).toBe(89);
  });

  it("treats contactability as a date comparison, not a flag", async () => {
    const merchant = await getDemoMerchant(prisma);
    const demo = repositoriesFor(demoMerchantId, prisma);

    const contactable = await demo.customers.listContactable(merchant.datasetReferenceAt, { take: 1000 });
    const suppressed = await demo.customers.countActivelySuppressed(merchant.datasetReferenceAt);

    expect(suppressed).toBe(6);
    expect(contactable).toHaveLength(500 - 6);
    // The 9 expired suppressions are contactable again.
    expect(contactable.filter((c) => c.doNotContactUntil !== null)).toHaveLength(9);
  });
});
