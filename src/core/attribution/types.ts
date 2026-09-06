/**
 * Attribution: deciding which intervention, if any, caused a payment.
 *
 * The engine is pure and deliberately conservative. Crediting the wrong
 * intervention is worse than crediting none: it inflates a recovery figure the
 * merchant will act on, and it corrupts the learning signal that decides what
 * the agent does next. UNATTRIBUTED is a valid, visible answer.
 */

export type AttributionMethod = "DIRECT_REF" | "WINDOW_MATCH" | "MANUAL";
export type AttributionConfidence = "LOW" | "MEDIUM" | "HIGH";

/** Why attribution refused, so the UI can explain rather than shrug. */
export type UnattributedReason =
  | "NO_CANDIDATE_INTERVENTION"
  | "AMBIGUOUS_COMPETING_INTERVENTIONS"
  | "AMOUNT_MISMATCH"
  | "OUTSIDE_ATTRIBUTION_WINDOW"
  | "REFERENCE_UNKNOWN"
  | "ALREADY_ATTRIBUTED";

/** One payment link we created, and what it was for. */
export interface AttributionArtifact {
  providerEntityId: string;
  /** The reference sent to the provider — our per-target reference. */
  referenceId: string;
  /** Exactly what we asked the customer to pay, in integer paise. */
  amountPaise: number;
  transactionId: string;
  customerId: string;
}

/** An intervention that could plausibly explain a payment. */
export interface AttributionCandidate {
  interventionId: string;
  attributionRef: string;
  playbookId: string;
  state: string;
  executedAt: Date | null;
  artifacts: readonly AttributionArtifact[];
  /** Transactions already credited to this intervention. */
  alreadyAttributedTransactionIds: readonly string[];
}

/** A verified payment, normalised from a provider event. */
export interface NormalisedPayment {
  providerPaymentId: string;
  /** Amount actually paid, from the verified event. Never inferred. */
  amountPaise: number;
  currency: string;
  occurredAt: Date;
  /** payment_link.reference_id, when the event carried one. */
  referenceId: string | null;
  /** notes.attribution_ref, when the event carried one. */
  attributionRef: string | null;
  providerPaymentLinkId: string | null;
}

export interface AttributionConfig {
  /** How long after execution a payment may still be credited. */
  attributionWindowDays: number;
  /** Tolerance on amount matching, in basis points of the expected amount. */
  amountToleranceBps: number;
}

export type AttributionDecision =
  | {
      attributed: true;
      method: AttributionMethod;
      confidence: AttributionConfidence;
      interventionId: string;
      transactionId: string;
      customerId: string;
      attributedAmountPaise: number;
      reason: string;
    }
  | {
      attributed: false;
      reason: UnattributedReason;
      detail: string;
      /** Candidates considered, for the audit trail. */
      consideredInterventionIds: readonly string[];
    };
