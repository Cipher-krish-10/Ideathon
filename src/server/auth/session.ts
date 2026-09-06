import "server-only";

import { cookies } from "next/headers";

import type { UserRole } from "@/generated/prisma/client";
import { prisma } from "@/server/db";

/**
 * Demo session.
 *
 * A cookie naming a seeded user, and server-side role checks on every mutating
 * route. This is NOT production authentication — there is no password, no
 * token, and no session store — but the authorization boundary it enforces is
 * real: the check happens on the server, and a viewer cannot approve a money
 * action by calling the API directly.
 *
 * Real auth is its own piece of work; stubbing it here rather than skipping the
 * role check keeps the approval gate meaningful in the meantime.
 */
export const SESSION_COOKIE = "rp_demo_user";

export interface DemoSession {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  merchantId: string;
}

export class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly required: readonly UserRole[],
    readonly actual: UserRole | null,
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

/**
 * Resolve the current user.
 *
 * Falls back to the merchant's APPROVER so the demo flows without a login step.
 * The cookie is how you switch roles to show the 403 path.
 */
export async function getSession(): Promise<DemoSession | null> {
  const store = await cookies();
  const userId = store.get(SESSION_COOKIE)?.value;

  const user = userId
    ? await prisma.user.findUnique({ where: { id: userId } })
    : await prisma.user.findFirst({
        where: { role: "APPROVER" },
        orderBy: { createdAt: "asc" },
      });

  if (!user) return null;
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    merchantId: user.merchantId,
  };
}

export async function requireSession(): Promise<DemoSession> {
  const session = await getSession();
  if (!session) {
    throw new AuthorizationError("No demo user is available. Run: npm run db:seed", [], null);
  }
  return session;
}

/**
 * Require one of the given roles.
 *
 * Approval and policy changes are money-affecting decisions, so a VIEWER is
 * refused here rather than merely having the button hidden in the UI.
 */
export async function requireRole(...roles: UserRole[]): Promise<DemoSession> {
  const session = await requireSession();
  if (!roles.includes(session.role)) {
    throw new AuthorizationError(
      `This action requires ${roles.join(" or ")}. You are signed in as ${session.role}.`,
      roles,
      session.role,
    );
  }
  return session;
}

/** Everyone who can be switched to in the demo UI. */
export async function listDemoUsers(): Promise<DemoSession[]> {
  const users = await prisma.user.findMany({ orderBy: { role: "asc" } });
  return users.map((user) => ({
    userId: user.id, email: user.email, name: user.name,
    role: user.role, merchantId: user.merchantId,
  }));
}
