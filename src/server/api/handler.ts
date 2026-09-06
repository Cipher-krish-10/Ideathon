import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";

import { AuthorizationError } from "@/server/auth/session";
import { TransitionError } from "@/server/services/intervention-state.service";

/**
 * Shared route-handler plumbing.
 *
 * Handlers validate input, resolve the session, and delegate. No domain logic
 * lives in a route — a rule implemented in a handler is a rule no test outside
 * an HTTP request can reach.
 */

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

export function jsonError(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): NextResponse<ApiError> {
  return NextResponse.json(
    { error: { code, message, ...(details === undefined ? {} : { details }) } },
    { status },
  );
}

/**
 * Map a thrown error to a response.
 *
 * Deliberately narrow: known domain errors get precise codes, and everything
 * else becomes a generic 500 with the detail logged server-side rather than
 * returned. An unexpected error message can carry a connection string.
 */
export function toErrorResponse(error: unknown): NextResponse<ApiError> {
  if (error instanceof AuthorizationError) {
    return jsonError("FORBIDDEN", error.message, 403, {
      required: error.required, actual: error.actual,
    });
  }
  if (error instanceof TransitionError) {
    const status =
      error.code === "NOT_FOUND" ? 404
      : error.code === "STALE_VERSION" ? 409
      : error.code === "EXPIRED" ? 410
      : 422;
    return jsonError(error.code, error.message, status, {
      currentVersion: error.currentVersion, currentState: error.currentState,
    });
  }
  if (error instanceof z.ZodError) {
    return jsonError("INVALID_REQUEST", "Request body failed validation.", 400, {
      issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }

  console.error("[api] unhandled error:", error);
  return jsonError("INTERNAL_ERROR", "Something went wrong handling this request.", 500);
}

/**
 * Wrap a handler so every thrown error becomes a structured response.
 *
 * Deliberately untyped in its success shape: a handler that returns different
 * response bodies on different paths is normal, and pinning one of them as
 * "the" type just forces casts at every other return.
 */
export function route(
  handler: () => Promise<NextResponse<unknown>>,
): Promise<NextResponse<unknown>> {
  return handler().catch(toErrorResponse);
}

export async function parseJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const body = await request.json().catch(() => ({}));
  return schema.parse(body);
}
