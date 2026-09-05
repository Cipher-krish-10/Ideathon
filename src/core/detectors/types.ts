/**
 * Types for the deterministic detection layer.
 *
 * Framework-free by construction: no Prisma, no Next, no network, no LLM. The
 * detector receives plain records and returns plain records, which is what makes
 * it exhaustively testable without a database.
 *
 * Dates arrive as `Date`; money as integer paise.
 */

/** Why a transaction did not become a candidate. */
export type ExclusionReason =
  /** A later attempt succeeded — the money is already collected. */
  | "ALREADY_RECOVERED"
  /** The operative failure reason is not in the merchant's recoverable set. */
  | "NON_RECOVERABLE_FAILURE"
  /** The failure is older than the configured recency window. */
  | "OUTSIDE_RECENCY_WINDOW"
  /** Transaction value is below the minimum worth chasing. */
  | "BELOW_TICKET_FLOOR"
  /** Customer lifetime value is below the configured minimum. */
  | "BELOW_LTV_FLOOR"
  /** Customer is under an active do-not-contact suppression. */
  | "SUPPRESSED"
  /**
   * The transaction has no FAILED attempt at all — an empty or PENDING-only
   * chain. Not a business exclusion; a data-shape one.
   */
  | "NO_FAILED_ATTEMPTS"
  /**
   * Evidence needed to decide is missing or contradictory: no customer record,
   * or a FAILED attempt carrying no failure reason. The detector never
   * qualifies a transaction it cannot fully justify.
   */
  | "INCOMPLETE_EVIDENCE";

export const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "ALREADY_RECOVERED",
  "NON_RECOVERABLE_FAILURE",
  "OUTSIDE_RECENCY_WINDOW",
  "BELOW_TICKET_FLOOR",
  "BELOW_LTV_FLOOR",
  "SUPPRESSED",
  "NO_FAILED_ATTEMPTS",
  "INCOMPLETE_EVIDENCE",
] as const;

/** Checks a candidate cleared, recorded so the UI can show the reasoning. */
export type QualifyingCheck =
  | "NO_SUCCESSFUL_ATTEMPT"
  | "RECOVERABLE_FAILURE_REASON"
  | "WITHIN_RECENCY_WINDOW"
  | "MEETS_TICKET_FLOOR"
  | "MEETS_LTV_FLOOR"
  | "CONTACTABLE";

export type AttemptStatusValue = "SUCCESS" | "FAILED" | "PENDING";

export interface CustomerRecord {
  id: string;
  /** Dataset identifier, e.g. "cust_0001". Carried for traceability. */
  sourceRef: string;
  tier: string;
  lifetimeValuePaise: number;
  /** A date, not a flag. An expired suppression does not suppress. */
  doNotContactUntil: Date | null;
}

export interface PaymentAttemptRecord {
  id: string;
  sourceRef: string;
  transactionId: string;
  status: AttemptStatusValue;
  /**
   * Domain vocabulary (e.g. "EXPIRED_CARD"), not the provider's. The service
   * layer maps configuration tokens into this vocabulary before calling in.
   */
  failureReason: string | null;
  attemptNo: number;
  occurredAt: Date;
}

export interface TransactionRecord {
  id: string;
  sourceRef: string;
  customerId: string;
  amountPaise: number;
  occurredAt: Date;
}

/**
 * Thresholds from merchant configuration.
 *
 * Passed in rather than imported, so the detector holds no policy of its own —
 * a merchant can change these without a code change, and tests can vary them
 * freely.
 */
export interface FailedPaymentRecoveryConfig {
  /** Domain-vocabulary failure reasons treated as worth re-soliciting. */
  recoverableFailureReasons: readonly string[];
  recencyWindowDays: number;
  minTransactionAmountPaise: number;
  minCustomerLifetimeValuePaise: number;
}

export interface DetectorInput {
  /** The "as of" instant. Recency and suppression are judged against this,
   *  never the wall clock, or results stop being reproducible. */
  referenceAt: Date;
  config: FailedPaymentRecoveryConfig;
  customers: readonly CustomerRecord[];
  transactions: readonly TransactionRecord[];
  /** Flat; the detector groups them by transaction itself. */
  paymentAttempts: readonly PaymentAttemptRecord[];
}

export interface DetectorOptions {
  /**
   * Retain a full record for every excluded transaction. Counts are always
   * returned; this adds the per-row detail the demo uses to show that the
   * agent discriminated rather than merely counted failed payments.
   */
  diagnostics?: boolean;
}

/** Observed facts that justified qualification. No projections. */
export interface CandidateEvidence {
  checksPassed: readonly QualifyingCheck[];
  observed: {
    amountPaise: number;
    minTransactionAmountPaise: number;
    customerLifetimeValuePaise: number;
    minCustomerLifetimeValuePaise: number;
    failureAgeDays: number;
    recencyWindowDays: number;
    recoverableFailureReasons: readonly string[];
  };
}

/**
 * One qualifying transaction.
 *
 * Deliberately contains no probability, expected revenue, cost, ROI, playbook,
 * or rationale. Those are the estimator's and the reasoner's outputs, in later
 * phases; mixing them in here is how a detector starts quietly inventing money.
 */
export interface OpportunityCandidate {
  transactionId: string;
  transactionRef: string;
  customerId: string;
  customerRef: string;
  amountPaise: number;
  /** From the LAST failed attempt — the operative one. */
  lastFailureReason: string;
  failedAttemptCount: number;
  totalAttemptCount: number;
  /** When the operative failed attempt occurred. */
  attemptedAt: Date;
  transactionOccurredAt: Date;
  /** Whole days between the operative failure and the reference instant. */
  failureAgeDays: number;
  customerTier: string;
  customerLifetimeValuePaise: number;
  /** The specific attempt the decision rests on, for traceability. */
  operativeAttemptId: string;
  operativeAttemptRef: string;
  evidence: CandidateEvidence;
}

export interface ExcludedTransaction {
  transactionId: string;
  transactionRef: string;
  customerId: string;
  amountPaise: number;
  reason: ExclusionReason;
  /** Human-readable specifics, e.g. observed value vs threshold. */
  detail: string;
}

/** Counted evidence only — every field is a tally or a sum of observed rows. */
export interface OpportunityAggregate {
  qualifyingTransactionCount: number;
  /** Distinct customers, not attempts and not transactions. */
  affectedCustomerCount: number;
  recoverableAmountPaise: number;
  failureReasonBreakdown: Record<string, number>;
  tierBreakdown: Record<string, number>;
  targetTransactionIds: readonly string[];
  targetCustomerIds: readonly string[];
}

export interface DetectionScanSummary {
  transactionsScanned: number;
  paymentAttemptsScanned: number;
  customersScanned: number;
  /** Transactions with no successful attempt — the pool worth judging. */
  unpaidTransactions: number;
  /** Attempts referencing a transaction not present in the input. */
  orphanedPaymentAttempts: number;
}

export interface DetectionResult {
  detectorKey: string;
  detectorVersion: string;
  referenceAt: Date;
  /** referenceAt minus the recency window. Failures before this are stale. */
  recencyCutoff: Date;
  scan: DetectionScanSummary;
  candidates: readonly OpportunityCandidate[];
  /** Always populated, for every reason, including zeros. */
  exclusionCounts: Record<ExclusionReason, number>;
  /** Populated only when `diagnostics` is enabled. */
  excluded: readonly ExcludedTransaction[];
  aggregate: OpportunityAggregate;
}
