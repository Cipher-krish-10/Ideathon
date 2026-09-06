/**
 * Payment provider boundary.
 *
 * An anti-corruption layer: nothing outside this directory knows Razorpay's
 * vocabulary, and the execution service depends only on this interface. Field
 * names here are OURS; the mapping to Razorpay's is in razorpay-provider.ts and
 * documented in docs/RAZORPAY_NOTES.md.
 */

/** Everything needed to create one payment link. All money is integer paise. */
export interface CreatePaymentLinkCommand {
  /** Amount the customer will actually pay, after any approved discount. */
  amountPaise: number;
  currency: string;
  description: string;
  /** Unique, stable across retries. Becomes Razorpay's `reference_id`. */
  referenceId: string;
  /** Intervention-level attribution anchor, carried in `notes`. */
  attributionRef: string;
  interventionId: string;
  /** Internal customer reference. NEVER a real name, email, or phone. */
  customerRef: string;
  expiresAt: Date;
}

export interface PaymentLinkArtifact {
  /** Provider entity id, e.g. plink_ERgihyaAAC0VNW */
  providerEntityId: string;
  shortUrl: string;
  amountPaise: number;
  currency: string;
  /** created | partially_paid | paid | expired | cancelled */
  status: string;
  referenceId: string;
  /** Verbatim provider response, for the audit trail. */
  raw: unknown;
  /** True when this link already existed and was adopted rather than created. */
  reconciled: boolean;
}

/**
 * How a failure should be treated.
 *
 * The distinction is the point: retrying a 4xx just asks the same rejected
 * question again, while retrying a timeout without reconciling first is how a
 * customer gets two payment links.
 */
export type ProviderErrorKind =
  | "TRANSIENT"      // network, 5xx, 429 — safe to retry after reconciling
  | "AMBIGUOUS"      // timeout: the call may have succeeded. Reconcile first.
  | "VALIDATION"     // 4xx — never retried
  | "AUTHENTICATION" // 401/403 — never retried
  | "MALFORMED"      // unparseable/unverifiable response
  | "CONFIGURATION"; // missing or refused credentials

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
    readonly httpStatus?: number,
    readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** Only these may be retried, and only after a reconciliation attempt. */
  get isRetryable(): boolean {
    return this.kind === "TRANSIENT" || this.kind === "AMBIGUOUS";
  }
}

export interface PaymentProvider {
  readonly name: string;
  /** Always "test" in this build. There is no live-mode code path. */
  readonly mode: "test";
  createPaymentLink(command: CreatePaymentLinkCommand): Promise<PaymentLinkArtifact>;
  /**
   * Find an existing link by reference.
   *
   * The safety net for an ambiguous failure: before retrying, ask whether the
   * previous call actually landed.
   */
  findPaymentLinkByReference(referenceId: string): Promise<PaymentLinkArtifact | null>;
}
