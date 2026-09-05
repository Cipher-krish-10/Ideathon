import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { getEnv } from "@/lib/env";

/**
 * The raw Prisma client.
 *
 * DO NOT import this outside `src/server/**`. Application code goes through
 * `src/server/repositories`, which forces a merchant scope onto every query.
 * An ESLint `no-restricted-imports` rule enforces the boundary, because a
 * single unscoped `findMany` is a cross-tenant data leak and it would look
 * exactly like ordinary code in review.
 *
 * The client is created LAZILY, on first property access, rather than at module
 * load. Opening a connection pool as an import side effect means any module
 * that merely mentions this file forces a database connection — and it made
 * scripts fail before they could load their environment, since ESM imports are
 * evaluated ahead of the importing module's body.
 */
function createClient(): PrismaClient {
  const env = getEnv();
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// Next's dev server re-evaluates modules on hot reload; without a global cache
// each reload would open a new pool and eventually exhaust Postgres.
const globalForPrisma = globalThis as unknown as {
  __revenuepilotPrisma?: PrismaClient;
};

function getClient(): PrismaClient {
  const existing = globalForPrisma.__revenuepilotPrisma;
  if (existing) return existing;

  const client = createClient();
  if (getEnv().NODE_ENV !== "production") {
    globalForPrisma.__revenuepilotPrisma = client;
  }
  return client;
}

/**
 * Deferred handle to the client. Behaves exactly like a PrismaClient; the
 * underlying instance is built on the first property read.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getClient();
    const value = Reflect.get(client, property) as unknown;
    // Re-bind methods so `this` still refers to the real client.
    return typeof value === "function" ? value.bind(client) : value;
  },
  has(_target, property) {
    return property in getClient();
  },
});

/** Explicit accessor, for code that would rather not go through the proxy. */
export function getPrismaClient(): PrismaClient {
  return getClient();
}

export type { PrismaClient };
