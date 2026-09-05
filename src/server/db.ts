import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

/**
 * The raw Prisma client.
 *
 * DO NOT import this outside `src/server/**`. Application code goes through
 * `src/server/repositories`, which forces every query to carry a merchant
 * scope. An ESLint `no-restricted-imports` rule enforces this boundary, because
 * a single unscoped `findMany` is a cross-tenant data leak and it would look
 * exactly like ordinary code in review.
 */
function createClient(): PrismaClient {
  const env = getEnv();
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// Next dev-server hot reload re-evaluates modules; without a global cache each
// reload would open a new pool and eventually exhaust Postgres connections.
const globalForPrisma = globalThis as unknown as {
  __revenuepilotPrisma?: PrismaClient;
};

export const prisma: PrismaClient =
  globalForPrisma.__revenuepilotPrisma ?? createClient();

if (getEnv().NODE_ENV !== "production") {
  globalForPrisma.__revenuepilotPrisma = prisma;
}

export type { PrismaClient };
