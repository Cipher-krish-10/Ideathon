import "server-only";

import type {
  CustomerRecord,
  FailedPaymentRecoveryConfig,
  PaymentAttemptRecord,
  TransactionRecord,
} from "@/core/detectors";
import type { MerchantConfig } from "@/server/dataset/config";
import { toFailureReason } from "@/server/dataset/mappings";

/**
 * Translation between the database/config world and the detector's world.
 *
 * The detector is deliberately ignorant of Prisma types and of the dataset's
 * snake_case vocabulary. Everything it needs is converted here, once, in a
 * place that can be tested on its own.
 */

/** Shape returned by the repository reads this service performs. */
export interface DbCustomer {
  id: string;
  sourceRef: string;
  tier: string;
  lifetimeValuePaise: number;
  doNotContactUntil: Date | null;
}

export interface DbPaymentAttempt {
  id: string;
  sourceRef: string;
  transactionId: string;
  status: string;
  failureReason: string | null;
  attemptNo: number;
  occurredAt: Date;
}

export interface DbTransaction {
  id: string;
  sourceRef: string;
  customerId: string;
  amountPaise: number;
  occurredAt: Date;
}

/**
 * Build the detector's threshold configuration from merchant configuration.
 *
 * The config file states failure reasons in the dataset's snake_case tokens
 * ("expired_card"); the database stores the domain enum ("EXPIRED_CARD"). The
 * mapping is total and throws on an unknown token — a silently mis-mapped
 * reason would change which transactions qualify, which is precisely the kind
 * of quiet wrongness this product cannot afford.
 */
export function toDetectorConfig(config: MerchantConfig): FailedPaymentRecoveryConfig {
  const detector = config.detector_config;
  return {
    recoverableFailureReasons: detector.recoverable_failure_reasons.map(toFailureReason),
    recencyWindowDays: detector.recency_window_days,
    minTransactionAmountPaise: detector.min_transaction_amount_paise,
    minCustomerLifetimeValuePaise: detector.min_customer_lifetime_value_paise,
  };
}

export function toCustomerRecord(row: DbCustomer): CustomerRecord {
  return {
    id: row.id,
    sourceRef: row.sourceRef,
    tier: row.tier,
    lifetimeValuePaise: row.lifetimeValuePaise,
    doNotContactUntil: row.doNotContactUntil,
  };
}

export function toTransactionRecord(row: DbTransaction): TransactionRecord {
  return {
    id: row.id,
    sourceRef: row.sourceRef,
    customerId: row.customerId,
    amountPaise: row.amountPaise,
    occurredAt: row.occurredAt,
  };
}

export function toPaymentAttemptRecord(row: DbPaymentAttempt): PaymentAttemptRecord {
  // Status widens to the detector's own union. Anything outside SUCCESS/FAILED
  // is treated as PENDING, which the detector handles as "no failed attempt"
  // rather than as an implicit failure.
  const status =
    row.status === "SUCCESS" ? "SUCCESS" : row.status === "FAILED" ? "FAILED" : "PENDING";
  return {
    id: row.id,
    sourceRef: row.sourceRef,
    transactionId: row.transactionId,
    status,
    failureReason: row.failureReason,
    attemptNo: row.attemptNo,
    occurredAt: row.occurredAt,
  };
}
