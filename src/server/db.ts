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
  // Bounded pool. Scripts (seed, demo setup, detector runs) each open their own
  // pool alongside this one, and an unbounded default exhausts Postgres.
  const adapter = new PrismaPg({ connectionString: env.DATABASE_URL, max: 5 });
  return new PrismaClient({
    adapter,
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

// Next's dev server re-evaluates modules on hot reload, so the instance is also
// parked on globalThis to survive that. In production the module-level binding
// is what matters.
const globalForPrisma = globalThis as unknown as {
  __revenuepilotPrisma?: PrismaClient;
};

let client: PrismaClient | undefined;

/**
 * The single client instance.
 *
 * Memoised unconditionally. An earlier version only cached outside production,
 * which meant that in a production build EVERY property access on the proxy
 * below constructed a fresh client and a fresh connection pool — Postgres ran
 * out of connections within a handful of requests.
 */
function getClient(): PrismaClient {
  client ??= globalForPrisma.__revenuepilotPrisma ?? createClient();
  globalForPrisma.__revenuepilotPrisma = client;
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
