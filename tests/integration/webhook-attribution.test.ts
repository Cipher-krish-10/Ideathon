import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PrismaClient } from "@/generated/prisma/client";
import { FakePaymentProvider, signWebhookBody } from "@/integrations/razorpay";
import { verifyAuditChain } from "@/server/audit/audit-logger";
import { approveIntervention, submitForApproval } from "@/server/services/approval.service";
import { executeIntervention } from "@/server/services/execution.service";
import { closeLapsedObservations } from "@/server/services/learning.service";
import { getDashboardMetrics } from "@/server/services/read.service";
import { simulatePaymentForArtifact } from "@/server/services/simulation.service";
import { processWebhookEvent, receiveWebhook } from "@/server/services/webhook.service";
import {
  DEFAULT_TEST_POLICY_RULES, buildInterventionFixture, createScratchMerchant,
  createTestClient, purgeMerchant,
} from "../helpers/db";

/**
 * Webhook → attribution → conversion → learning, against the real database.
 * No live Razorpay call anywhere: events are constructed and signed locally.
 */
const SECRET = "whsec_test_secret";
const MIDDAY = new Date("2026-09-06T08:30:00Z");

describe("webhook, attribution and learning", () => {
  let prisma: PrismaClient;
  const scratchIds: string[] = [];

  beforeAll(() => { prisma = createTestClient(); });
  afterEach(async () => {
    while (scratchIds.length > 0) await purgeMerchant(prisma, scratchIds.pop()!);
  });
  afterAll(async () => { await prisma.$disconnect(); });

  /** Carry an intervention all the way to EXECUTED with a payment link. */
  async function executedScenario() {
    const merchant = await createScratchMerchant(prisma, "hook");
    scratchIds.push(merchant.id);
    const fixture = await buildInterventionFixture(prisma, merchant.id);

    await prisma.intervention.update({
      where: { id: fixture.intervention.id }, data: { state: "PROPOSED" },
    });
    await prisma.guardrailPolicy.updateMany({
      where: { merchantId: merchant.id, version: 1 },
      data: { rules: { ...DEFAULT_TEST_POLICY_RULES } },
    });
    await prisma.interventionTarget.create({
      data: {
        interventionId: fixture.intervention.id, customerId: fixture.customer.id,
        transactionId: fixture.transaction.id, amountPaise: 250_000,
        perTargetRef: `rp_${Math.random().toString(36).slice(2, 12)}`,
      },
    });
    // A prior for the playbook, so learning has something to move.
    await prisma.playbookStat.create({
      data: {
        merchantId: merchant.id, playbookId: fixture.playbook.id,
        failureReason: "INSUFFICIENT_FUNDS", tierScope: "ALL",
        alphaMilli: 10_000, betaMilli: 30_000,
        seededAlphaMilli: 10_000, seededBetaMilli: 30_000, observationCount: 0,
      },
    });

    const submitted = await submitForApproval(fixture.intervention.id, { client: prisma, evaluatedAt: MIDDAY });
    const approved = await approveIntervention(fixture.intervention.id, {
      userId: fixture.user.id, expectedVersion: submitted.version, client: prisma, evaluatedAt: MIDDAY,
    });
    expect(approved.status).toBe("APPROVED");

    const executed = await executeIntervention(fixture.intervention.id, {
      userId: fixture.user.id,
      expectedVersion: approved.status === "APPROVED" ? approved.version : 0,
      provider: new FakePaymentProvider(), client: prisma, evaluatedAt: MIDDAY,
    });
    expect(executed.status).toBe("EXECUTED");

    const artifact = await prisma.razorpayArtifact.findFirstOrThrow({
      where: { interventionId: fixture.intervention.id },
    });
    return { merchant, fixture, artifact };
  }

  /** Build and sign a payment_link.paid event for an artifact. */
  function paidEvent(args: {
    artifactId: string; referenceId: string; amountPaise: number;
    attributionRef: string; eventId?: string; paymentId?: string;
  }) {
    const payload = {
      entity: "event", event: "payment_link.paid", created_at: Math.floor(MIDDAY.getTime() / 1_000),
      payload: {
        payment_link: {
          entity: {
            id: args.artifactId, reference_id: args.referenceId,
            amount: args.amountPaise, amount_paid: args.amountPaise, status: "paid",
            notes: { attribution_ref: args.attributionRef },
          },
        },
        payment: {
          entity: {
            id: args.paymentId ?? "pay_TEST1", amount: args.amountPaise,
            currency: "INR", status: "captured", notes: {},
          },
        },
      },
    };
    const rawBody = JSON.stringify(payload);
    return {
      rawBody,
      signature: signWebhookBody(rawBody, SECRET),
      // providerEventId is globally unique, so it must be distinct per test —
      // otherwise a later test's event dedupes against an earlier one's.
      providerEventId: args.eventId ?? `evt_${args.artifactId}_${args.amountPaise}`,
    };
  }

  async function deliver(merchantId: string, event: ReturnType<typeof paidEvent>) {
    const received = await receiveWebhook({
      ...event, secret: SECRET, merchantId, headers: {}, client: prisma,
    });
    if (received.status !== "ACCEPTED") return { received, processed: null };
    const processed = await processWebhookEvent(received.webhookEventId!, {
      client: prisma, evaluatedAt: MIDDAY,
    });
    return { received, processed };
  }

  describe("receipt", () => {
    it("rejects an invalid signature and never processes it", async () => {
      const { merchant, artifact, fixture } = await executedScenario();
      const ref = (artifact.raw as { reference_id: string }).reference_id;
      const event = paidEvent({
        artifactId: artifact.providerEntityId, referenceId: ref,
        amountPaise: artifact.amountPaise, attributionRef: fixture.intervention.attributionRef,
      });

      const received = await receiveWebhook({
        ...event, signature: "not-a-real-signature", secret: SECRET,
        merchantId: merchant.id, headers: {}, client: prisma,
      });
      expect(received.status).toBe("INVALID_SIGNATURE");

      // Stored as evidence, but never acted on.
      const stored = await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: received.webhookEventId! },
      });
      expect(stored.signatureValid).toBe(false);
      const processed = await processWebhookEvent(stored.id, { client: prisma });
      expect(processed.status).toBe("IGNORED");
      expect(await prisma.attributionRecord.count({ where: { merchantId: merchant.id } })).toBe(0);
    });

    it("deduplicates on the provider event id", async () => {
      const { merchant, artifact, fixture } = await executedScenario();
      const ref = (artifact.raw as { reference_id: string }).reference_id;
      const event = paidEvent({
        artifactId: artifact.providerEntityId, referenceId: ref,
        amountPaise: artifact.amountPaise, attributionRef: fixture.intervention.attributionRef,
      });

      const first = await receiveWebhook({ ...event, secret: SECRET, merchantId: merchant.id, headers: {}, client: prisma });
      const second = await receiveWebhook({ ...event, secret: SECRET, merchantId: merchant.id, headers: {}, client: prisma });
      expect(first.status).toBe("ACCEPTED");
      expect(second.status).toBe("DUPLICATE");
      expect(second.webhookEventId).toBe(first.webhookEventId);
      expect(await prisma.webhookEvent.count({ where: { merchantId: merchant.id } })).toBe(1);
    });

    it("stores a malformed body without crashing", async () => {
      const { merchant } = await executedScenario();
      const rawBody = "{ not json";
      const received = await receiveWebhook({
        rawBody, signature: signWebhookBody(rawBody, SECRET), providerEventId: `evt_BAD_${Date.now()}_${Math.random()}`,
        secret: SECRET, merchantId: merchant.id, headers: {}, client: prisma,
      });
      expect(received.status).toBe("ACCEPTED");
      const processed = await processWebhookEvent(received.webhookEventId!, { client: prisma });
      // Kept, with the failure recorded, so it can be replayed after a fix.
      expect(processed.status).toBe("FAILED");
      const stored = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: received.webhookEventId! } });
      expect(stored.processingError).toBeTruthy();
      expect(stored.rawBody).toBe(rawBody);
    });

    it("ignores an unsupported event type", async () => {
      const { merchant } = await executedScenario();
      const rawBody = JSON.stringify({ entity: "event", event: "refund.created", payload: {} });
      const received = await receiveWebhook({
        rawBody, signature: signWebhookBody(rawBody, SECRET), providerEventId: `evt_REFUND_${Date.now()}_${Math.random()}`,
        secret: SECRET, merchantId: merchant.id, headers: {}, client: prisma,
      });
      const processed = await processWebhookEvent(received.webhookEventId!, { client: prisma });
      expect(processed.status).toBe("IGNORED");
    });
  });

  describe("attribution and conversion", () => {
    it("attributes DIRECT_REF, converts, and records the verified amount", async () => {
      const { merchant, artifact, fixture } = await executedScenario();
      const ref = (artifact.raw as { reference_id: string }).reference_id;

      const { processed } = await deliver(merchant.id, paidEvent({
        artifactId: artifact.providerEntityId, referenceId: ref,
        amountPaise: artifact.amountPaise, attributionRef: fixture.intervention.attributionRef,
      }));

      expect(processed?.status).toBe("PROCESSED");
      expect(processed?.attribution?.attributed).toBe(true);
      if (!processed?.attribution?.attributed) return;
      expect(processed.attribution.method).toBe("DIRECT_REF");
      expect(processed.attribution.confidence).toBe("HIGH");

      const record = await prisma.attributionRecord.findFirstOrThrow({
        where: { merchantId: merchant.id },
      });
      // The amount comes from the verified event.
      expect(record.attributedAmountPaise).toBe(artifact.amountPaise);
      expect(record.method).toBe("DIRECT_REF");

      // OBSERVING -> CONVERTED -> LEARNED, no steps skipped.
      const intervention = await prisma.intervention.findUniqueOrThrow({
        where: { id: fixture.intervention.id },
      });
      expect(intervention.state).toBe("LEARNED");

      // The transaction now reflects what actually happened.
      const transaction = await prisma.transaction.findUniqueOrThrow({
        where: { id: fixture.transaction.id },
      });
      expect(transaction.status).toBe("CAPTURED");
    });

    it("does not double-count a replayed webhook", async () => {
      const { merchant, artifact, fixture } = await executedScenario();
      const ref = (artifact.raw as { reference_id: string }).reference_id;
      const event = paidEvent({
        artifactId: artifact.providerEntityId, referenceId: ref,
        amountPaise: artifact.amountPaise, attributionRef: fixture.intervention.attributionRef,
      });

      await deliver(merchant.id, event);
      const statAfterFirst = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });

      // Same event id: dedupe. Then force a reprocess of the stored event.
      const again = await receiveWebhook({ ...event, secret: SECRET, merchantId: merchant.id, headers: {}, client: prisma });
      expect(again.status).toBe("DUPLICATE");
      const reprocessed = await processWebhookEvent(again.webhookEventId!, { client: prisma });
      expect(reprocessed.status).toBe("ALREADY_PROCESSED");

      expect(await prisma.attributionRecord.count({ where: { merchantId: merchant.id } })).toBe(1);
      const statAfterSecond = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });
      expect(statAfterSecond.alphaMilli).toBe(statAfterFirst.alphaMilli);
      expect(statAfterSecond.observationCount).toBe(1);
    });

    it("refuses to attribute a payment with a foreign reference", async () => {
      const { merchant, artifact } = await executedScenario();
      const { processed } = await deliver(merchant.id, paidEvent({
        artifactId: artifact.providerEntityId, referenceId: "rp_someone_else",
        amountPaise: artifact.amountPaise, attributionRef: "rp_not_ours",
        eventId: `evt_FOREIGN_${Date.now()}_${Math.random()}`,
      }));

      expect(processed?.attribution?.attributed).toBe(false);
      expect(await prisma.attributionRecord.count({ where: { merchantId: merchant.id } })).toBe(0);
      // Recovered revenue is untouched by a payment we cannot explain.
      expect((await getDashboardMetrics(merchant.id)).recoveredAmountPaise).toBe(0);
    });

    it("refuses when the amount does not match", async () => {
      const { merchant, artifact, fixture } = await executedScenario();
      const ref = (artifact.raw as { reference_id: string }).reference_id;
      const { processed } = await deliver(merchant.id, paidEvent({
        artifactId: artifact.providerEntityId, referenceId: ref,
        amountPaise: artifact.amountPaise * 3,
        attributionRef: fixture.intervention.attributionRef,
        eventId: `evt_WRONGAMT_${Date.now()}_${Math.random()}`,
      }));

      expect(processed?.attribution?.attributed).toBe(false);
      if (processed?.attribution?.attributed) return;
      expect(processed?.attribution?.reason).toBe("AMOUNT_MISMATCH");
      expect((await prisma.intervention.findUniqueOrThrow({
        where: { id: fixture.intervention.id },
      })).state).toBe("OBSERVING");
    });
  });

  describe("learning", () => {
    it("increments alpha exactly once on conversion", async () => {
      const { merchant, artifact, fixture } = await executedScenario();
      const before = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });
      const ref = (artifact.raw as { reference_id: string }).reference_id;

      await deliver(merchant.id, paidEvent({
        artifactId: artifact.providerEntityId, referenceId: ref,
        amountPaise: artifact.amountPaise, attributionRef: fixture.intervention.attributionRef,
      }));

      const after = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });
      // One observation is 1000 milli-units.
      expect(after.alphaMilli).toBe(before.alphaMilli + 1_000);
      expect(after.betaMilli).toBe(before.betaMilli);
      expect(after.observationCount).toBe(1);
      // The seeded values are preserved, so the movement stays visible.
      expect(after.seededAlphaMilli).toBe(before.seededAlphaMilli);
    });

    it("increments beta when the attribution window lapses", async () => {
      const { merchant, fixture } = await executedScenario();
      const before = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });

      const wellPast = new Date(MIDDAY.getTime() + 30 * 86_400_000);
      const { closed } = await closeLapsedObservations(merchant.id, {
        evaluatedAt: wellPast, windowDays: 14, client: prisma,
      });
      expect(closed).toBe(1);

      const after = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });
      // A non-conversion is evidence too.
      expect(after.betaMilli).toBe(before.betaMilli + 1_000);
      expect(after.alphaMilli).toBe(before.alphaMilli);
      expect((await prisma.intervention.findUniqueOrThrow({
        where: { id: fixture.intervention.id },
      })).state).toBe("LEARNED");
    });

    it("changes the base rate the next estimator run would read", async () => {
      const { merchant, artifact, fixture } = await executedScenario();
      const before = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });
      const rateBefore = before.alphaMilli / (before.alphaMilli + before.betaMilli);

      const ref = (artifact.raw as { reference_id: string }).reference_id;
      await deliver(merchant.id, paidEvent({
        artifactId: artifact.providerEntityId, referenceId: ref,
        amountPaise: artifact.amountPaise, attributionRef: fixture.intervention.attributionRef,
      }));

      const after = await prisma.playbookStat.findFirstOrThrow({ where: { merchantId: merchant.id } });
      const rateAfter = after.alphaMilli / (after.alphaMilli + after.betaMilli);
      // The direction follows the observed outcome; it is not hard-coded.
      expect(rateAfter).toBeGreaterThan(rateBefore);
    });
  });

  describe("revenue integrity", () => {
    it("moves recovered revenue only after a verified attributed payment", async () => {
      const { merchant, artifact, fixture } = await executedScenario();
      expect((await getDashboardMetrics(merchant.id)).recoveredAmountPaise).toBe(0);

      const ref = (artifact.raw as { reference_id: string }).reference_id;
      await deliver(merchant.id, paidEvent({
        artifactId: artifact.providerEntityId, referenceId: ref,
        amountPaise: artifact.amountPaise, attributionRef: fixture.intervention.attributionRef,
      }));

      const metrics = await getDashboardMetrics(merchant.id);
      expect(metrics.recoveredAmountPaise).toBe(artifact.amountPaise);
      expect(metrics.convertedInterventions).toBe(1);
    });

    it("does not overwrite the estimate or the opportunity amount", async () => {
      const { merchant, artifact, fixture } = await executedScenario();
      const estimateBefore = await prisma.estimate.findUniqueOrThrow({ where: { id: fixture.estimate.id } });
      const opportunityBefore = await prisma.opportunity.findUniqueOrThrow({ where: { id: fixture.opportunity.id } });

      const ref = (artifact.raw as { reference_id: string }).reference_id;
      await deliver(merchant.id, paidEvent({
        artifactId: artifact.providerEntityId, referenceId: ref,
        amountPaise: artifact.amountPaise, attributionRef: fixture.intervention.attributionRef,
      }));

      // Expected, potential and actual are different concepts and stay separate.
      const estimateAfter = await prisma.estimate.findUniqueOrThrow({ where: { id: fixture.estimate.id } });
      const opportunityAfter = await prisma.opportunity.findUniqueOrThrow({ where: { id: fixture.opportunity.id } });
      expect(estimateAfter.expectedNetPaise).toBe(estimateBefore.expectedNetPaise);
      expect(estimateAfter.expectedGrossPaise).toBe(estimateBefore.expectedGrossPaise);
      expect(opportunityAfter.recoverableAmountPaise).toBe(opportunityBefore.recoverableAmountPaise);
    });
  });

  describe("simulation", () => {
    it("enters through the webhook boundary and converts", async () => {
      const { merchant, artifact, fixture } = await executedScenario();
      const result = await simulatePaymentForArtifact(artifact.id, { client: prisma });

      expect(result.status).toBe("PROCESSED");
      // A real WebhookEvent row exists, signature-verified, marked simulated.
      const stored = await prisma.webhookEvent.findFirstOrThrow({ where: { merchantId: merchant.id } });
      expect(stored.signatureValid).toBe(true);
      expect((stored.headers as Record<string, string>)["x-revenuepilot-simulated"]).toBe("true");

      expect((await prisma.intervention.findUniqueOrThrow({
        where: { id: fixture.intervention.id },
      })).state).toBe("LEARNED");
    });

    it("cannot mark an intervention CONVERTED without attribution", async () => {
      // Break the link between artifact and target, so attribution must refuse.
      const { merchant, artifact, fixture } = await executedScenario();
      await prisma.razorpayArtifact.update({
        where: { id: artifact.id },
        data: { raw: { reference_id: "rp_unrelated_reference" } },
      });

      const result = await simulatePaymentForArtifact(artifact.id, { client: prisma });
      expect(result.status).toBe("PROCESSED");
      if (result.status !== "PROCESSED") return;
      expect(result.attribution?.attributed).toBe(false);

      // Still observing: the simulation has no shortcut.
      expect((await prisma.intervention.findUniqueOrThrow({
        where: { id: fixture.intervention.id },
      })).state).toBe("OBSERVING");
      expect(await prisma.attributionRecord.count({ where: { merchantId: merchant.id } })).toBe(0);
    });

    it("is harmless when replayed", async () => {
      const { merchant, artifact } = await executedScenario();
      await simulatePaymentForArtifact(artifact.id, { client: prisma });
      const second = await simulatePaymentForArtifact(artifact.id, { client: prisma });
      expect(second.status).toBe("DUPLICATE");
      expect(await prisma.attributionRecord.count({ where: { merchantId: merchant.id } })).toBe(1);
    });
  });

  it("writes a complete audit trail whose chain verifies", async () => {
    const { merchant, artifact, fixture } = await executedScenario();
    const ref = (artifact.raw as { reference_id: string }).reference_id;
    await deliver(merchant.id, paidEvent({
      artifactId: artifact.providerEntityId, referenceId: ref,
      amountPaise: artifact.amountPaise, attributionRef: fixture.intervention.attributionRef,
    }));

    const actions = (await prisma.auditLog.findMany({
      where: { merchantId: merchant.id }, orderBy: { seq: "asc" },
    })).map((entry) => entry.action);

    for (const action of [
      "WEBHOOK_RECEIVED", "ATTRIBUTION_SUCCEEDED", "TRANSACTION_RECOVERED",
      "INTERVENTION_CONVERTED", "PLAYBOOK_STAT_INCREMENTED",
    ]) {
      expect(actions).toContain(action);
    }
    expect((await verifyAuditChain(prisma, merchant.id)).valid).toBe(true);
  });
});
