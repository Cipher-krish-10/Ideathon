import "server-only";

import type { CustomerTier, Prisma } from "@/generated/prisma/client";
import { ScopedRepository } from "./context";

export class CustomerRepository extends ScopedRepository {
  findById(id: string) {
    // findFirst, not findUnique: the scope must be part of the predicate, or a
    // caller with a foreign id could read another merchant's customer.
    return this.db.customer.findFirst({ where: this.scope.where({ id }) });
  }

  /** Look up by the dataset identifier, e.g. "cust_0001". */
  findBySourceRef(sourceRef: string) {
    return this.db.customer.findFirst({ where: this.scope.where({ sourceRef }) });
  }

  list(options: { tier?: CustomerTier; take?: number; skip?: number } = {}) {
    const { tier, take, skip } = options;
    return this.db.customer.findMany({
      where: this.scope.where(tier ? { tier } : {}),
      orderBy: { sourceRef: "asc" },
      ...(take === undefined ? {} : { take }),
      ...(skip === undefined ? {} : { skip }),
    });
  }

  count(filter: Prisma.CustomerWhereInput = {}) {
    return this.db.customer.count({ where: this.scope.where(filter) });
  }

  /**
   * Customers a message may be sent to as of `referenceAt`.
   *
   * `doNotContactUntil` is a date, not a flag: an expired suppression does not
   * suppress. Comparing against the dataset's reference instant rather than the
   * wall clock is what keeps the demo reproducible.
   */
  listContactable(referenceAt: Date, options: { take?: number } = {}) {
    return this.db.customer.findMany({
      where: this.scope.where({
        OR: [{ doNotContactUntil: null }, { doNotContactUntil: { lte: referenceAt } }],
      }),
      orderBy: { sourceRef: "asc" },
      ...(options.take === undefined ? {} : { take: options.take }),
    });
  }

  countActivelySuppressed(referenceAt: Date) {
    return this.db.customer.count({
      where: this.scope.where({ doNotContactUntil: { gt: referenceAt } }),
    });
  }

  countByTier() {
    return this.db.customer.groupBy({
      by: ["tier"],
      where: this.scope.where(),
      _count: { _all: true },
      orderBy: { tier: "asc" },
    });
  }
}
