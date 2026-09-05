/**
 * Dataset -> domain enum mappings.
 *
 * The approved dataset uses lowercase snake_case tokens (its own synthetic
 * taxonomy). The database uses uppercase Prisma enums. Every mapping is
 * explicit and total: an unrecognised token throws rather than silently
 * becoming UNKNOWN, because a quietly mis-mapped failure reason would change
 * which transactions the detector considers recoverable.
 *
 * Not shared with Razorpay's vocabulary. Provider codes are mapped onto this
 * taxonomy at ingest time, in the Razorpay adapter, in a later phase.
 */
import type {
  AttemptStatus,
  CustomerTier,
  FailureReason,
  PaymentMethod,
  PlaybookActionType,
  ProductCategory,
  SuppressionReason,
  TransactionStatus,
} from "@/generated/prisma/enums";

export class MappingError extends Error {
  constructor(kind: string, value: string) {
    super(`Unmapped ${kind} value from dataset: "${value}"`);
    this.name = "MappingError";
  }
}

function lookup<T>(kind: string, table: Record<string, T>, value: string): T {
  const mapped = table[value];
  if (mapped === undefined) {
    throw new MappingError(kind, value);
  }
  return mapped;
}

const CUSTOMER_TIER: Record<string, CustomerTier> = {
  HIGH: "HIGH",
  MEDIUM: "MEDIUM",
  LOW: "LOW",
};

const SUPPRESSION_REASON: Record<string, SuppressionReason> = {
  customer_opt_out: "CUSTOMER_OPT_OUT",
  chargeback_dispute: "CHARGEBACK_DISPUTE",
  support_escalation: "SUPPORT_ESCALATION",
};

const PRODUCT_CATEGORY: Record<string, ProductCategory> = {
  subscription: "SUBSCRIPTION",
  addon: "ADDON",
  service: "SERVICE",
  course: "COURSE",
  merch: "MERCH",
  hardware: "HARDWARE",
};

const PAYMENT_METHOD: Record<string, PaymentMethod> = {
  card: "CARD",
  upi: "UPI",
  netbanking: "NETBANKING",
  wallet: "WALLET",
};

const TRANSACTION_STATUS: Record<string, TransactionStatus> = {
  CAPTURED: "CAPTURED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
  PENDING: "PENDING",
};

const ATTEMPT_STATUS: Record<string, AttemptStatus> = {
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  PENDING: "PENDING",
};

const FAILURE_REASON: Record<string, FailureReason> = {
  insufficient_funds: "INSUFFICIENT_FUNDS",
  payment_network_error: "PAYMENT_NETWORK_ERROR",
  authentication_failed: "AUTHENTICATION_FAILED",
  payment_method_declined: "PAYMENT_METHOD_DECLINED",
  expired_card: "EXPIRED_CARD",
  suspected_fraud: "SUSPECTED_FRAUD",
  unknown: "UNKNOWN",
};

const PLAYBOOK_ACTION_TYPE: Record<string, PlaybookActionType> = {
  REMINDER_ONLY: "REMINDER_ONLY",
  PAYMENT_LINK_PLAIN: "PAYMENT_LINK_PLAIN",
  PAYMENT_LINK_WITH_OFFER: "PAYMENT_LINK_WITH_OFFER",
};

export const toCustomerTier = (v: string) => lookup("customer tier", CUSTOMER_TIER, v);
export const toSuppressionReason = (v: string) =>
  lookup("suppression reason", SUPPRESSION_REASON, v);
export const toProductCategory = (v: string) =>
  lookup("product category", PRODUCT_CATEGORY, v);
export const toPaymentMethod = (v: string) => lookup("payment method", PAYMENT_METHOD, v);
export const toTransactionStatus = (v: string) =>
  lookup("transaction status", TRANSACTION_STATUS, v);
export const toAttemptStatus = (v: string) => lookup("attempt status", ATTEMPT_STATUS, v);
export const toFailureReason = (v: string) => lookup("failure reason", FAILURE_REASON, v);
export const toPlaybookActionType = (v: string) =>
  lookup("playbook action type", PLAYBOOK_ACTION_TYPE, v);

/** Parse an integer paise field from CSV, rejecting anything non-integral. */
export function parsePaise(raw: string, field: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer number of paise, got "${raw}"`);
  }
  return value;
}

/** Parse an ISO 8601 timestamp, rejecting anything unparseable. */
export function parseTimestamp(raw: string, field: string): Date {
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw new Error(`${field} is not a valid timestamp: "${raw}"`);
  }
  return value;
}

/** Optional timestamp: empty string means absent. */
export function parseOptionalTimestamp(raw: string, field: string): Date | null {
  return raw === "" ? null : parseTimestamp(raw, field);
}
