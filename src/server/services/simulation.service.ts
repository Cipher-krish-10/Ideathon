import "server-only";

import type { AttributionDecision } from "@/core/attribution";
import { signWebhookBody } from "@/integrations/razorpay";
import { getEnv } from "@/lib/env";
import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";
import { processWebhookEvent, receiveWebhook } from "./webhook.service";

/**
 * Demo payment simulation.
 *
 * Builds a Razorpay-shaped `payment_link.paid` event for a real artifact we
 * created, SIGNS it, and pushes it through the SAME receiver a genuine webhook
 * uses. Signature verification, dedupe, persistence, normalisation,
 * attribution, state transition and learning all run for real.
 *
 * It deliberately cannot mark an intervention CONVERTED itself. If attribution
 * refuses, the simulation yields an unattributed payment exactly as a real one
 * would — a demo affordance that could shortcut the evidence would make every
 * conversion in the demo meaningless.
 */

export type SimulationResult =
  | { status: "NOT_FOUND"; message: string }
  | { status: "NOT_SIMULATABLE"; message: string }
  | { status: "DUPLICATE"; message: string }
  | {
      status: "PROCESSED" | "ALREADY_PROCESSED" | "IGNORED" | "FAILED";
      simulated: true;
      attribution?: AttributionDecision;
      interventionState?: string;
      attributedAmountPaise?: number;
    };

export async function simulatePaymentForArtifact(
  artifactId: string,
  options: { client?: PrismaClient } = {},
): Promise<SimulationResult> {
  const db = options.client ?? prisma;
  const env = getEnv();

  const artifact = await db.razorpayArtifact.findUnique({
    where: { id: artifactId },
    include: { intervention: { select: { attributionRef: true } } },
  });
  if (!artifact) return { status: "NOT_FOUND", message: "Unknown payment link artifact." };

  const referenceId = (artifact.raw as { reference_id?: string } | null)?.reference_id;
  if (!referenceId) {
    return {
      status: "NOT_SIMULATABLE",
      message: "This artifact has no stored reference_id, so a realistic event cannot be built.",
    };
  }

  // Deterministic per artifact, so replaying is a genuine duplicate-delivery
  // test rather than a second payment.
  const providerPaymentId = `pay_SIM${artifact.providerEntityId.slice(-12)}`;
  const providerEventId = `evt_SIM${artifact.providerEntityId.slice(-12)}`;

  // The documented payment_link.paid envelope.
  const payload = {
    entity: "event",
    account_id: "acc_simulated",
    event: "payment_link.paid",
    contains: ["payment_link", "payment"],
    created_at: Math.floor(Date.now() / 1_000),
    payload: {
      payment_link: {
        entity: {
          id: artifact.providerEntityId,
          reference_id: referenceId,
          amount: artifact.amountPaise,
          amount_paid: artifact.amountPaise,
          status: "paid",
          notes: {
            attribution_ref: artifact.intervention.attributionRef,
            source: "revenuepilot",
          },
        },
      },
      payment: {
        entity: {
          id: providerPaymentId,
          amount: artifact.amountPaise,
          currency: "INR",
          status: "captured",
          notes: { attribution_ref: artifact.intervention.attributionRef },
        },
      },
    },
  };

  const rawBody = JSON.stringify(payload);
  const secret = env.RAZORPAY_WEBHOOK_SECRET ?? "revenuepilot_demo_webhook_secret";
  // Signed with the secret the receiver verifies against, so the signature path
  // is genuinely exercised rather than skipped.
  const signature = signWebhookBody(rawBody, secret);

  const received = await receiveWebhook({
    rawBody, signature, providerEventId, secret,
    merchantId: artifact.merchantId,
    headers: { "content-type": "application/json", "x-razorpay-event-id": providerEventId },
    simulated: true,
    client: db,
  });

  if (received.status === "DUPLICATE") {
    return {
      status: "DUPLICATE",
      message: "This payment was already delivered; nothing was double-counted.",
    };
  }

  const processed = await processWebhookEvent(received.webhookEventId!, { client: db });
  return {
    status: processed.status,
    simulated: true,
    ...(processed.attribution ? { attribution: processed.attribution } : {}),
    ...(processed.interventionState ? { interventionState: processed.interventionState } : {}),
    ...(processed.attributedAmountPaise === undefined
      ? {}
      : { attributedAmountPaise: processed.attributedAmountPaise }),
  };
}
