import "server-only";

import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";
import { MerchantScope } from "./context";

/**
 * The only intentionally unscoped repository — it is how a scope is obtained in
 * the first place. Everything downstream requires a MerchantScope.
 */
export class MerchantRepository {
  constructor(private readonly db: PrismaClient = prisma) {}

  findById(id: string) {
    return this.db.merchant.findUnique({ where: { id } });
  }

  /** Look up by the dataset identifier, e.g. "merch_demo_001". */
  findBySourceRef(sourceRef: string) {
    return this.db.merchant.findUnique({ where: { sourceRef } });
  }

  list() {
    return this.db.merchant.findMany({ orderBy: { createdAt: "asc" } });
  }

  /** Resolve a merchant and return a scope bound to it. */
  async scopeFor(merchantId: string): Promise<MerchantScope> {
    const merchant = await this.findById(merchantId);
    if (!merchant) {
      throw new Error(`Unknown merchant: ${merchantId}`);
    }
    return new MerchantScope(merchant.id, this.db);
  }

  async scopeForSourceRef(sourceRef: string): Promise<MerchantScope> {
    const merchant = await this.findBySourceRef(sourceRef);
    if (!merchant) {
      throw new Error(`Unknown merchant sourceRef: ${sourceRef}`);
    }
    return new MerchantScope(merchant.id, this.db);
  }
}
