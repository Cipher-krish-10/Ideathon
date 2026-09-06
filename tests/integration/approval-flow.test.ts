import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { verifyAuditChain } from "@/server/audit/audit-logger";
import {
  approveIntervention, rejectIntervention, submitForApproval,
} from "@/server/services/approval.service";
import { evaluateInterventionGuardrails } from "@/server/services/guardrail.service";
import {
  TransitionError, expireIfLapsed, transitionIntervention,
} from "@/server/services/intervention-state.service";
import {
  DEFAULT_TEST_POLICY_RULES, buildInterventionFixture, createScratchMerchant,
  createTestClient, purgeMerchant,
} from "../helpers/db";

/**
 * Approval and two-phase guardrail safety, against the real database.
 *
 * Each test builds its own merchant so state changes cannot leak between them.
 */
describe("approval flow", () => {
  let prisma: PrismaClient;
  const scratchIds: string[] = [];

  beforeAll(() => { prisma = createTestClient(); });
  afterEach(async () => {
    while (scratchIds.length > 0) await purgeMerchant(prisma, scratchIds.pop()!);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  /** A merchant with an active policy and one PROPOSED intervention. */
  async function scenario(policyOverrides: Record<string, unknown> = {}) {
    const merchant = await createScratchMerchant(prisma, "approval");
    scratchIds.push(merchant.id);
    const fixture = await buildInterventionFixture(prisma, merchant.id);

    await prisma.intervention.update({
      where: { id: fixture.intervention.id }, data: { state: "PROPOSED" },
    });
    await prisma.guardrailPolicy.updateMany({
      where: { merchantId: merchant.id, version: 1 },
      data: { rules: { ...DEFAULT_TEST_POLICY_RULES, ...policyOverrides } },
    });
    await prisma.interventionTarget.create({
      data: {
        interventionId: fixture.intervention.id, customerId: fixture.customer.id,
        transactionId: fixture.transaction.id, amountPaise: 250_000,
        perTargetRef: `ref_${Math.random().toString(36).slice(2, 10)}`,
      },
    });
    return { merchant, fixture };
  }

  /** Midday IST, so quiet hours never confuses an unrelated assertion. */
  const MIDDAY = new Date("2026-09-06T08:30:00Z");

  it("moves a clean proposal to PENDING_APPROVAL and records the evaluation", async () => {
    const { fixture } = await scenario();
    const result = await submitForApproval(fixture.intervention.id, {
      client: prisma, evaluatedAt: MIDDAY,
    });

    expect(result.state).toBe("PENDING_APPROVAL");
    expect(result.evaluation.blocked).toBe(false);
    expect(result.evaluation.results).toHaveLength(10);

    const evaluations = await prisma.guardrailEvaluation.findMany({
      where: { interventionId: fixture.intervention.id },
    });
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]!.phase).toBe("PRE_APPROVAL");
  });

  it("blocks a proposal at PRE_APPROVAL and never reaches a human", async () => {
    const { fixture } = await scenario({
      MIN_EXPECTED_NET_PAISE: { severity: "BLOCK", limit: 99_999_999 },
    });
    const result = await submitForApproval(fixture.intervention.id, {
      client: prisma, evaluatedAt: MIDDAY,
    });
    expect(result.state).toBe("GUARDRAIL_BLOCKED");
    expect(result.evaluation.blocked).toBe(true);
  });

  it("approves, records the Approval, and stops at APPROVED", async () => {
    const { fixture } = await scenario();
    const submitted = await submitForApproval(fixture.intervention.id, {
      client: prisma, evaluatedAt: MIDDAY,
    });

    const outcome = await approveIntervention(fixture.intervention.id, {
      userId: fixture.user.id, expectedVersion: submitted.version,
      client: prisma, evaluatedAt: MIDDAY,
    });

    expect(outcome.status).toBe("APPROVED");
    const intervention = await prisma.intervention.findUniqueOrThrow({
      where: { id: fixture.intervention.id },
    });
    expect(intervention.state).toBe("APPROVED");
    expect(intervention.approvedAt).not.toBeNull();

    // Approval is not execution: nothing downstream exists.
    expect(await prisma.executionAttempt.count({ where: { interventionId: fixture.intervention.id } })).toBe(0);
    expect(await prisma.razorpayArtifact.count()).toBe(0);

    const approval = await prisma.approval.findUniqueOrThrow({
      where: { interventionId: fixture.intervention.id },
    });
    expect(approval.decision).toBe("APPROVED");
    expect(approval.userId).toBe(fixture.user.id);
  });

  it("persists an edited customer message and keeps the original", async () => {
    const { fixture } = await scenario();
    const submitted = await submitForApproval(fixture.intervention.id, {
      client: prisma, evaluatedAt: MIDDAY,
    });
    await prisma.intervention.update({
      where: { id: fixture.intervention.id },
      data: { customerMessage: { subject: "AI subject", body: "AI body" } },
    });

    await approveIntervention(fixture.intervention.id, {
      userId: fixture.user.id, expectedVersion: submitted.version,
      editedMessage: { subject: "Human subject", body: "Human body" },
      client: prisma, evaluatedAt: MIDDAY,
    });

    const intervention = await prisma.intervention.findUniqueOrThrow({
      where: { id: fixture.intervention.id },
    });
    const message = intervention.customerMessage as Record<string, unknown>;
    // The edit is what a future executor would send...
    expect(message.subject).toBe("Human subject");
    expect(message.body).toBe("Human body");
    // ...and the AI original is preserved beside it.
    expect(message.originalSubject).toBe("AI subject");
    expect(message.originalBody).toBe("AI body");
    expect(message.editedByUserId).toBe(fixture.user.id);

    const approval = await prisma.approval.findUniqueOrThrow({
      where: { interventionId: fixture.intervention.id },
    });
    expect(approval.editedMessage).toEqual({ subject: "Human subject", body: "Human body" });
  });

  it("rejects a stale version", async () => {
    const { fixture } = await scenario();
    const submitted = await submitForApproval(fixture.intervention.id, {
      client: prisma, evaluatedAt: MIDDAY,
    });
    await expect(
      approveIntervention(fixture.intervention.id, {
        userId: fixture.user.id, expectedVersion: submitted.version - 1,
        client: prisma, evaluatedAt: MIDDAY,
      }),
    ).rejects.toThrow(/changed since you loaded it/);
  });

  it("refuses a second approval", async () => {
    const { fixture } = await scenario();
    const submitted = await submitForApproval(fixture.intervention.id, {
      client: prisma, evaluatedAt: MIDDAY,
    });
    const first = await approveIntervention(fixture.intervention.id, {
      userId: fixture.user.id, expectedVersion: submitted.version,
      client: prisma, evaluatedAt: MIDDAY,
    });
    expect(first.status).toBe("APPROVED");

    await expect(
      approveIntervention(fixture.intervention.id, {
        userId: fixture.user.id, expectedVersion: first.version,
        client: prisma, evaluatedAt: MIDDAY,
      }),
    ).rejects.toThrow(TransitionError);
    expect(await prisma.approval.count({ where: { interventionId: fixture.intervention.id } })).toBe(1);
  });

  it("rejects a proposal terminally", async () => {
    const { fixture } = await scenario();
    const submitted = await submitForApproval(fixture.intervention.id, {
      client: prisma, evaluatedAt: MIDDAY,
    });
    await rejectIntervention(fixture.intervention.id, {
      userId: fixture.user.id, expectedVersion: submitted.version,
      reason: "Not worth the discount.", client: prisma, evaluatedAt: MIDDAY,
    });

    const intervention = await prisma.intervention.findUniqueOrThrow({
      where: { id: fixture.intervention.id },
    });
    expect(intervention.state).toBe("REJECTED");
    await expect(
      transitionIntervention(fixture.intervention.id, {
        to: "APPROVED", expectedVersion: intervention.version,
        actorType: "USER", action: "ILLEGAL", client: prisma,
      }),
    ).rejects.toThrow(/terminal/);
  });

  it("refuses to approve an expired proposal", async () => {
    const { fixture } = await scenario();
    const submitted = await submitForApproval(fixture.intervention.id, {
      client: prisma, evaluatedAt: MIDDAY,
    });
    await prisma.intervention.update({
      where: { id: fixture.intervention.id },
      data: { expiresAt: new Date(MIDDAY.getTime() - 1_000) },
    });

    const outcome = await approveIntervention(fixture.intervention.id, {
      userId: fixture.user.id, expectedVersion: submitted.version,
      client: prisma, evaluatedAt: MIDDAY,
    });
    expect(outcome.status).toBe("EXPIRED");
    expect(
      (await prisma.intervention.findUniqueOrThrow({ where: { id: fixture.intervention.id } })).state,
    ).toBe("EXPIRED");
    expect(await prisma.approval.count({ where: { interventionId: fixture.intervention.id } })).toBe(0);
  });

  it("writes an audit row for every transition, and the chain verifies", async () => {
    const { merchant, fixture } = await scenario();
    const submitted = await submitForApproval(fixture.intervention.id, {
      client: prisma, evaluatedAt: MIDDAY,
    });
    await approveIntervention(fixture.intervention.id, {
      userId: fixture.user.id, expectedVersion: submitted.version,
      client: prisma, evaluatedAt: MIDDAY,
    });

    const entries = await prisma.auditLog.findMany({
      where: { merchantId: merchant.id }, orderBy: { seq: "asc" },
    });
    const actions = entries.map((entry) => entry.action);
    expect(actions).toContain("PROPOSAL_SUBMITTED_FOR_APPROVAL");
    expect(actions).toContain("APPROVAL_RECORDED");
    expect(actions).toContain("INTERVENTION_APPROVED");
    expect((await verifyAuditChain(prisma, merchant.id)).valid).toBe(true);
  });

  describe("two-phase safety", () => {
    it("passes PRE_APPROVAL, then BLOCKS at PRE_EXECUTION when the budget drops", async () => {
      // The demo failure beat, asserted.
      const { merchant, fixture } = await scenario();
      await prisma.estimate.update({
        where: { id: fixture.estimate.id }, data: { discountCostPaise: 0, costPaise: 1_350 },
      });

      const submitted = await submitForApproval(fixture.intervention.id, {
        client: prisma, evaluatedAt: MIDDAY,
      });
      expect(submitted.state).toBe("PENDING_APPROVAL");

      // The proposal now costs more in discount than the budget allows.
      await prisma.estimate.update({
        where: { id: fixture.estimate.id },
        data: { discountCostPaise: 3_000_000, channelCostPaise: 50, gatewayFeePaise: 0, costPaise: 3_000_050,
                expectedGrossPaise: 3_100_000, expectedNetPaise: 99_950 },
      });

      // A later instant, so the two evaluations are distinguishable in order.
      const LATER = new Date(MIDDAY.getTime() + 60_000);
      const outcome = await approveIntervention(fixture.intervention.id, {
        userId: fixture.user.id, expectedVersion: submitted.version,
        client: prisma, evaluatedAt: LATER,
      });

      expect(outcome.status).toBe("BLOCKED");
      if (outcome.status !== "BLOCKED") return;
      expect(outcome.blockingRules.map((r) => r.ruleId)).toContain("DAILY_DISCOUNT_BUDGET_PAISE");

      const intervention = await prisma.intervention.findUniqueOrThrow({
        where: { id: fixture.intervention.id },
      });
      expect(intervention.state).toBe("GUARDRAIL_BLOCKED");
      // No approval was created, and nothing executed.
      expect(await prisma.approval.count({ where: { interventionId: fixture.intervention.id } })).toBe(0);
      expect(await prisma.executionAttempt.count({ where: { merchantId: merchant.id } })).toBe(0);

      const evaluations = await prisma.guardrailEvaluation.findMany({
        where: { interventionId: fixture.intervention.id }, orderBy: { evaluatedAt: "asc" },
      });
      expect(evaluations.map((e) => e.phase)).toEqual(["PRE_APPROVAL", "PRE_EXECUTION"]);
      expect(evaluations[0]!.decision).not.toBe("BLOCK");
      expect(evaluations[1]!.decision).toBe("BLOCK");
    });

    it("BLOCKS at PRE_EXECUTION when consent is withdrawn after proposal", async () => {
      const { fixture } = await scenario();
      const submitted = await submitForApproval(fixture.intervention.id, {
        client: prisma, evaluatedAt: MIDDAY,
      });
      expect(submitted.state).toBe("PENDING_APPROVAL");

      await prisma.customer.update({
        where: { id: fixture.customer.id },
        data: {
          doNotContactUntil: new Date(MIDDAY.getTime() + 86_400_000),
          suppressionReason: "CUSTOMER_OPT_OUT",
        },
      });

      const outcome = await approveIntervention(fixture.intervention.id, {
        userId: fixture.user.id, expectedVersion: submitted.version,
        client: prisma, evaluatedAt: MIDDAY,
      });
      expect(outcome.status).toBe("BLOCKED");
      if (outcome.status !== "BLOCKED") return;
      expect(outcome.blockingRules.map((r) => r.ruleId)).toContain("DO_NOT_CONTACT");
    });

    it("BLOCKS at PRE_EXECUTION when the merchant leaves TEST mode", async () => {
      const { merchant, fixture } = await scenario();
      const submitted = await submitForApproval(fixture.intervention.id, {
        client: prisma, evaluatedAt: MIDDAY,
      });
      await prisma.merchant.update({ where: { id: merchant.id }, data: { mode: "LIVE" } });

      const outcome = await approveIntervention(fixture.intervention.id, {
        userId: fixture.user.id, expectedVersion: submitted.version,
        client: prisma, evaluatedAt: MIDDAY,
      });
      expect(outcome.status).toBe("BLOCKED");
      if (outcome.status !== "BLOCKED") return;
      expect(outcome.blockingRules.map((r) => r.ruleId)).toContain("TEST_MODE_ONLY");
    });

    it("re-reads state rather than trusting the earlier evaluation", async () => {
      const { fixture } = await scenario();
      const first = await evaluateInterventionGuardrails(fixture.intervention.id, {
        phase: "PRE_APPROVAL", evaluatedAt: MIDDAY, persist: false, client: prisma,
      });
      expect(first.evaluation.blocked).toBe(false);

      await prisma.customer.update({
        where: { id: fixture.customer.id },
        data: {
          doNotContactUntil: new Date(MIDDAY.getTime() + 86_400_000),
          suppressionReason: "CHARGEBACK_DISPUTE",
        },
      });

      const second = await evaluateInterventionGuardrails(fixture.intervention.id, {
        phase: "PRE_EXECUTION", evaluatedAt: MIDDAY, persist: false, client: prisma,
      });
      expect(second.evaluation.blocked).toBe(true);
    });
  });

  it("expires a lapsed proposal at request time", async () => {
    const { fixture } = await scenario();
    await submitForApproval(fixture.intervention.id, { client: prisma, evaluatedAt: MIDDAY });
    await prisma.intervention.update({
      where: { id: fixture.intervention.id },
      data: { expiresAt: new Date(MIDDAY.getTime() - 1) },
    });

    const result = await expireIfLapsed(fixture.intervention.id, {
      evaluatedAt: MIDDAY, client: prisma,
    });
    expect(result?.to).toBe("EXPIRED");
    // Idempotent: a second look does nothing.
    expect(await expireIfLapsed(fixture.intervention.id, { evaluatedAt: MIDDAY, client: prisma })).toBeNull();
  });
});
