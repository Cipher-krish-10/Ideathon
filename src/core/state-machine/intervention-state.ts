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

/**
 * Legal transitions for THIS phase.
 *
 * APPROVED intentionally leads only to GUARDRAIL_BLOCKED. Approval is not
 * permission to act: the executor must clear PRE_EXECUTION guardrails, and
 * until that component exists an approved intervention simply waits.
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<InterventionState, readonly InterventionState[]>> = {
  DRAFT: ["PROPOSED", "CANCELLED"],
  PROPOSED: ["PENDING_APPROVAL", "GUARDRAIL_BLOCKED", "CANCELLED", "EXPIRED"],
  PENDING_APPROVAL: ["APPROVED", "REJECTED", "EXPIRED", "CANCELLED", "GUARDRAIL_BLOCKED"],
  APPROVED: ["GUARDRAIL_BLOCKED"],
  GUARDRAIL_BLOCKED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
  // Reserved for the execution phase; unreachable from here.
  EXECUTING: [],
  EXECUTED: [],
  EXECUTION_FAILED: [],
  OBSERVING: [],
  CONVERTED: [],
  NOT_CONVERTED: [],
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
