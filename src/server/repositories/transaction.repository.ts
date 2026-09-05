import "server-only";

import type { Prisma, TransactionStatus } from "@/generated/prisma/client";
import { ScopedRepository } from "./context";

export class TransactionRepository extends ScopedRepository {
  findById(id: string) {
    return this.db.transaction.findFirst({ where: this.scope.where({ id }) });
  }

  /** Look up by the dataset identifier, e.g. "txn_000001". */
  findBySourceRef(sourceRef: string) {
    return this.db.transaction.findFirst({ where: this.scope.where({ sourceRef }) });
  }

  list(
    options: {
      status?: TransactionStatus;
      customerId?: string;
      take?: number;
      skip?: number;
    } = {},
  ) {
    const { status, customerId, take, skip } = options;
    return this.db.transaction.findMany({
      where: this.scope.where({
        ...(status ? { status } : {}),
        ...(customerId ? { customerId } : {}),
      }),
      orderBy: { occurredAt: "desc" },
      ...(take === undefined ? {} : { take }),
      ...(skip === undefined ? {} : { skip }),
    });
  }

  count(filter: Prisma.TransactionWhereInput = {}) {
    return this.db.transaction.count({ where: this.scope.where(filter) });
  }

  countByStatus() {
    return this.db.transaction.groupBy({
      by: ["status"],
      where: this.scope.where(),
      _count: { _all: true },
      orderBy: { status: "asc" },
    });
  }

  /**
   * Sum of amounts, optionally filtered.
   *
   * Postgres SUM over INTEGER returns BIGINT, so an aggregate that would
   * overflow a paise column is still computed correctly. Prisma surfaces it as
   * a JS number; the total here (~1.2e9 paise) is far inside Number.MAX_SAFE_INTEGER.
   */
  async sumAmountPaise(filter: Prisma.TransactionWhereInput = {}): Promise<number> {
    const result = await this.db.transaction.aggregate({
      where: this.scope.where(filter),
      _sum: { amountPaise: true },
    });
    return result._sum.amountPaise ?? 0;
  }

  /** A transaction with its full attempt chain, ordered. Detector's core read. */
  findWithAttempts(id: string) {
    return this.db.transaction.findFirst({
      where: this.scope.where({ id }),
      include: {
        paymentAttempts: { orderBy: { attemptNo: "asc" } },
        customer: true,
        product: true,
      },
    });
  }

  /**
   * Unpaid transactions with their attempt chains.
   *
   * This is the detector's primary scan. It deliberately returns raw evidence
   * and applies NO recoverability judgement — that belongs to the detector,
   * which reads its thresholds from merchant configuration.
   */
  listUnpaidWithAttempts(options: { take?: number } = {}) {
    return this.db.transaction.findMany({
      where: this.scope.where<Prisma.TransactionWhereInput>({ status: "FAILED" }),
      include: {
        paymentAttempts: { orderBy: { attemptNo: "asc" } },
        customer: true,
      },
      orderBy: { occurredAt: "desc" },
      ...(options.take === undefined ? {} : { take: options.take }),
    });
  }
}
