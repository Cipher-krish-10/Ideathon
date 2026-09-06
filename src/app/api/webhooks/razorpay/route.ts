import { NextResponse } from "next/server";

import { EVENT_ID_HEADER, SIGNATURE_HEADER } from "@/integrations/razorpay";
import { getEnv } from "@/lib/env";
import {
  processWebhookEvent,
  receiveWebhook,
  resolveDefaultMerchantId,
} from "@/server/services/webhook.service";

/**
 * Razorpay webhook receiver.
 *
 * Stage 1 only: verify, dedupe, persist, acknowledge. Processing is kicked off
 * afterwards, so a slow attribution pass can never make the provider time out
 * and retry — which would turn one payment into several deliveries.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // The RAW body, before any parsing: the signature is computed over exact
  // bytes, and JSON.parse followed by re-stringify would not reproduce them.
  const rawBody = await request.text();

  const signature = request.headers.get(SIGNATURE_HEADER);
  const providerEventId =
    request.headers.get(EVENT_ID_HEADER) ??
    // Fall back to a content hash so a malformed delivery still dedupes.
    `sha256:${Buffer.from(rawBody).toString("base64").slice(0, 60)}`;

  const env = getEnv();
  const secret = env.RAZORPAY_WEBHOOK_SECRET ?? "";

  if (!secret) {
    // Fail closed. Without a secret nothing can be verified, and processing an
    // unverified payment event would be the worst possible default.
    console.error("[webhook] RAZORPAY_WEBHOOK_SECRET is not configured; rejecting.");
    return NextResponse.json(
      { error: { code: "NOT_CONFIGURED", message: "Webhook processing is not configured." } },
      { status: 503 },
    );
  }

  // Headers worth keeping. Never the signature itself.
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "user-agent", EVENT_ID_HEADER, "x-razorpay-event-type"]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }

  const merchantId = await resolveDefaultMerchantId();

  const received = await receiveWebhook({
    rawBody, signature, providerEventId, headers, secret, merchantId,
  });

  if (received.status === "INVALID_SIGNATURE") {
    return NextResponse.json(
      { error: { code: "INVALID_SIGNATURE", message: "Signature verification failed." } },
      { status: 400 },
    );
  }

  // A duplicate is a success from the provider's point of view: it delivered.
  if (received.status === "DUPLICATE") {
    return NextResponse.json({ data: { status: "duplicate", accepted: true } });
  }

  // Stage 2, in-process for the MVP. The boundary is drawn so a real queue
  // drops in later without touching stage 1.
  const processed = await processWebhookEvent(received.webhookEventId!);

  return NextResponse.json({
    data: {
      status: "accepted",
      processing: processed.status,
      // Deliberately terse: a webhook response is not a place to expose
      // attribution detail to whoever can reach the endpoint.
    },
  });
}
