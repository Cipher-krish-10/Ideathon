import "server-only";

import type { AttemptStatus, FailureReason, Prisma } from "@/generated/prisma/client";
import { ScopedRepository } from "./context";

/**
 * Payment attempts are the detector's primary evidence: the chain determines
 * whether a transaction is still unpaid, and its final FAILED entry determines
 * which failure reason is operative.
 */
export class PaymentAttemptRepository extends ScopedRepository {
  findById(id: string) {
    return this.db.paymentAttempt.findFirst({ where: this.scope.where({ id }) });
  }

  /** Look up by the dataset identifier, e.g. "pa_000001". */
  findBySourceRef(sourceRef: string) {
    return this.db.paymentAttempt.findFirst({
      where: this.scope.where({ sourceRef }),
    });
  }

  /** Full chain for one transaction, in attempt order. */
  listForTransaction(transactionId: string) {
    return this.db.paymentAttempt.findMany({
      where: this.scope.where({ transactionId }),
      orderBy: { attemptNo: "asc" },
    });
  }

  list(
    options: {
      status?: AttemptStatus;
      failureReason?: FailureReason;
      customerId?: string;
      take?: number;
    } = {},
  ) {
    const { status, failureReason, customerId, take } = options;
    return this.db.paymentAttempt.findMany({
      where: this.scope.where({
        ...(status ? { status } : {}),
        ...(failureReason ? { failureReason } : {}),
        ...(customerId ? { customerId } : {}),
      }),
      orderBy: { occurredAt: "desc" },
      ...(take === undefined ? {} : { take }),
    });
  }

  count(filter: Prisma.PaymentAttemptWhereInput = {}) {
    return this.db.paymentAttempt.count({ where: this.scope.where(filter) });
  }

  countByFailureReason() {
    return this.db.paymentAttempt.groupBy({
      by: ["failureReason"],
      where: this.scope.where<Prisma.PaymentAttemptWhereInput>({ status: "FAILED" }),
      _count: { _all: true },
      orderBy: { failureReason: "asc" },
    });
  }

  /**
   * The operative failed attempt for a transaction: the LAST failed entry in
   * the chain. A chain that begins with insufficient_funds and ends with
   * expired_card is an expired-card problem.
   */
  findLatestFailedForTransaction(transactionId: string) {
    return this.db.paymentAttempt.findFirst({
      where: this.scope.where<Prisma.PaymentAttemptWhereInput>({
        transactionId,
        status: "FAILED",
      }),
      orderBy: { attemptNo: "desc" },
    });
  }
}
