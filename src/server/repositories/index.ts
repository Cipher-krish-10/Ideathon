import "server-only";

import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";

import { MerchantScope } from "./context";
import { CustomerRepository } from "./customer.repository";
import { MerchantRepository } from "./merchant.repository";
import { PaymentAttemptRepository } from "./payment-attempt.repository";
import { ProductRepository } from "./product.repository";
import { TransactionRepository } from "./transaction.repository";

export { MerchantScope, ScopedRepository } from "./context";
export { CustomerRepository } from "./customer.repository";
export { MerchantRepository } from "./merchant.repository";
export { PaymentAttemptRepository } from "./payment-attempt.repository";
export { ProductRepository } from "./product.repository";
export { TransactionRepository } from "./transaction.repository";

/**
 * The sanctioned data-access surface for one merchant.
 *
 * Application code asks for this and gets repositories that cannot produce an
 * unscoped query. Nothing outside `src/server/**` should import the Prisma
 * client directly — see the ESLint boundary rule in eslint.config.mjs.
 */
export class MerchantRepositories {
  readonly customers: CustomerRepository;
  readonly products: ProductRepository;
  readonly transactions: TransactionRepository;
  readonly paymentAttempts: PaymentAttemptRepository;

  constructor(readonly scope: MerchantScope) {
    this.customers = new CustomerRepository(scope);
    this.products = new ProductRepository(scope);
    this.transactions = new TransactionRepository(scope);
    this.paymentAttempts = new PaymentAttemptRepository(scope);
  }

  get merchantId(): string {
    return this.scope.merchantId;
  }
}

/** Build a repository set from a known merchant id. */
export function repositoriesFor(
  merchantId: string,
  client: PrismaClient = prisma,
): MerchantRepositories {
  return new MerchantRepositories(new MerchantScope(merchantId, client));
}

/** Resolve a merchant by id, then build its repository set. */
export async function repositoriesForMerchantId(
  merchantId: string,
  client: PrismaClient = prisma,
): Promise<MerchantRepositories> {
  const scope = await new MerchantRepository(client).scopeFor(merchantId);
  return new MerchantRepositories(scope);
}

/** Resolve a merchant by its dataset identifier, then build its repository set. */
export async function repositoriesForSourceRef(
  sourceRef: string,
  client: PrismaClient = prisma,
): Promise<MerchantRepositories> {
  const scope = await new MerchantRepository(client).scopeForSourceRef(sourceRef);
  return new MerchantRepositories(scope);
}
