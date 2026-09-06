import "server-only";

import {
  ProviderError,
  type CreatePaymentLinkCommand,
  type PaymentLinkArtifact,
  type PaymentProvider,
} from "./types";

/**
 * Razorpay Test Mode adapter.
 *
 * The ONLY module that holds Razorpay credentials. They are read here, sent as
 * a Basic auth header, and never placed in a prompt, a log line, an audit
 * entry, an API response, or a stored request body.
 *
 * Every field below was verified against the live documentation on 2026-09-06;
 * the mapping table is in docs/RAZORPAY_NOTES.md. Nothing undocumented is sent.
 *
 * Raw fetch rather than the SDK: the REST contract is what was verified, so the
 * code matches the docs exactly, and the one credential-holding module carries
 * no dependency whose serialisation would have to be trusted.
 */
const API_BASE = "https://api.razorpay.com/v1";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Razorpay's documented error envelope. */
interface RazorpayErrorBody {
  error?: { code?: string; description?: string; reason?: string };
}

interface RazorpayPaymentLink {
  id?: string;
  short_url?: string;
  amount?: number;
  currency?: string;
  status?: string;
  reference_id?: string;
  notes?: Record<string, string>;
}

export interface RazorpayProviderOptions {
  keyId: string;
  keySecret: string;
  /** Must be the literal "test". There is no live-mode path. */
  mode: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class RazorpayProvider implements PaymentProvider {
  readonly name = "razorpay";
  readonly mode = "test" as const;

  private readonly authHeader: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RazorpayProviderOptions) {
    // ---- Test-mode gate. Fails closed, in this order. --------------------
    if (options.mode !== "test") {
      throw new ProviderError(
        `RAZORPAY_MODE must be explicitly "test"; received "${options.mode}". ` +
          "This build has no live-mode code path.",
        "CONFIGURATION",
      );
    }
    if (!options.keyId || !options.keySecret) {
      throw new ProviderError(
        "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are both required to enable Razorpay execution.",
        "CONFIGURATION",
      );
    }
    // Defence in depth. Razorpay does NOT document a key-prefix convention, so
    // this observed pattern is used ONLY to refuse -- never to permit. It can
    // make the gate stricter; it can never make it looser.
    if (options.keyId.startsWith("rzp_live_")) {
      throw new ProviderError(
        "The configured key id looks like a live key. RevenuePilot refuses to run against live mode.",
        "CONFIGURATION",
      );
    }

    this.authHeader = `Basic ${Buffer.from(`${options.keyId}:${options.keySecret}`).toString("base64")}`;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Create one payment link.
   *
   * `reference_id` is the caller's stable per-target reference: Razorpay
   * enforces its uniqueness, which is what makes retries safe.
   */
  async createPaymentLink(command: CreatePaymentLinkCommand): Promise<PaymentLinkArtifact> {
    const body = {
      // Documented: amount is in the smallest currency unit. Our money is
      // already integer paise, so this is a pass-through with no conversion.
      amount: command.amountPaise,
      currency: command.currency,
      description: command.description,
      reference_id: command.referenceId,
      expire_by: Math.floor(command.expiresAt.getTime() / 1000),
      // Razorpay must not contact anyone: this is a demo working from masked
      // data, and outbound messaging is not something it should be able to do.
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: {
        attribution_ref: command.attributionRef,
        intervention_id: command.interventionId,
        target_ref: command.referenceId,
        customer_ref: command.customerRef,
        source: "revenuepilot",
      },
      // customer{} is deliberately omitted: the dataset holds only masked
      // contact details, and sending a mask would be sending junk.
    };

    const response = await this.request("POST", "/payment_links", body);
    return this.toArtifact(response, command.referenceId, false);
  }

  /**
   * Look up a link by reference.
   *
   * The safety net for an ambiguous failure: before retrying, ask whether the
   * previous attempt actually landed.
   */
  async findPaymentLinkByReference(referenceId: string): Promise<PaymentLinkArtifact | null> {
    const query = new URLSearchParams({ reference_id: referenceId });
    const response = (await this.request("GET", `/payment_links?${query.toString()}`)) as {
      payment_links?: RazorpayPaymentLink[];
    };

    const found = response.payment_links?.[0];
    if (!found) return null;
    return this.toArtifact(found, referenceId, true);
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw this.toProviderError(response.status, payload as RazorpayErrorBody);
      }
      return payload;
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if ((error as Error).name === "AbortError") {
        // The call may have succeeded before we gave up. Never retried blindly.
        throw new ProviderError(
          `Razorpay request timed out after ${this.timeoutMs}ms. The call may have succeeded; ` +
            "reconcile by reference before retrying.",
          "AMBIGUOUS",
        );
      }
      throw new ProviderError(
        `Razorpay request failed: ${(error as Error).message}`,
        "TRANSIENT",
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Map an HTTP status to a retry decision. */
  private toProviderError(status: number, body: RazorpayErrorBody): ProviderError {
    const description = body.error?.description ?? "no description provided";
    const detail = `Razorpay returned ${status}: ${description}`;

    if (status === 401 || status === 403) {
      return new ProviderError(detail, "AUTHENTICATION", status, body);
    }
    if (status === 429 || status >= 500) {
      return new ProviderError(detail, "TRANSIENT", status, body);
    }
    // Every other 4xx is a rejected request. Asking again changes nothing.
    return new ProviderError(detail, "VALIDATION", status, body);
  }

  /**
   * Convert a response into an artifact, verifying it says what we expect.
   *
   * A response we cannot verify is a MALFORMED failure rather than an artifact:
   * persisting a half-understood payment link is worse than failing.
   */
  private toArtifact(
    payload: unknown,
    expectedReferenceId: string,
    reconciled: boolean,
  ): PaymentLinkArtifact {
    const link = payload as RazorpayPaymentLink;

    if (!link || typeof link.id !== "string" || typeof link.short_url !== "string") {
      throw new ProviderError(
        "Razorpay response did not contain the expected id and short_url.",
        "MALFORMED",
        undefined,
        payload,
      );
    }
    if (typeof link.amount !== "number" || !Number.isInteger(link.amount)) {
      throw new ProviderError(
        "Razorpay response did not contain an integer amount.",
        "MALFORMED",
        undefined,
        payload,
      );
    }
    if (link.reference_id !== expectedReferenceId) {
      // Attributing a payment to the wrong intervention is worse than failing.
      throw new ProviderError(
        `Razorpay returned reference_id "${link.reference_id}" but "${expectedReferenceId}" was sent.`,
        "MALFORMED",
        undefined,
        payload,
      );
    }

    return {
      providerEntityId: link.id,
      shortUrl: link.short_url,
      amountPaise: link.amount,
      currency: link.currency ?? "INR",
      status: link.status ?? "created",
      referenceId: link.reference_id,
      raw: payload,
      reconciled,
    };
  }
}
