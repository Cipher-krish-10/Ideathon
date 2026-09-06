import { describe, expect, it } from "vitest";

import { RazorpayProvider } from "@/integrations/razorpay";

/**
 * Real Razorpay Test Mode smoke test.
 *
 * SKIPPED unless RUN_RAZORPAY_SMOKE=true. It makes a genuine external call, so
 * it must never run in ordinary CI: a third-party outage is not a reason for a
 * build to fail, and creating links on every push is not polite.
 *
 *   RUN_RAZORPAY_SMOKE=true npm test -- razorpay-smoke
 */
const enabled = process.env.RUN_RAZORPAY_SMOKE === "true";

describe.skipIf(!enabled)("Razorpay Test Mode smoke (opt-in)", () => {
  it("refuses to run without explicit test-mode configuration", () => {
    expect(process.env.RAZORPAY_MODE).toBe("test");
    expect(process.env.RAZORPAY_KEY_ID).toBeTruthy();
    expect(process.env.RAZORPAY_KEY_SECRET).toBeTruthy();
    // Never run this against live credentials.
    expect(process.env.RAZORPAY_KEY_ID ?? "").not.toMatch(/^rzp_live_/);
  });

  it("creates a real payment link in Test Mode", async () => {
    const provider = new RazorpayProvider({
      keyId: process.env.RAZORPAY_KEY_ID!,
      keySecret: process.env.RAZORPAY_KEY_SECRET!,
      mode: process.env.RAZORPAY_MODE!,
    });

    // A per-run reference, so repeated runs do not collide on uniqueness.
    const referenceId = `rp_smoketest_${Date.now()}`;
    const artifact = await provider.createPaymentLink({
      amountPaise: 100_000,
      currency: "INR",
      description: "RevenuePilot integration smoke test",
      referenceId,
      attributionRef: "rp_smoketest",
      interventionId: "smoke",
      customerRef: "smoke_customer",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    expect(artifact.providerEntityId).toMatch(/^plink_/);
    expect(artifact.shortUrl).toContain("http");
    expect(artifact.amountPaise).toBe(100_000);
    // A created link is not a paid one.
    expect(artifact.status).toBe("created");
    expect(artifact.referenceId).toBe(referenceId);

    // Reconciliation works against the real API too — the protection that stops
    // an ambiguous timeout from duplicating a link.
    const found = await provider.findPaymentLinkByReference(referenceId);
    expect(found?.providerEntityId).toBe(artifact.providerEntityId);
    expect(found?.reconciled).toBe(true);
  }, 30_000);
});
