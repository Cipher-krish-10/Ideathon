import { createHmac, timingSafeEqual } from "node:crypto";

import type { NormalisedPayment } from "@/core/attribution";

/**
 * Razorpay webhook verification and normalisation.
 *
 * Verified against the live documentation on 2026-09-07:
 *   - signature header: `X-Razorpay-Signature`
 *   - event id header:  `x-razorpay-event-id`
 *   - algorithm: HMAC-SHA256 over the RAW request body, keyed by the webhook
 *     secret. The body must not be parsed before verification.
 *
 * Nothing outside this module knows Razorpay's payload shape. The rest of the
 * application sees a `NormalisedEvent`.
 */

export const SIGNATURE_HEADER = "x-razorpay-signature";
export const EVENT_ID_HEADER = "x-razorpay-event-id";

/**
 * Verify a webhook signature.
 *
 * Constant-time comparison: a fast-exit string compare leaks how much of a
 * forged signature was correct.
 */
export function verifyWebhookSignature(
  rawBody: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature || !secret) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(signature, "utf8");

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

/** Compute a signature. Used by the demo simulator to exercise the real path. */
export function signWebhookBody(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

/**
 * Internal event vocabulary.
 *
 * Only the events this MVP acts on. An unrecognised event is stored and
 * acknowledged, never guessed at.
 */
export type NormalisedEventType =
  | "PAYMENT_LINK_PAID"
  | "PAYMENT_CAPTURED"
  | "PAYMENT_FAILED"
  | "UNSUPPORTED";

export interface NormalisedEvent {
  type: NormalisedEventType;
  providerEventType: string;
  occurredAt: Date;
  /** Present for the events that carry a payment. */
  payment: NormalisedPayment | null;
  /** True when this event should drive attribution. */
  isSuccessfulPayment: boolean;
}

interface RazorpayEnvelope {
  entity?: string;
  event?: string;
  created_at?: number;
  payload?: {
    payment?: { entity?: RazorpayPaymentEntity };
    payment_link?: { entity?: RazorpayPaymentLinkEntity };
  };
}

interface RazorpayPaymentEntity {
  id?: string;
  amount?: number;
  currency?: string;
  status?: string;
  notes?: Record<string, string> | unknown[];
}

interface RazorpayPaymentLinkEntity {
  id?: string;
  reference_id?: string;
  amount?: number;
  amount_paid?: number;
  status?: string;
  notes?: Record<string, string> | unknown[];
}

/** Razorpay sends `notes` as an object, or as `[]` when empty. */
function readNote(notes: unknown, key: string): string | null {
  if (!notes || Array.isArray(notes) || typeof notes !== "object") return null;
  const value = (notes as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Turn a verified Razorpay event into our vocabulary.
 *
 * Amounts come from the event, never from our own estimate: the whole point of
 * waiting for provider evidence is that the provider says what was paid.
 */
export function normaliseWebhookEvent(parsed: unknown): NormalisedEvent {
  const envelope = (parsed ?? {}) as RazorpayEnvelope;
  const providerEventType = envelope.event ?? "unknown";
  const occurredAt = envelope.created_at
    ? new Date(envelope.created_at * 1_000)
    : new Date();

  const paymentEntity = envelope.payload?.payment?.entity;
  const linkEntity = envelope.payload?.payment_link?.entity;

  const buildPayment = (): NormalisedPayment | null => {
    if (!paymentEntity?.id || typeof paymentEntity.amount !== "number") return null;
    return {
      providerPaymentId: paymentEntity.id,
      amountPaise: paymentEntity.amount,
      currency: paymentEntity.currency ?? "INR",
      occurredAt,
      // reference_id lives on the payment link, not the payment.
      referenceId: linkEntity?.reference_id ?? null,
      attributionRef:
        readNote(linkEntity?.notes, "attribution_ref") ??
        readNote(paymentEntity.notes, "attribution_ref"),
      providerPaymentLinkId: linkEntity?.id ?? null,
    };
  };

  switch (providerEventType) {
    case "payment_link.paid": {
      const payment = buildPayment();
      return {
        type: "PAYMENT_LINK_PAID",
        providerEventType,
        occurredAt,
        payment,
        // Only a link that is actually `paid` counts.
        isSuccessfulPayment: payment !== null && linkEntity?.status === "paid",
      };
    }
    case "payment.captured": {
      const payment = buildPayment();
      return {
        type: "PAYMENT_CAPTURED",
        providerEventType,
        occurredAt,
        payment,
        isSuccessfulPayment: payment !== null && paymentEntity?.status === "captured",
      };
    }
    case "payment.failed":
      return {
        type: "PAYMENT_FAILED",
        providerEventType,
        occurredAt,
        payment: buildPayment(),
        isSuccessfulPayment: false,
      };
    default:
      // Stored and acknowledged, but never acted on.
      return {
        type: "UNSUPPORTED",
        providerEventType,
        occurredAt,
        payment: null,
        isSuccessfulPayment: false,
      };
  }
}
