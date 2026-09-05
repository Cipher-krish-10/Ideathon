/**
 * FailedPaymentRecoveryDetector — RevenuePilot's first intelligence component.
 *
 * Finds failed transactions that are still plausibly recoverable, by reading
 * raw evidence and applying merchant-configured thresholds. Nothing here is
 * learned, predicted, or asked of a model.
 *
 * WHAT THIS IS NOT:
 *   No `recoverable` column is read — the dataset deliberately contains none.
 *   No probability, expected revenue, cost, ROI, or playbook is produced.
 *   No I/O, no clock read, no randomness, no mutation of its inputs.
 *
 * The output is COUNTED EVIDENCE. The estimator turns it into money, later,
 * and the LLM never touches either.
 *
 * OPERATES PER TRANSACTION, NOT PER ATTEMPT. A transaction with four failed
 * attempts is one opportunity worth one ticket, not four.
 */
import type {
  CandidateEvidence,
  CustomerRecord,
  DetectionResult,
  DetectorInput,
  DetectorOptions,
  ExcludedTransaction,
  ExclusionReason,
  OpportunityAggregate,
  OpportunityCandidate,
  PaymentAttemptRecord,
  QualifyingCheck,
} from "./types";
import { EXCLUSION_REASONS } from "./types";

export const DETECTOR_KEY = "FAILED_PAYMENT_RECOVERY";

/**
 * Semantic version of the detection rules.
 *
 * Persisted on every Opportunity. Changing what qualifies — a new rule, a
 * reordering, a different operative-attempt choice — REQUIRES bumping this.
 * Historical opportunities must stay explainable by the version that produced
 * them.
 */
export const DETECTOR_VERSION = "failed-payment-recovery:v1";

const MS_PER_DAY = 86_400_000;

/**
 * Order attempts within a transaction.
 *
 * `attemptNo` is authoritative and unique per transaction in the database.
 * The fallbacks matter only for hand-built inputs, and exist so the result is
 * total-ordered regardless: an ambiguous chain must not produce a different
 * answer on a different run.
 */
function compareAttempts(a: PaymentAttemptRecord, b: PaymentAttemptRecord): number {
  if (a.attemptNo !== b.attemptNo) return a.attemptNo - b.attemptNo;
  const timeDelta = a.occurredAt.getTime() - b.occurredAt.getTime();
  if (timeDelta !== 0) return timeDelta;
  return a.id.localeCompare(b.id);
}

/**
 * Whole days between an earlier instant and the reference instant.
 *
 * Exported because the estimator's recency modifier must measure age exactly as
 * the detector did. Two private copies of this would drift apart eventually,
 * and the divergence would show up as an unexplainable probability.
 */
export function failureAgeInDays(occurredAt: Date, referenceAt: Date): number {
  return Math.floor((referenceAt.getTime() - occurredAt.getTime()) / MS_PER_DAY);
}

function emptyExclusionCounts(): Record<ExclusionReason, number> {
  const counts = {} as Record<ExclusionReason, number>;
  for (const reason of EXCLUSION_REASONS) counts[reason] = 0;
  return counts;
}

/**
 * Run the failed-payment-recovery detector.
 *
 * Pure: same input, same output, always. Inputs are never mutated.
 */
export function detectFailedPaymentRecovery(
  input: DetectorInput,
  options: DetectorOptions = {},
): DetectionResult {
  const { referenceAt, config, customers, transactions, paymentAttempts } = input;
  const diagnostics = options.diagnostics ?? false;

  const recoverableReasons = new Set(config.recoverableFailureReasons);
  const recencyCutoff = new Date(
    referenceAt.getTime() - config.recencyWindowDays * MS_PER_DAY,
  );

  const customersById = new Map<string, CustomerRecord>();
  for (const customer of customers) customersById.set(customer.id, customer);

  // Step 1: group every attempt under its transaction.
  const transactionIds = new Set(transactions.map((t) => t.id));
  const attemptsByTransaction = new Map<string, PaymentAttemptRecord[]>();
  let orphanedPaymentAttempts = 0;

  for (const attempt of paymentAttempts) {
    if (!transactionIds.has(attempt.transactionId)) {
      // An attempt whose transaction is absent cannot be judged. Counted and
      // surfaced rather than silently dropped.
      orphanedPaymentAttempts += 1;
      continue;
    }
    const chain = attemptsByTransaction.get(attempt.transactionId);
    if (chain) chain.push(attempt);
    else attemptsByTransaction.set(attempt.transactionId, [attempt]);
  }
  for (const chain of attemptsByTransaction.values()) chain.sort(compareAttempts);

  const candidates: OpportunityCandidate[] = [];
  const excluded: ExcludedTransaction[] = [];
  const exclusionCounts = emptyExclusionCounts();
  let unpaidTransactions = 0;

  // Evaluate in a stable order so a debugger sees the same sequence every run.
  const orderedTransactions = [...transactions].sort((a, b) => a.id.localeCompare(b.id));

  for (const transaction of orderedTransactions) {
    const chain = attemptsByTransaction.get(transaction.id) ?? [];

    const exclude = (reason: ExclusionReason, detail: string): void => {
      exclusionCounts[reason] += 1;
      if (diagnostics) {
        excluded.push({
          transactionId: transaction.id,
          transactionRef: transaction.sourceRef,
          customerId: transaction.customerId,
          amountPaise: transaction.amountPaise,
          reason,
          detail,
        });
      }
    };

    // Step 2: any success anywhere in the chain means the money is collected.
    // Checked before everything else, because a recovered payment is not an
    // opportunity no matter how attractive the rest of its evidence looks.
    if (chain.some((attempt) => attempt.status === "SUCCESS")) {
      exclude("ALREADY_RECOVERED", "chain contains a successful attempt");
      continue;
    }

    unpaidTransactions += 1;

    const customer = customersById.get(transaction.customerId);
    if (!customer) {
      exclude(
        "INCOMPLETE_EVIDENCE",
        `customer ${transaction.customerId} not present in input`,
      );
      continue;
    }

    // Step 3: the operative attempt is the LAST failed one.
    const failedAttempts = chain.filter((attempt) => attempt.status === "FAILED");
    if (failedAttempts.length === 0) {
      exclude(
        "NO_FAILED_ATTEMPTS",
        chain.length === 0
          ? "transaction has no payment attempts"
          : `chain of ${chain.length} contains no failed attempt`,
      );
      continue;
    }

    const operative = failedAttempts[failedAttempts.length - 1]!;

    // Step 4: a failure with no stated reason cannot be classified, so it is
    // never assumed recoverable. Failing safe means failing closed.
    if (operative.failureReason === null || operative.failureReason === "") {
      exclude(
        "INCOMPLETE_EVIDENCE",
        `attempt ${operative.sourceRef} is FAILED but carries no failure reason`,
      );
      continue;
    }

    const lastFailureReason = operative.failureReason;

    // Step 5: merchant policy decides which reasons are worth re-soliciting.
    if (!recoverableReasons.has(lastFailureReason)) {
      exclude(
        "NON_RECOVERABLE_FAILURE",
        `${lastFailureReason} is not in the merchant's recoverable set`,
      );
      continue;
    }

    // Step 6: recency, measured from the operative failure, against the
    // reference instant rather than the wall clock.
    const failureAgeDays = failureAgeInDays(operative.occurredAt, referenceAt);
    if (operative.occurredAt.getTime() < recencyCutoff.getTime()) {
      exclude(
        "OUTSIDE_RECENCY_WINDOW",
        `failed ${failureAgeDays}d ago, window is ${config.recencyWindowDays}d`,
      );
      continue;
    }

    // Step 7: ticket floor.
    if (transaction.amountPaise < config.minTransactionAmountPaise) {
      exclude(
        "BELOW_TICKET_FLOOR",
        `${transaction.amountPaise} paise is below the ${config.minTransactionAmountPaise} paise floor`,
      );
      continue;
    }

    // Step 8: customer value floor.
    if (customer.lifetimeValuePaise < config.minCustomerLifetimeValuePaise) {
      exclude(
        "BELOW_LTV_FLOOR",
        `lifetime value ${customer.lifetimeValuePaise} paise is below the ${config.minCustomerLifetimeValuePaise} paise floor`,
      );
      continue;
    }

    // Step 9: consent. `doNotContactUntil` is a date: a suppression that has
    // already lapsed does not suppress.
    if (
      customer.doNotContactUntil !== null &&
      customer.doNotContactUntil.getTime() > referenceAt.getTime()
    ) {
      exclude(
        "SUPPRESSED",
        `do-not-contact active until ${customer.doNotContactUntil.toISOString()}`,
      );
      continue;
    }

    // Step 10: qualifies.
    const checksPassed: QualifyingCheck[] = [
      "NO_SUCCESSFUL_ATTEMPT",
      "RECOVERABLE_FAILURE_REASON",
      "WITHIN_RECENCY_WINDOW",
      "MEETS_TICKET_FLOOR",
      "MEETS_LTV_FLOOR",
      "CONTACTABLE",
    ];

    const evidence: CandidateEvidence = {
      checksPassed,
      observed: {
        amountPaise: transaction.amountPaise,
        minTransactionAmountPaise: config.minTransactionAmountPaise,
        customerLifetimeValuePaise: customer.lifetimeValuePaise,
        minCustomerLifetimeValuePaise: config.minCustomerLifetimeValuePaise,
        failureAgeDays,
        recencyWindowDays: config.recencyWindowDays,
        recoverableFailureReasons: config.recoverableFailureReasons,
      },
    };

    candidates.push({
      transactionId: transaction.id,
      transactionRef: transaction.sourceRef,
      customerId: customer.id,
      customerRef: customer.sourceRef,
      amountPaise: transaction.amountPaise,
      lastFailureReason,
      failedAttemptCount: failedAttempts.length,
      totalAttemptCount: chain.length,
      attemptedAt: operative.occurredAt,
      transactionOccurredAt: transaction.occurredAt,
      failureAgeDays,
      customerTier: customer.tier,
      customerLifetimeValuePaise: customer.lifetimeValuePaise,
      operativeAttemptId: operative.id,
      operativeAttemptRef: operative.sourceRef,
      evidence,
    });
  }

  // Highest value first, ties broken by id: useful for review, and total, so
  // the ordering is itself deterministic.
  candidates.sort(
    (a, b) =>
      b.amountPaise - a.amountPaise || a.transactionId.localeCompare(b.transactionId),
  );

  return {
    detectorKey: DETECTOR_KEY,
    detectorVersion: DETECTOR_VERSION,
    referenceAt,
    recencyCutoff,
    scan: {
      transactionsScanned: transactions.length,
      paymentAttemptsScanned: paymentAttempts.length,
      customersScanned: customers.length,
      unpaidTransactions,
      orphanedPaymentAttempts,
    },
    candidates,
    exclusionCounts,
    excluded,
    aggregate: aggregateCandidates(candidates),
  };
}

/**
 * Roll candidates into the Opportunity-shaped aggregate.
 *
 * Every field is a tally or an exact integer sum of observed rows. Nothing is
 * projected, weighted, or discounted.
 */
export function aggregateCandidates(
  candidates: readonly OpportunityCandidate[],
): OpportunityAggregate {
  const failureReasonBreakdown: Record<string, number> = {};
  const tierBreakdown: Record<string, number> = {};
  const customerIds = new Set<string>();
  let recoverableAmountPaise = 0;

  for (const candidate of candidates) {
    // Integer paise throughout: no float ever enters this sum.
    recoverableAmountPaise += candidate.amountPaise;
    customerIds.add(candidate.customerId);
    failureReasonBreakdown[candidate.lastFailureReason] =
      (failureReasonBreakdown[candidate.lastFailureReason] ?? 0) + 1;
    tierBreakdown[candidate.customerTier] =
      (tierBreakdown[candidate.customerTier] ?? 0) + 1;
  }

  return {
    qualifyingTransactionCount: candidates.length,
    // Distinct customers, per ARCHITECTURE.md: one person contacted once, even
    // if two of their transactions qualify.
    affectedCustomerCount: customerIds.size,
    recoverableAmountPaise,
    failureReasonBreakdown: sortRecord(failureReasonBreakdown),
    tierBreakdown: sortRecord(tierBreakdown),
    targetTransactionIds: candidates.map((c) => c.transactionId),
    targetCustomerIds: [...customerIds].sort(),
  };
}

/** Key-sorted, so serialised evidence is byte-stable across runs. */
function sortRecord(record: Record<string, number>): Record<string, number> {
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(record).sort()) sorted[key] = record[key]!;
  return sorted;
}
