/**
 * Intervention state machine.
 *
 * Pure: decides whether a transition is legal, and says why not when it is not.
 * The transactional work — optimistic locking, the audit row, the database
 * writes — happens in the service, so this table of legal moves stays readable
 * and exhaustively testable on its own.
 *
 * Execution states (EXECUTING and beyond) are declared here for completeness
 * but have NO inbound edges in this phase: they belong to the executor, and the
 * database independently refuses them without an Approval row.
 */
export type InterventionState =
  | "DRAFT"
  | "PROPOSED"
  | "GUARDRAIL_BLOCKED"
  | "PENDING_APPROVAL"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED"
  | "EXECUTING"
  | "EXECUTED"
  | "EXECUTION_FAILED"
  | "OBSERVING"
  | "CONVERTED"
  | "NOT_CONVERTED"
  | "LEARNED";

/** States from which nothing further may happen in this MVP. */
export const TERMINAL_STATES: readonly InterventionState[] = [
  "GUARDRAIL_BLOCKED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
  "LEARNED",
];

/** States a payment outcome may still be recorded against. */
export const OUTCOME_STATES: readonly InterventionState[] = ["CONVERTED", "NOT_CONVERTED"];

/**
 * Legal transitions.
 *
 * APPROVED does not lead straight to EXECUTED. The executor must pass through
 * EXECUTING, having cleared PRE_EXECUTION guardrails first: approval is a
 * human's consent, not permission to skip the final check.
 *
 * EXECUTED leads to OBSERVING, which is where an intervention waits for a
 * payment that may never come. Nothing here reaches CONVERTED — that requires
 * a real payment event, and belongs to the attribution phase.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<InterventionState, readonly InterventionState[]>> = {
  DRAFT: ["PROPOSED", "CANCELLED"],
  PROPOSED: ["PENDING_APPROVAL", "GUARDRAIL_BLOCKED", "CANCELLED", "EXPIRED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED", "GUARDRAIL_BLOCKED"],
  APPROVED: ["EXECUTING", "GUARDRAIL_BLOCKED", "CANCELLED"],
  GUARDRAIL_BLOCKED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  EXECUTING: ["EXECUTED", "EXECUTION_FAILED"],
  // EXECUTED means the action was created at the provider. It does NOT mean
  // money was recovered; OBSERVING is where it waits to find out.
  EXECUTED: ["OBSERVING"],
  // A bounded retry may re-enter EXECUTING, but only via the executor, which
  // re-runs the guardrails first.
  EXECUTION_FAILED: ["EXECUTING", "CANCELLED"],
  // Reached only from a verified payment event, via the attribution engine.
  // Nothing in the application may set these directly.
  OBSERVING: ["CONVERTED", "NOT_CONVERTED"],
  // LEARNED is terminal, which is what makes the PlaybookStat update
  // idempotent: the transition can only ever happen once.
  CONVERTED: ["LEARNED"],
  NOT_CONVERTED: ["LEARNED"],
  LEARNED: [],
};

export type TransitionCheck =
  | { allowed: true }
  | { allowed: false; reason: string; code: TransitionErrorCode };

export type TransitionErrorCode =
  | "ILLEGAL_TRANSITION"
  | "TERMINAL_STATE"
  | "STALE_VERSION"
  | "EXPIRED";

export function isTerminal(state: InterventionState): boolean {
  return TERMINAL_STATES.includes(state);
}

/** Is this move legal, ignoring version and expiry? */
export function canTransition(
  from: InterventionState,
  to: InterventionState,
): TransitionCheck {
  if (from === to) {
    return {
      allowed: false,
      code: "ILLEGAL_TRANSITION",
      reason: `Intervention is already ${from}.`,
    };
  }
  if (isTerminal(from)) {
    return {
      allowed: false,
      code: "TERMINAL_STATE",
      reason: `${from} is terminal; no further transitions are permitted.`,
    };
  }
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return {
      allowed: false,
      code: "ILLEGAL_TRANSITION",
      reason: `Cannot move from ${from} to ${to}.`,
    };
  }
  return { allowed: true };
}

export interface TransitionRequest {
  from: InterventionState;
  to: InterventionState;
  /** Version the caller read. Guards against two approvers racing. */
  expectedVersion: number;
  currentVersion: number;
  expiresAt: Date | null;
  evaluatedAt: Date;
}

/**
 * The full gate: legality, optimistic lock, and expiry.
 *
 * Version is checked BEFORE expiry so a stale caller is told their view is out
 * of date rather than being handed a confusing expiry error about a record they
 * were not looking at.
 */
export function checkTransition(request: TransitionRequest): TransitionCheck {
  const legality = canTransition(request.from, request.to);
  if (!legality.allowed) return legality;

  if (request.expectedVersion !== request.currentVersion) {
    return {
      allowed: false,
      code: "STALE_VERSION",
      reason:
        `This intervention changed since you loaded it ` +
        `(you have version ${request.expectedVersion}, current is ${request.currentVersion}). ` +
        "Reload and review it again before deciding.",
    };
  }

  // An expired proposal may still be moved INTO a terminal state; it simply
  // cannot be approved.
  if (
    request.expiresAt !== null &&
    request.expiresAt.getTime() <= request.evaluatedAt.getTime() &&
    request.to === "APPROVED"
  ) {
    return {
      allowed: false,
      code: "EXPIRED",
      reason: `This proposal expired at ${request.expiresAt.toISOString()} and can no longer be approved.`,
    };
  }

  return { allowed: true };
}

/** Has a pending proposal lapsed as of the given instant? */
export function isExpired(
  state: InterventionState,
  expiresAt: Date | null,
  evaluatedAt: Date,
): boolean {
  if (expiresAt === null) return false;
  if (isTerminal(state)) return false;
  return expiresAt.getTime() <= evaluatedAt.getTime();
}
