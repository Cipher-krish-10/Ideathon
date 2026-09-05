import { describe, expect, it } from "vitest";

import {
  DETECTOR_KEY,
  DETECTOR_VERSION,
  detectFailedPaymentRecovery,
} from "@/core/detectors";
import type {
  CustomerRecord,
  DetectorInput,
  FailedPaymentRecoveryConfig,
  PaymentAttemptRecord,
  TransactionRecord,
} from "@/core/detectors";

/**
 * Unit tests for the pure detector.
 *
 * Every case is hand-built, so each rule is exercised in isolation with all
 * other rules deliberately satisfied. That way a failure names exactly one
 * cause instead of "something in the pipeline".
 */

const REFERENCE_AT = new Date("2026-09-01T23:59:59+05:30");

const CONFIG: FailedPaymentRecoveryConfig = {
  recoverableFailureReasons: [
    "INSUFFICIENT_FUNDS",
    "PAYMENT_NETWORK_ERROR",
    "AUTHENTICATION_FAILED",
    "PAYMENT_METHOD_DECLINED",
    "EXPIRED_CARD",
  ],
  recencyWindowDays: 30,
  minTransactionAmountPaise: 50_000, // ₹500
  minCustomerLifetimeValuePaise: 200_000, // ₹2,000
};

const MS_PER_DAY = 86_400_000;
const daysBeforeReference = (days: number) =>
  new Date(REFERENCE_AT.getTime() - days * MS_PER_DAY);

function customer(overrides: Partial<CustomerRecord> = {}): CustomerRecord {
  return {
    id: "cus-1",
    sourceRef: "cust_0001",
    tier: "HIGH",
    lifetimeValuePaise: 6_000_000,
    doNotContactUntil: null,
    ...overrides,
  };
}

function transaction(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: "txn-1",
    sourceRef: "txn_000001",
    customerId: "cus-1",
    amountPaise: 499_900,
    occurredAt: daysBeforeReference(10),
    ...overrides,
  };
}

function attempt(overrides: Partial<PaymentAttemptRecord> = {}): PaymentAttemptRecord {
  return {
    id: "att-1",
    sourceRef: "pa_000001",
    transactionId: "txn-1",
    status: "FAILED",
    failureReason: "INSUFFICIENT_FUNDS",
    attemptNo: 1,
    occurredAt: daysBeforeReference(10),
    ...overrides,
  };
}

/** A world where the single transaction qualifies unless a test breaks it. */
function input(overrides: Partial<DetectorInput> = {}): DetectorInput {
  return {
    referenceAt: REFERENCE_AT,
    config: CONFIG,
    customers: [customer()],
    transactions: [transaction()],
    paymentAttempts: [attempt()],
    ...overrides,
  };
}

const run = (overrides: Partial<DetectorInput> = {}) =>
  detectFailedPaymentRecovery(input(overrides), { diagnostics: true });

describe("FailedPaymentRecoveryDetector", () => {
  describe("1. a recoverable failed transaction qualifies", () => {
    it("produces one candidate carrying only observed facts", () => {
      const result = run();

      expect(result.candidates).toHaveLength(1);
      const candidate = result.candidates[0]!;
      expect(candidate.transactionId).toBe("txn-1");
      expect(candidate.customerId).toBe("cus-1");
      expect(candidate.amountPaise).toBe(499_900);
      expect(candidate.lastFailureReason).toBe("INSUFFICIENT_FUNDS");
      expect(candidate.failedAttemptCount).toBe(1);
      expect(candidate.customerTier).toBe("HIGH");
      expect(candidate.customerLifetimeValuePaise).toBe(6_000_000);
      expect(candidate.operativeAttemptRef).toBe("pa_000001");
      expect(candidate.evidence.checksPassed).toEqual([
        "NO_SUCCESSFUL_ATTEMPT",
        "RECOVERABLE_FAILURE_REASON",
        "WITHIN_RECENCY_WINDOW",
        "MEETS_TICKET_FLOOR",
        "MEETS_LTV_FLOOR",
        "CONTACTABLE",
      ]);
    });

    it("emits no projection of any kind", () => {
      // The detector observes. The estimator projects. Keeping that line sharp
      // is what makes every rupee on screen traceable to a row.
      const candidate = run().candidates[0]!;
      const forbidden = [
        "expectedRecoveryProbability", "pRecover", "probability",
        "expectedGrossPaise", "expectedNetPaise", "discountCostPaise",
        "roi", "recommendedPlaybook", "playbookId", "rationale", "confidence",
      ];
      for (const key of forbidden) {
        expect(candidate).not.toHaveProperty(key);
      }
    });

    it("stamps the detector key and version", () => {
      const result = run();
      expect(result.detectorKey).toBe(DETECTOR_KEY);
      expect(result.detectorVersion).toBe("failed-payment-recovery:v1");
      expect(DETECTOR_VERSION).toBe("failed-payment-recovery:v1");
    });
  });

  describe("2. a successful retry excludes the transaction", () => {
    it("excludes FAILED -> SUCCESS as ALREADY_RECOVERED", () => {
      const result = run({
        paymentAttempts: [
          attempt({ id: "a1", attemptNo: 1, status: "FAILED" }),
          attempt({ id: "a2", attemptNo: 2, status: "SUCCESS", failureReason: null }),
        ],
      });
      expect(result.candidates).toHaveLength(0);
      expect(result.exclusionCounts.ALREADY_RECOVERED).toBe(1);
      expect(result.excluded[0]!.reason).toBe("ALREADY_RECOVERED");
    });

    it("excludes FAILED, FAILED, SUCCESS", () => {
      const result = run({
        paymentAttempts: [
          attempt({ id: "a1", attemptNo: 1 }),
          attempt({ id: "a2", attemptNo: 2 }),
          attempt({ id: "a3", attemptNo: 3, status: "SUCCESS", failureReason: null }),
        ],
      });
      expect(result.candidates).toHaveLength(0);
      expect(result.exclusionCounts.ALREADY_RECOVERED).toBe(1);
    });

    it("excludes even when the success is not the last attempt in the array", () => {
      // Success anywhere in the chain means the money is collected.
      const result = run({
        paymentAttempts: [
          attempt({ id: "a2", attemptNo: 2, status: "SUCCESS", failureReason: null }),
          attempt({ id: "a1", attemptNo: 1, status: "FAILED" }),
        ],
      });
      expect(result.exclusionCounts.ALREADY_RECOVERED).toBe(1);
    });

    it("takes precedence over every other exclusion", () => {
      // A recovered payment is not an opportunity no matter how bad its other
      // evidence looks.
      const result = run({
        customers: [customer({ lifetimeValuePaise: 0, doNotContactUntil: new Date("2027-01-01") })],
        transactions: [transaction({ amountPaise: 100 })],
        paymentAttempts: [
          attempt({ id: "a1", attemptNo: 1, failureReason: "SUSPECTED_FRAUD" }),
          attempt({ id: "a2", attemptNo: 2, status: "SUCCESS", failureReason: null }),
        ],
      });
      expect(result.exclusionCounts.ALREADY_RECOVERED).toBe(1);
      expect(result.exclusionCounts.SUPPRESSED).toBe(0);
      expect(result.exclusionCounts.BELOW_LTV_FLOOR).toBe(0);
    });
  });

  describe("3. a non-recoverable failure reason excludes", () => {
    it.each(["SUSPECTED_FRAUD", "UNKNOWN"])("excludes %s", (reason) => {
      const result = run({ paymentAttempts: [attempt({ failureReason: reason })] });
      expect(result.candidates).toHaveLength(0);
      expect(result.exclusionCounts.NON_RECOVERABLE_FAILURE).toBe(1);
    });

    it("reads the recoverable set from configuration, not from code", () => {
      // Narrowing merchant policy must change the outcome with no code change.
      const result = detectFailedPaymentRecovery(
        input({ config: { ...CONFIG, recoverableFailureReasons: ["EXPIRED_CARD"] } }),
        { diagnostics: true },
      );
      expect(result.candidates).toHaveLength(0);
      expect(result.exclusionCounts.NON_RECOVERABLE_FAILURE).toBe(1);
    });
  });

  describe("4. a failure outside the recency window excludes", () => {
    it("excludes a failure older than the window", () => {
      const result = run({
        transactions: [transaction({ occurredAt: daysBeforeReference(45) })],
        paymentAttempts: [attempt({ occurredAt: daysBeforeReference(45) })],
      });
      expect(result.exclusionCounts.OUTSIDE_RECENCY_WINDOW).toBe(1);
    });

    it("includes a failure exactly at the cutoff", () => {
      // Boundary is inclusive: exclude only when strictly older than the cutoff.
      const result = run({ paymentAttempts: [attempt({ occurredAt: daysBeforeReference(30) })] });
      expect(result.candidates).toHaveLength(1);
    });

    it("excludes one millisecond beyond the cutoff", () => {
      const cutoff = new Date(REFERENCE_AT.getTime() - 30 * MS_PER_DAY);
      const result = run({
        paymentAttempts: [attempt({ occurredAt: new Date(cutoff.getTime() - 1) })],
      });
      expect(result.exclusionCounts.OUTSIDE_RECENCY_WINDOW).toBe(1);
    });

    it("measures recency from the LAST failed attempt, not the transaction", () => {
      // An old order retried recently is a recent failure.
      const result = run({
        transactions: [transaction({ occurredAt: daysBeforeReference(120) })],
        paymentAttempts: [
          attempt({ id: "a1", attemptNo: 1, occurredAt: daysBeforeReference(120) }),
          attempt({ id: "a2", attemptNo: 2, occurredAt: daysBeforeReference(3) }),
        ],
      });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.failureAgeDays).toBe(3);
    });
  });

  describe("5. a ticket below the floor excludes", () => {
    it("excludes below the floor", () => {
      const result = run({ transactions: [transaction({ amountPaise: 49_999 })] });
      expect(result.exclusionCounts.BELOW_TICKET_FLOOR).toBe(1);
    });

    it("includes exactly at the floor", () => {
      const result = run({ transactions: [transaction({ amountPaise: 50_000 })] });
      expect(result.candidates).toHaveLength(1);
    });
  });

  describe("6. a customer below the LTV floor excludes", () => {
    it("excludes below the floor", () => {
      const result = run({ customers: [customer({ lifetimeValuePaise: 199_999 })] });
      expect(result.exclusionCounts.BELOW_LTV_FLOOR).toBe(1);
    });

    it("includes exactly at the floor", () => {
      const result = run({ customers: [customer({ lifetimeValuePaise: 200_000 })] });
      expect(result.candidates).toHaveLength(1);
    });
  });

  describe("7. an actively suppressed customer excludes", () => {
    it("excludes when do-not-contact is still in force", () => {
      const result = run({
        customers: [customer({ doNotContactUntil: new Date("2026-12-31T00:00:00+05:30") })],
      });
      expect(result.exclusionCounts.SUPPRESSED).toBe(1);
      expect(result.excluded[0]!.detail).toContain("do-not-contact active until");
    });
  });

  describe("8. an EXPIRED suppression does not exclude", () => {
    it("treats do-not-contact as a date, not a flag", () => {
      // A detector that merely checked for presence would wrongly exclude this.
      const result = run({
        customers: [customer({ doNotContactUntil: daysBeforeReference(60) })],
      });
      expect(result.candidates).toHaveLength(1);
      expect(result.exclusionCounts.SUPPRESSED).toBe(0);
    });

    it("excludes one millisecond after the reference instant", () => {
      const justActive = new Date(REFERENCE_AT.getTime() + 1);
      const result = run({ customers: [customer({ doNotContactUntil: justActive })] });
      expect(result.exclusionCounts.SUPPRESSED).toBe(1);
    });

    it("does not suppress when the date equals the reference instant", () => {
      const result = run({ customers: [customer({ doNotContactUntil: REFERENCE_AT })] });
      expect(result.candidates).toHaveLength(1);
    });
  });

  describe("9. repeated failed attempts are ONE opportunity", () => {
    it("counts a four-attempt chain as a single candidate worth one ticket", () => {
      const result = run({
        paymentAttempts: [1, 2, 3, 4].map((n) =>
          attempt({ id: `a${n}`, sourceRef: `pa_00000${n}`, attemptNo: n,
            occurredAt: daysBeforeReference(10 - n) }),
        ),
      });

      expect(result.candidates).toHaveLength(1);
      const candidate = result.candidates[0]!;
      expect(candidate.failedAttemptCount).toBe(4);
      expect(candidate.totalAttemptCount).toBe(4);
      // Four attempts, one ticket -- not four.
      expect(result.aggregate.recoverableAmountPaise).toBe(499_900);
      expect(result.aggregate.qualifyingTransactionCount).toBe(1);
      expect(result.aggregate.affectedCustomerCount).toBe(1);
    });
  });

  describe("10. the FINAL failed attempt determines the failure reason", () => {
    it("uses the last attempt's reason, not the first", () => {
      // A chain that begins insufficient_funds and ends expired_card is an
      // expired-card problem.
      const result = run({
        paymentAttempts: [
          attempt({ id: "a1", sourceRef: "pa_1", attemptNo: 1, failureReason: "INSUFFICIENT_FUNDS" }),
          attempt({ id: "a2", sourceRef: "pa_2", attemptNo: 2, failureReason: "PAYMENT_NETWORK_ERROR" }),
          attempt({ id: "a3", sourceRef: "pa_3", attemptNo: 3, failureReason: "EXPIRED_CARD" }),
        ],
      });
      expect(result.candidates[0]!.lastFailureReason).toBe("EXPIRED_CARD");
      expect(result.candidates[0]!.operativeAttemptRef).toBe("pa_3");
    });

    it("orders by attemptNo regardless of array order", () => {
      const result = run({
        paymentAttempts: [
          attempt({ id: "a3", attemptNo: 3, failureReason: "EXPIRED_CARD" }),
          attempt({ id: "a1", attemptNo: 1, failureReason: "INSUFFICIENT_FUNDS" }),
          attempt({ id: "a2", attemptNo: 2, failureReason: "PAYMENT_NETWORK_ERROR" }),
        ],
      });
      expect(result.candidates[0]!.lastFailureReason).toBe("EXPIRED_CARD");
    });

    it("excludes when the final reason is non-recoverable even if earlier ones were", () => {
      const result = run({
        paymentAttempts: [
          attempt({ id: "a1", attemptNo: 1, failureReason: "INSUFFICIENT_FUNDS" }),
          attempt({ id: "a2", attemptNo: 2, failureReason: "SUSPECTED_FRAUD" }),
        ],
      });
      expect(result.candidates).toHaveLength(0);
      expect(result.exclusionCounts.NON_RECOVERABLE_FAILURE).toBe(1);
    });

    it("qualifies when the final reason is recoverable even if earlier ones were not", () => {
      const result = run({
        paymentAttempts: [
          attempt({ id: "a1", attemptNo: 1, failureReason: "SUSPECTED_FRAUD" }),
          attempt({ id: "a2", attemptNo: 2, failureReason: "EXPIRED_CARD" }),
        ],
      });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.lastFailureReason).toBe("EXPIRED_CARD");
    });
  });

  describe("11. transactions are evaluated independently per customer", () => {
    it("qualifies two transactions for one customer", () => {
      const result = run({
        transactions: [
          transaction({ id: "t1", sourceRef: "txn_1", amountPaise: 100_000 }),
          transaction({ id: "t2", sourceRef: "txn_2", amountPaise: 250_000 }),
        ],
        paymentAttempts: [
          attempt({ id: "a1", transactionId: "t1" }),
          attempt({ id: "a2", transactionId: "t2" }),
        ],
      });
      expect(result.candidates).toHaveLength(2);
      expect(result.aggregate.qualifyingTransactionCount).toBe(2);
      // One person, contacted once, even though two transactions qualify.
      expect(result.aggregate.affectedCustomerCount).toBe(1);
      expect(result.aggregate.recoverableAmountPaise).toBe(350_000);
    });

    it("evaluates a customer's old and recent transactions independently", () => {
      const result = run({
        transactions: [
          transaction({ id: "t_old", sourceRef: "txn_old" }),
          transaction({ id: "t_new", sourceRef: "txn_new" }),
        ],
        paymentAttempts: [
          attempt({ id: "a_old", transactionId: "t_old", occurredAt: daysBeforeReference(200) }),
          attempt({ id: "a_new", transactionId: "t_new", occurredAt: daysBeforeReference(5) }),
        ],
      });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.transactionId).toBe("t_new");
      expect(result.exclusionCounts.OUTSIDE_RECENCY_WINDOW).toBe(1);
    });
  });

  describe("12-13. aggregation", () => {
    it("counts distinct customers and sums integer paise exactly", () => {
      const result = run({
        customers: [
          customer({ id: "c1", sourceRef: "cust_1", tier: "HIGH" }),
          customer({ id: "c2", sourceRef: "cust_2", tier: "MEDIUM" }),
        ],
        transactions: [
          transaction({ id: "t1", customerId: "c1", amountPaise: 111_111 }),
          transaction({ id: "t2", customerId: "c1", amountPaise: 222_222 }),
          transaction({ id: "t3", customerId: "c2", amountPaise: 333_333 }),
        ],
        paymentAttempts: [
          attempt({ id: "a1", transactionId: "t1", failureReason: "EXPIRED_CARD" }),
          attempt({ id: "a2", transactionId: "t2", failureReason: "EXPIRED_CARD" }),
          attempt({ id: "a3", transactionId: "t3", failureReason: "INSUFFICIENT_FUNDS" }),
        ],
      });

      const { aggregate } = result;
      expect(aggregate.qualifyingTransactionCount).toBe(3);
      expect(aggregate.affectedCustomerCount).toBe(2);
      expect(aggregate.recoverableAmountPaise).toBe(666_666);
      expect(Number.isInteger(aggregate.recoverableAmountPaise)).toBe(true);
      expect(aggregate.failureReasonBreakdown).toEqual({
        EXPIRED_CARD: 2, INSUFFICIENT_FUNDS: 1,
      });
      expect(aggregate.tierBreakdown).toEqual({ HIGH: 2, MEDIUM: 1 });
      expect(aggregate.targetCustomerIds).toEqual(["c1", "c2"]);
      expect(aggregate.targetTransactionIds).toHaveLength(3);
    });
  });

  describe("14. determinism and purity", () => {
    it("returns identical results across repeated runs", () => {
      const payload = input({
        customers: [customer({ id: "c1" }), customer({ id: "c2", sourceRef: "cust_2" })],
        transactions: [
          transaction({ id: "t1", customerId: "c1", amountPaise: 90_000 }),
          transaction({ id: "t2", customerId: "c2", amountPaise: 90_000 }),
        ],
        paymentAttempts: [
          attempt({ id: "a1", transactionId: "t1" }),
          attempt({ id: "a2", transactionId: "t2" }),
        ],
      });
      const a = JSON.stringify(detectFailedPaymentRecovery(payload));
      const b = JSON.stringify(detectFailedPaymentRecovery(payload));
      expect(a).toBe(b);
    });

    it("orders candidates by value, then id, so equal amounts are still stable", () => {
      const result = run({
        transactions: [
          transaction({ id: "t_b", amountPaise: 100_000 }),
          transaction({ id: "t_a", amountPaise: 100_000 }),
          transaction({ id: "t_c", amountPaise: 900_000 }),
        ],
        paymentAttempts: [
          attempt({ id: "a1", transactionId: "t_b" }),
          attempt({ id: "a2", transactionId: "t_a" }),
          attempt({ id: "a3", transactionId: "t_c" }),
        ],
      });
      expect(result.candidates.map((c) => c.transactionId)).toEqual(["t_c", "t_a", "t_b"]);
    });

    it("does not mutate its inputs", () => {
      const payload = input({
        paymentAttempts: [
          attempt({ id: "a2", attemptNo: 2 }),
          attempt({ id: "a1", attemptNo: 1 }),
        ],
      });
      const before = JSON.stringify(payload);
      detectFailedPaymentRecovery(payload, { diagnostics: true });
      expect(JSON.stringify(payload)).toBe(before);
    });

    it("does not read the wall clock", () => {
      // Judging against a fixed reference instant is what keeps a demo
      // reproducible on any day. A far-future reference makes everything stale.
      const future = new Date("2030-01-01T00:00:00+05:30");
      const result = detectFailedPaymentRecovery(input({ referenceAt: future }));
      expect(result.candidates).toHaveLength(0);
      expect(result.exclusionCounts.OUTSIDE_RECENCY_WINDOW).toBe(1);
    });
  });

  describe("15. empty input", () => {
    it("returns an empty, well-formed result", () => {
      const result = detectFailedPaymentRecovery({
        referenceAt: REFERENCE_AT, config: CONFIG,
        customers: [], transactions: [], paymentAttempts: [],
      });
      expect(result.candidates).toHaveLength(0);
      expect(result.aggregate.recoverableAmountPaise).toBe(0);
      expect(result.aggregate.affectedCustomerCount).toBe(0);
      expect(result.aggregate.failureReasonBreakdown).toEqual({});
      expect(result.scan.transactionsScanned).toBe(0);
      // Every reason is present with a zero, so consumers never see undefined.
      expect(Object.values(result.exclusionCounts).every((n) => n === 0)).toBe(true);
    });
  });

  describe("16. malformed evidence fails safe", () => {
    it("excludes a transaction with no attempts at all", () => {
      const result = run({ paymentAttempts: [] });
      expect(result.candidates).toHaveLength(0);
      expect(result.exclusionCounts.NO_FAILED_ATTEMPTS).toBe(1);
      expect(result.excluded[0]!.detail).toContain("no payment attempts");
    });

    it("excludes a PENDING-only chain rather than assuming failure", () => {
      const result = run({
        paymentAttempts: [attempt({ status: "PENDING", failureReason: null })],
      });
      expect(result.exclusionCounts.NO_FAILED_ATTEMPTS).toBe(1);
    });

    it("excludes a FAILED attempt carrying no reason", () => {
      // Unclassifiable means never assumed recoverable.
      const result = run({ paymentAttempts: [attempt({ failureReason: null })] });
      expect(result.candidates).toHaveLength(0);
      expect(result.exclusionCounts.INCOMPLETE_EVIDENCE).toBe(1);
      expect(result.excluded[0]!.detail).toContain("no failure reason");
    });

    it("treats an empty-string reason as missing", () => {
      const result = run({ paymentAttempts: [attempt({ failureReason: "" })] });
      expect(result.exclusionCounts.INCOMPLETE_EVIDENCE).toBe(1);
    });

    it("excludes a transaction whose customer is absent", () => {
      const result = run({ customers: [] });
      expect(result.candidates).toHaveLength(0);
      expect(result.exclusionCounts.INCOMPLETE_EVIDENCE).toBe(1);
      expect(result.excluded[0]!.detail).toContain("not present in input");
    });

    it("counts orphaned attempts without crashing or miscounting", () => {
      const result = run({
        paymentAttempts: [
          attempt({ id: "a1" }),
          attempt({ id: "a_orphan", transactionId: "txn-does-not-exist" }),
        ],
      });
      expect(result.candidates).toHaveLength(1);
      expect(result.scan.orphanedPaymentAttempts).toBe(1);
      expect(result.scan.paymentAttemptsScanned).toBe(2);
    });

    it("never lets a malformed row qualify", () => {
      const result = run({
        customers: [],
        paymentAttempts: [attempt({ failureReason: null })],
      });
      expect(result.candidates).toHaveLength(0);
    });
  });

  describe("diagnostics mode", () => {
    it("always returns counts, and per-row detail only when asked", () => {
      const payload = input({ paymentAttempts: [attempt({ failureReason: "SUSPECTED_FRAUD" })] });

      const quiet = detectFailedPaymentRecovery(payload);
      expect(quiet.exclusionCounts.NON_RECOVERABLE_FAILURE).toBe(1);
      expect(quiet.excluded).toHaveLength(0);

      const loud = detectFailedPaymentRecovery(payload, { diagnostics: true });
      expect(loud.excluded).toHaveLength(1);
      expect(loud.excluded[0]!.transactionRef).toBe("txn_000001");
    });
  });

  describe("scan summary", () => {
    it("reports unpaid transactions separately from qualifying ones", () => {
      // The gap between the two is the whole point: the agent discriminates
      // rather than counting failed payments.
      const result = run({
        transactions: [
          transaction({ id: "t1", amountPaise: 100_000 }),
          transaction({ id: "t2", amountPaise: 100 }),
          transaction({ id: "t3", amountPaise: 100_000 }),
        ],
        paymentAttempts: [
          attempt({ id: "a1", transactionId: "t1" }),
          attempt({ id: "a2", transactionId: "t2" }),
          attempt({ id: "a3", transactionId: "t3", status: "SUCCESS", failureReason: null }),
        ],
      });
      expect(result.scan.transactionsScanned).toBe(3);
      expect(result.scan.unpaidTransactions).toBe(2);
      expect(result.candidates).toHaveLength(1);
    });
  });
});
