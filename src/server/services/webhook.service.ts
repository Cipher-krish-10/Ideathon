import "server-only";

import type { AttributionCandidate, AttributionDecision, NormalisedPayment } from "@/core/attribution";
import { attributePayment } from "@/core/attribution";
import type { Prisma } from "@/generated/prisma/client";
import { normaliseWebhookEvent, verifyWebhookSignature } from "@/integrations/razorpay";
import type { NormalisedEvent } from "@/integrations/razorpay";
import { appendAuditEntry } from "@/server/audit/audit-logger";
import { loadMerchantConfig } from "@/server/dataset/config";
import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";
import { transitionIntervention } from "./intervention-state.service";
import { learnFromOutcome } from "./learning.service";

/**
 * Webhook receipt and processing, in two deliberately separate stages.
 *
 * STAGE 1 (receive): verify the signature over the RAW body, dedupe on the
 * provider event id, persist verbatim, acknowledge. Fast and near-infallible —
 * a provider that does not get a 2xx will retry, and a slow receiver turns one
 * payment into a storm.
 *
 * STAGE 2 (process): normalise, update the transaction, attribute, transition,
 * learn. Idempotent and replayable, because webhooks arrive twice, out of
 * order, and late.
 *
 * Conflating the two is the classic way to lose events.
 */

export interface ReceiveResult {
  status: "ACCEPTED" | "DUPLICATE" | "INVALID_SIGNATURE";
  webhookEventId: string | null;
  providerEventId: string;
}

/** Stage 1. Never performs attribution. */
export async function receiveWebhook(args: {
  rawBody: string;
  signature: string | null;
  providerEventId: string;
  headers: Record<string, string>;
  secret: string;
  merchantId: string | null;
  client?: PrismaClient;
  /** Marks demo-simulated events so the UI can label them honestly. */
  simulated?: boolean;
}): Promise<ReceiveResult> {
  const db = args.client ?? prisma;

  // Verified over the raw bytes, before any parsing.
  const signatureValid = verifyWebhookSignature(args.rawBody, args.signature, args.secret);

  // Dedupe on the provider's own event id, per the documented header.
  const existing = await db.webhookEvent.findUnique({
    where: { providerEventId: args.providerEventId },
    select: { id: true },
  });
  if (existing) {
    if (args.merchantId) {
      await audit(db, args.merchantId, {
        entityType: "WebhookEvent", entityId: existing.id,
        action: "WEBHOOK_DUPLICATE_IGNORED",
        after: { providerEventId: args.providerEventId },
      });
    }
    return { status: "DUPLICATE", webhookEventId: existing.id, providerEventId: args.providerEventId };
  }

  let eventType = "unknown";
  try {
    eventType = (JSON.parse(args.rawBody) as { event?: string }).event ?? "unknown";
  } catch {
    eventType = "unparseable";
  }

  const stored = await db.webhookEvent.create({
    data: {
      merchantId: args.merchantId,
      providerEventId: args.providerEventId,
      eventType,
      signatureValid,
      // Stored verbatim: a rejected event is evidence, not rubbish.
      rawBody: args.rawBody,
      headers: {
        ...args.headers,
        ...(args.simulated ? { "x-revenuepilot-simulated": "true" } : {}),
      } as Prisma.InputJsonObject,
      ...(signatureValid ? {} : { processingError: "Signature verification failed" }),
    },
    select: { id: true },
  });

  if (args.merchantId) {
    await audit(db, args.merchantId, {
      entityType: "WebhookEvent", entityId: stored.id,
      action: signatureValid ? "WEBHOOK_RECEIVED" : "WEBHOOK_SIGNATURE_REJECTED",
      after: { providerEventId: args.providerEventId, eventType, signatureValid, simulated: Boolean(args.simulated) },
    });
  }

  // An unverified event is never processed.
  if (!signatureValid) {
    return { status: "INVALID_SIGNATURE", webhookEventId: stored.id, providerEventId: args.providerEventId };
  }
  return { status: "ACCEPTED", webhookEventId: stored.id, providerEventId: args.providerEventId };
}

export interface ProcessResult {
  status: "PROCESSED" | "ALREADY_PROCESSED" | "IGNORED" | "FAILED";
  webhookEventId: string;
  event?: NormalisedEvent;
  attribution?: AttributionDecision;
  interventionId?: string;
  interventionState?: string;
  attributedAmountPaise?: number;
  error?: string;
}

/**
 * Stage 2. Safe to replay.
 *
 * Guarded by `processedAt`, and by unique constraints beneath it: replaying an
 * event must never double-count revenue, double-transition an intervention, or
 * increment a learning counter twice.
 */
export async function processWebhookEvent(
  webhookEventId: string,
  options: { client?: PrismaClient; evaluatedAt?: Date } = {},
): Promise<ProcessResult> {
  const db = options.client ?? prisma;
  const evaluatedAt = options.evaluatedAt ?? new Date();

  const stored = await db.webhookEvent.findUnique({ where: { id: webhookEventId } });
  if (!stored) throw new Error(`Unknown webhook event: ${webhookEventId}`);

  if (stored.processedAt) {
    return { status: "ALREADY_PROCESSED", webhookEventId };
  }
  if (!stored.signatureValid) {
    return { status: "IGNORED", webhookEventId, error: "Signature was not valid." };
  }

  try {
    const event = normaliseWebhookEvent(JSON.parse(stored.rawBody));

    if (!event.isSuccessfulPayment || !event.payment) {
      await db.webhookEvent.update({
        where: { id: webhookEventId },
        data: { processedAt: evaluatedAt },
      });
      return { status: "IGNORED", webhookEventId, event };
    }

    const merchantId = stored.merchantId ?? (await resolveMerchant(db, event.payment));
    if (!merchantId) {
      await db.webhookEvent.update({
        where: { id: webhookEventId },
        data: { processedAt: evaluatedAt, processingError: "Could not resolve a merchant." },
      });
      return { status: "IGNORED", webhookEventId, event, error: "Could not resolve a merchant." };
    }

    const outcome = await applySuccessfulPayment(db, {
      merchantId, webhookEventId, payment: event.payment, evaluatedAt,
    });

    await db.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processedAt: evaluatedAt, merchantId },
    });

    return { status: "PROCESSED", webhookEventId, event, ...outcome };
  } catch (error) {
    // The event is kept; only the failure is recorded, so it can be replayed.
    await db.webhookEvent.update({
      where: { id: webhookEventId },
      data: { processingError: (error as Error).message.slice(0, 1_000) },
    });
    return { status: "FAILED", webhookEventId, error: (error as Error).message };
  }
}

/**
 * Update the transaction, attribute the payment, transition, and learn.
 *
 * Attribution decides; nothing here overrides it. An unattributed payment still
 * updates the transaction — the money genuinely arrived — but credits no
 * intervention and moves no recovered-revenue figure.
 */
async function applySuccessfulPayment(
  db: PrismaClient,
  args: {
    merchantId: string;
    webhookEventId: string;
    payment: NormalisedPayment;
    evaluatedAt: Date;
  },
): Promise<{
  attribution: AttributionDecision;
  interventionId?: string;
  interventionState?: string;
  attributedAmountPaise?: number;
}> {
  const { merchantId, payment, evaluatedAt } = args;
  const config = loadMerchantConfig();

  // ---- Candidates: executed interventions that could explain this payment --
  const interventions = await db.intervention.findMany({
    where: { merchantId, state: { in: ["EXECUTED", "OBSERVING"] } },
    include: {
      razorpayArtifacts: true,
      targets: { select: { transactionId: true, customerId: true, perTargetRef: true } },
      attributionRecords: { select: { transactionId: true } },
    },
  });

  const candidates: AttributionCandidate[] = interventions.map((intervention) => {
    const targetByRef = new Map(intervention.targets.map((target) => [target.perTargetRef, target]));

    return {
      interventionId: intervention.id,
      attributionRef: intervention.attributionRef,
      playbookId: intervention.playbookId,
      state: intervention.state,
      executedAt: intervention.executedAt,
      // Each artifact carries the per-target reference we minted, so the link
      // back to a transaction is explicit rather than inferred from amounts.
      artifacts: intervention.razorpayArtifacts.flatMap((artifact) => {
        const referenceId = (artifact.raw as { reference_id?: string } | null)?.reference_id;
        const target = referenceId ? targetByRef.get(referenceId) : undefined;
        if (!referenceId || !target) return [];
        return [{
          providerEntityId: artifact.providerEntityId,
          referenceId,
          amountPaise: artifact.amountPaise,
          transactionId: target.transactionId,
          customerId: target.customerId,
        }];
      }),
      alreadyAttributedTransactionIds: intervention.attributionRecords.map((r) => r.transactionId),
    };
  });

  const decision = attributePayment(payment, candidates, {
    attributionWindowDays: config.estimator_config.attribution_window_days,
    amountToleranceBps: 100, // 1%
  });

  await audit(db, merchantId, {
    entityType: "WebhookEvent", entityId: args.webhookEventId,
    action: decision.attributed ? "ATTRIBUTION_SUCCEEDED" : "ATTRIBUTION_UNRESOLVED",
    after: decision.attributed
      ? {
          method: decision.method, confidence: decision.confidence,
          interventionId: decision.interventionId,
          attributedAmountPaise: decision.attributedAmountPaise,
        }
      : { reason: decision.reason, detail: decision.detail, considered: decision.consideredInterventionIds },
  });

  if (!decision.attributed) return { attribution: decision };

  // ---- Transaction: record what the provider says actually happened -------
  await db.transaction.update({
    where: { id: decision.transactionId },
    data: {
      status: "CAPTURED",
      settledAt: payment.occurredAt,
      // The original failed attempts are preserved: a recovery adds a
      // successful attempt to the chain, it does not rewrite the evidence.
    },
  });
  await db.paymentAttempt.create({
    data: {
      merchantId, transactionId: decision.transactionId, customerId: decision.customerId,
      sourceRef: `pa_recovered_${payment.providerPaymentId}`,
      amountPaise: payment.amountPaise, status: "SUCCESS", method: "CARD",
      attemptNo: await nextAttemptNo(db, decision.transactionId),
      gatewayRef: payment.providerPaymentId, occurredAt: payment.occurredAt,
    },
  }).catch(() => undefined); // A replay would violate [transactionId, attemptNo].

  await audit(db, merchantId, {
    entityType: "Transaction", entityId: decision.transactionId,
    action: "TRANSACTION_RECOVERED",
    after: { providerPaymentId: payment.providerPaymentId, amountPaise: payment.amountPaise },
  });

  // ---- AttributionRecord: unique on [interventionId, transactionId] -------
  await db.attributionRecord.create({
    data: {
      merchantId, interventionId: decision.interventionId,
      transactionId: decision.transactionId, webhookEventId: args.webhookEventId,
      method: decision.method, confidence: decision.confidence,
      attributedAmountPaise: decision.attributedAmountPaise,
      note: decision.reason, attributedAt: evaluatedAt,
    },
  });

  // ---- OBSERVING -> CONVERTED -> LEARNED ---------------------------------
  const intervention = await db.intervention.findUniqueOrThrow({
    where: { id: decision.interventionId }, select: { state: true, version: true, playbookId: true },
  });

  let state = intervention.state;
  let version = intervention.version;

  if (state === "EXECUTED") {
    const observing = await transitionIntervention(decision.interventionId, {
      to: "OBSERVING", expectedVersion: version, actorType: "WEBHOOK",
      action: "OBSERVING_STARTED", evaluatedAt, client: db,
    });
    state = "OBSERVING";
    version = observing.version;
  }

  if (state === "OBSERVING") {
    const converted = await transitionIntervention(decision.interventionId, {
      to: "CONVERTED", expectedVersion: version, actorType: "WEBHOOK",
      action: "INTERVENTION_CONVERTED",
      metadata: {
        method: decision.method, confidence: decision.confidence,
        attributedAmountPaise: decision.attributedAmountPaise,
        providerPaymentId: payment.providerPaymentId,
      },
      data: { closedAt: evaluatedAt }, evaluatedAt, client: db,
    });
    version = converted.version;
    state = "CONVERTED";

    // LEARNED is terminal, so this runs exactly once per intervention.
    const learned = await learnFromOutcome(decision.interventionId, {
      outcome: "CONVERTED",
      // Only the payer's cohort learns from this payment.
      convertedTransactionId: decision.transactionId,
      expectedVersion: version, evaluatedAt, client: db,
    });
    version = learned.version;
    state = "LEARNED";
  }

  return {
    attribution: decision,
    interventionId: decision.interventionId,
    interventionState: state,
    attributedAmountPaise: decision.attributedAmountPaise,
  };
}

/** The demo merchant. Multi-tenant routing by account id is a later concern. */
export async function resolveDefaultMerchantId(
  client: PrismaClient = prisma,
): Promise<string | null> {
  const merchant = await client.merchant.findFirst({
    orderBy: { createdAt: "asc" }, select: { id: true },
  });
  return merchant?.id ?? null;
}

/** Resolve the merchant from an artifact we created. */
async function resolveMerchant(
  db: PrismaClient,
  payment: NormalisedPayment,
): Promise<string | null> {
  if (payment.providerPaymentLinkId) {
    const artifact = await db.razorpayArtifact.findFirst({
      where: { providerEntityId: payment.providerPaymentLinkId },
      select: { merchantId: true },
    });
    if (artifact) return artifact.merchantId;
  }
  const merchant = await db.merchant.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  return merchant?.id ?? null;
}

async function nextAttemptNo(db: PrismaClient, transactionId: string): Promise<number> {
  const highest = await db.paymentAttempt.findFirst({
    where: { transactionId }, orderBy: { attemptNo: "desc" }, select: { attemptNo: true },
  });
  return (highest?.attemptNo ?? 0) + 1;
}

async function audit(
  db: PrismaClient,
  merchantId: string,
  args: { entityType: string; entityId: string; action: string; after?: unknown },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await appendAuditEntry(tx, {
      merchantId, actorType: "WEBHOOK", entityType: args.entityType,
      entityId: args.entityId, action: args.action, after: args.after,
    });
  });
}
