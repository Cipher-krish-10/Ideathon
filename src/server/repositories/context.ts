import "server-only";

import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";

/**
 * A resolved merchant scope.
 *
 * Every repository takes one of these and merges `merchantId` into every query
 * it builds. Callers cannot override it: the scope is applied AFTER any
 * caller-supplied filter, so a stray `merchantId` in a filter object is
 * overwritten rather than honoured.
 */
export class MerchantScope {
  constructor(
    readonly merchantId: string,
    readonly client: PrismaClient = prisma,
  ) {
    if (!merchantId) {
      throw new Error("MerchantScope requires a non-empty merchantId");
    }
  }

  /**
   * Merge this scope into a caller-supplied filter.
   *
   * Scope is applied last, deliberately. `where({ merchantId: "someone-else" })`
   * silently resolves to THIS merchant rather than leaking another tenant's rows.
   */
  where<T extends object>(filter?: T): T & { merchantId: string } {
    return { ...(filter ?? ({} as T)), merchantId: this.merchantId };
  }
}

/** Base class carrying the scope and a typed handle to the client. */
export abstract class ScopedRepository {
  protected readonly db: PrismaClient;

  constructor(protected readonly scope: MerchantScope) {
    this.db = scope.client;
  }

  protected get merchantId(): string {
    return this.scope.merchantId;
  }
}
