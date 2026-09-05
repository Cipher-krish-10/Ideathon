export {
  DETECTOR_KEY,
  DETECTOR_VERSION,
  aggregateCandidates,
  detectFailedPaymentRecovery,
} from "./failed-payment-recovery";
export { EXCLUSION_REASONS } from "./types";
export type {
  AttemptStatusValue,
  CandidateEvidence,
  CustomerRecord,
  DetectionResult,
  DetectionScanSummary,
  DetectorInput,
  DetectorOptions,
  ExcludedTransaction,
  ExclusionReason,
  FailedPaymentRecoveryConfig,
  OpportunityAggregate,
  OpportunityCandidate,
  PaymentAttemptRecord,
  QualifyingCheck,
  TransactionRecord,
} from "./types";
