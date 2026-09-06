import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { FakePaymentProvider } from "@/integrations/razorpay";
import { verifyAuditChain } from "@/server/audit/audit-logger";
import { approveIntervention, submitForApproval } from "@/server/services/approval.service";
import { executeIntervention } from "@/server/services/execution.service";
import { getDashboardMetrics } from "@/server/services/read.service";
import {
  DEFAULT_TEST_POLICY_RULES, buildInterventionFixture, createScratchMerchant,
  createTestClient, purgeMerchant,
} from "../helpers/db";

/**
 * Execution against the real database, using the fake provider.
 *
 * Nothing here calls Razorpay. The point is the executor's gates, retries, and
 * state handling — none of which should depend on a network.
 */
describe("execution flow", () => {
  let prisma: PrismaClient;
  const scratchIds: string[] = [];
  const MIDDAY = new Date("2026-09-06T08:30:00Z");

  beforeAll(() => { prisma = createTestClient(); });
  afterEach(async () => {
    while (scratchIds.length > 0) await purgeMerchant(prisma, scratchIds.pop()!);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  /** A merchant with one intervention, optionally carried through to APPROVED. */
  async function scenario(options: { approve?: boolean; policy?: Record<string, unknown> } = {}) {
    const merchant = await createScratchMerchant(prisma, "exec");
    scratchIds.push(merchant.id);
    const fixture = await buildInterventionFixture(prisma, merchant.id);

    await prisma.intervention.update({
      where: { id: fixture.intervention.id }, data: { state: "PROPOSED" },
    });
    if (options.policy) {
      await prisma.guardrailPolicy.updateMany({
        where: { merchantId: merchant.id, version: 1 },
        data: { rules: { ...DEFAULT_TEST_POLICY_RULES, ...options.policy } },
      });
    }
    await prisma.interventionTarget.create({
      data: {
        interventionId: fixture.intervention.id, customerId: fixture.customer.id,
        transactionId: fixture.transaction.id, amountPaise: 250_000,
        perTargetRef: `rp_${Math.random().toString(36).slice(2, 12)}`,
      },
    });

    const submitted = await submitForApproval(fixture.intervention.id, {
      client: prisma, evaluatedAt: MIDDAY,
    });
    let version = submitted.version;

    if (options.approve) {
      const outcome = await approveIntervention(fixture.intervention.id, {
        userId: fixture.user.id, expectedVersion: version, client: prisma, evaluatedAt: MIDDAY,
      });
      expect(outcome.status).toBe("APPROVED");
      version = outcome.status === "APPROVED" ? outcome.version : version;
    }
    return { merchant, fixture, version };
  }

  const execute = (id: string, version: number, userId: string, provider = new FakePaymentProvider()) =>
    executeIntervention(id, {
      userId, expectedVersion: version, provider, client: prisma, evaluatedAt: MIDDAY,
    });

  it("executes an approved intervention and ends at OBSERVING", async () => {
    const { fixture, version } = await scenario({ approve: true });
    const outcome = await execute(fixture.intervention.id, version, fixture.user.id);

    expect(outcome.status).toBe("EXECUTED");
    if (outcome.status !== "EXECUTED") return;
    expect(outcome.artifacts).toHaveLength(1);
    expect(outcome.artifacts[0]!.status).toBe("created");

    const intervention = await prisma.intervention.findUniqueOrThrow({
      where: { id: fixture.intervention.id },
    });
    // EXECUTED means the link exists; OBSERVING is where it waits for payment.
    expect(intervention.state).toBe("OBSERVING");
    expect(intervention.executedAt).not.toBeNull();

    const artifact = await prisma.razorpayArtifact.findFirstOrThrow({
      where: { interventionId: fixture.intervention.id },
    });
    expect(artifact.artifactType).toBe("PAYMENT_LINK");
    expect(artifact.shortUrl).toContain("rzp.io");
    expect(artifact.status).toBe("created");
  });

  it("refuses to execute an unapproved intervention", async () => {
    const { fixture, version } = await scenario({ approve: false });
    await expect(execute(fixture.intervention.id, version, fixture.user.id))
      .rejects.toThrow(/Only an APPROVED intervention/);
    expect(await prisma.executionAttempt.count()).toBe(0);
    expect(await prisma.razorpayArtifact.count()).toBe(0);
  });

  it("refuses to execute a rejected intervention", async () => {
    const { fixture, version } = await scenario();
    await prisma.intervention.update({
      where: { id: fixture.intervention.id }, data: { state: "REJECTED" },
    });
    await expect(execute(fixture.intervention.id, version, fixture.user.id))
      .rejects.toThrow(/Only an APPROVED intervention/);
  });

  it("rejects a stale version", async () => {
    const { fixture, version } = await scenario({ approve: true });
    await expect(execute(fixture.intervention.id, version - 1, fixture.user.id))
      .rejects.toThrow(/changed since you loaded it/);
    expect(await prisma.executionAttempt.count()).toBe(0);
  });

  it("refuses to execute outside TEST mode", async () => {
    const { merchant, fixture, version } = await scenario({ approve: true });
    await prisma.merchant.update({ where: { id: merchant.id }, data: { mode: "LIVE" } });
    await expect(execute(fixture.intervention.id, version, fixture.user.id))
      .rejects.toThrow(/TEST mode only/);
  });

  it("BLOCKS at pre-execution when the policy changed after approval", async () => {
    const { fixture, version, merchant } = await scenario({ approve: true });
    // A budget that the approved action can no longer fit inside.
    await prisma.estimate.update({
      where: { id: fixture.estimate.id }, data: { discountCostPaise: 3_000_000, costPaise: 3_000_050,
        expectedGrossPaise: 3_100_000, expectedNetPaise: 99_950, channelCostPaise: 50, gatewayFeePaise: 0 },
    });

    const outcome = await execute(fixture.intervention.id, version, fixture.user.id);
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.blockingRules.map((r) => r.ruleId)).toContain("DAILY_DISCOUNT_BUDGET_PAISE");

    expect((await prisma.intervention.findUniqueOrThrow({
      where: { id: fixture.intervention.id },
    })).state).toBe("GUARDRAIL_BLOCKED");
    // Nothing left the building.
    expect(await prisma.executionAttempt.count({ where: { merchantId: merchant.id } })).toBe(0);
    expect(await prisma.razorpayArtifact.count({ where: { merchantId: merchant.id } })).toBe(0);
  });

  it("BLOCKS when consent is withdrawn between approval and execution", async () => {
    const { fixture, version } = await scenario({ approve: true });
    await prisma.customer.update({
      where: { id: fixture.customer.id },
      data: { doNotContactUntil: new Date(MIDDAY.getTime() + 86_400_000), suppressionReason: "CUSTOMER_OPT_OUT" },
    });
    const outcome = await execute(fixture.intervention.id, version, fixture.user.id);
    expect(outcome.status).toBe("BLOCKED");
    if (outcome.status !== "BLOCKED") return;
    expect(outcome.blockingRules.map((r) => r.ruleId)).toContain("DO_NOT_CONTACT");
  });

  describe("idempotency and retries", () => {
    it("persists an ExecutionAttempt with an idempotency key before calling", async () => {
      const { fixture, version } = await scenario({ approve: true });
      await execute(fixture.intervention.id, version, fixture.user.id);

      const attempts = await prisma.executionAttempt.findMany({
        where: { interventionId: fixture.intervention.id },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.idempotencyKey).toHaveLength(64);
      expect(attempts[0]!.status).toBe("SUCCEEDED");
      expect(attempts[0]!.request).toMatchObject({ currency: "INR" });
    });

    it("retries a transient failure and succeeds", async () => {
      const { fixture, version } = await scenario({ approve: true });
      const provider = new FakePaymentProvider({ failWith: ["TRANSIENT"] });

      const outcome = await execute(fixture.intervention.id, version, fixture.user.id, provider);
      expect(outcome.status).toBe("EXECUTED");

      const attempts = await prisma.executionAttempt.findMany({
        where: { interventionId: fixture.intervention.id }, orderBy: { attemptNo: "asc" },
      });
      expect(attempts).toHaveLength(2);
      expect(attempts[0]!.status).toBe("FAILED");
      expect(attempts[1]!.status).toBe("SUCCEEDED");
      // Distinct keys per attempt, so each call is individually accountable.
      expect(attempts[0]!.idempotencyKey).not.toBe(attempts[1]!.idempotencyKey);
    });

    it("does NOT create a second link after an ambiguous timeout", async () => {
      // The most important test here: a lost response must never duplicate an
      // external action.
      const { fixture, version } = await scenario({ approve: true });
      const provider = new FakePaymentProvider({ failWith: ["AMBIGUOUS"] });

      const outcome = await execute(fixture.intervention.id, version, fixture.user.id, provider);
      expect(outcome.status).toBe("EXECUTED");
      if (outcome.status !== "EXECUTED") return;
      // The retry reconciled by reference rather than creating another link.
      expect(outcome.artifacts[0]!.reconciled).toBe(true);
      expect(provider.createCallCount).toBe(1);
      expect(await prisma.razorpayArtifact.count({
        where: { interventionId: fixture.intervention.id },
      })).toBe(1);
    });

    it("does NOT retry a validation error", async () => {
      const { fixture, version } = await scenario({ approve: true });
      const provider = new FakePaymentProvider({ failWith: ["VALIDATION", "VALIDATION", "VALIDATION"] });

      const outcome = await execute(fixture.intervention.id, version, fixture.user.id, provider);
      expect(outcome.status).toBe("EXECUTION_FAILED");
      // Asking the same rejected question again changes nothing.
      expect(provider.createCallCount).toBe(1);
      expect(await prisma.executionAttempt.count({
        where: { interventionId: fixture.intervention.id },
      })).toBe(1);
    });

    it("does NOT retry an authentication error", async () => {
      const { fixture, version } = await scenario({ approve: true });
      const provider = new FakePaymentProvider({ failWith: ["AUTHENTICATION"] });
      const outcome = await execute(fixture.intervention.id, version, fixture.user.id, provider);
      expect(outcome.status).toBe("EXECUTION_FAILED");
      expect(provider.createCallCount).toBe(1);
    });

    it("gives up after bounded retries and records every attempt", async () => {
      const { fixture, version } = await scenario({ approve: true });
      const provider = new FakePaymentProvider({
        failWith: ["TRANSIENT", "TRANSIENT", "TRANSIENT", "TRANSIENT"],
      });

      const outcome = await execute(fixture.intervention.id, version, fixture.user.id, provider);
      expect(outcome.status).toBe("EXECUTION_FAILED");
      if (outcome.status !== "EXECUTION_FAILED") return;
      expect(outcome.errors[0]!.kind).toBe("TRANSIENT");

      expect((await prisma.intervention.findUniqueOrThrow({
        where: { id: fixture.intervention.id },
      })).state).toBe("EXECUTION_FAILED");

      const attempts = await prisma.executionAttempt.findMany({
        where: { interventionId: fixture.intervention.id },
      });
      expect(attempts).toHaveLength(3);
      for (const attempt of attempts) {
        expect(attempt.status).toBe("FAILED");
        expect(attempt.error).toContain("TRANSIENT");
        expect(attempt.finishedAt).not.toBeNull();
      }
    });

    it("treats a malformed provider response as a failure", async () => {
      const { fixture, version } = await scenario({ approve: true });
      const provider = new FakePaymentProvider({ failWith: ["MALFORMED"] });
      const outcome = await execute(fixture.intervention.id, version, fixture.user.id, provider);
      expect(outcome.status).toBe("EXECUTION_FAILED");
      // Not retryable: a response we cannot verify will not verify on retry.
      expect(provider.createCallCount).toBe(1);
      expect(await prisma.razorpayArtifact.count()).toBe(0);
    });
  });

  it("writes a complete audit trail and the chain verifies", async () => {
    const { merchant, fixture, version } = await scenario({ approve: true });
    await execute(fixture.intervention.id, version, fixture.user.id);

    const actions = (await prisma.auditLog.findMany({
      where: { merchantId: merchant.id }, orderBy: { seq: "asc" },
    })).map((entry) => entry.action);

    expect(actions).toContain("EXECUTION_REQUESTED");
    expect(actions).toContain("EXECUTION_STARTED");
    expect(actions).toContain("ARTIFACT_CREATED");
    expect(actions).toContain("EXECUTION_SUCCEEDED");
    expect(actions).toContain("OBSERVING_STARTED");
    expect((await verifyAuditChain(prisma, merchant.id)).valid).toBe(true);
  });

  it("never records a credential in an audit entry or an attempt", async () => {
    const { merchant, fixture, version } = await scenario({ approve: true });
    await execute(fixture.intervention.id, version, fixture.user.id);

    const serialised = JSON.stringify(
      [
        await prisma.auditLog.findMany({ where: { merchantId: merchant.id } }),
        await prisma.executionAttempt.findMany({ where: { merchantId: merchant.id } }),
        await prisma.razorpayArtifact.findMany({ where: { merchantId: merchant.id } }),
      ],
      // AuditLog.seq is a BigInt, which JSON.stringify cannot serialise.
      (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    );
    for (const secret of ["rzp_test_", "rzp_live_", "keySecret", "Authorization", "Basic "]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it("leaves recovered revenue at zero after a successful execution", async () => {
    // The distinction the whole phase turns on: a created link is not revenue.
    const { merchant, fixture, version } = await scenario({ approve: true });
    await execute(fixture.intervention.id, version, fixture.user.id);

    const metrics = await getDashboardMetrics(merchant.id);
    expect(metrics.executedInterventions).toBe(1);
    expect(metrics.paymentLinksCreated).toBe(1);
    expect(metrics.paymentLinkValuePaise).toBeGreaterThan(0);
    // Unmoved, because no payment event has occurred.
    expect(metrics.recoveredAmountPaise).toBe(0);
    expect(await prisma.attributionRecord.count({ where: { merchantId: merchant.id } })).toBe(0);
  });

  it("involves no LLM during execution", async () => {
    const { merchant, fixture, version } = await scenario({ approve: true });
    const before = await prisma.llmCall.count({ where: { merchantId: merchant.id } });
    await execute(fixture.intervention.id, version, fixture.user.id);
    expect(await prisma.llmCall.count({ where: { merchantId: merchant.id } })).toBe(before);
  });

  it("does not reach CONVERTED — that needs a real payment event", async () => {
    const { fixture, version } = await scenario({ approve: true });
    await execute(fixture.intervention.id, version, fixture.user.id);

    const intervention = await prisma.intervention.findUniqueOrThrow({
      where: { id: fixture.intervention.id },
    });
    expect(intervention.state).toBe("OBSERVING");
    expect(["CONVERTED", "LEARNED"]).not.toContain(intervention.state);
  });
});
