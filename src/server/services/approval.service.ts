import "server-only";

import type { GuardrailEvaluationResult } from "@/core/guardrails";
import type { Prisma } from "@/generated/prisma/client";
import { appendAuditEntry } from "@/server/audit/audit-logger";
import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";
import { evaluateInterventionGuardrails } from "./guardrail.service";
import {
  TransitionError,
  expireIfLapsed,
  transitionIntervention,
} from "./intervention-state.service";

/**
 * The human gate.
 *
 * Nothing here executes anything, and nothing here can. There is no payment
 * provider in the codebase, and the database independently refuses any
 * execution state. Approval means "a human agreed", not "it happened".
 */

/** States in which a human decision is still open. */
const DECIDABLE_STATES: readonly string[] = ["PROPOSED", "PENDING_APPROVAL"];

export interface EditedMessage {
  subject: string;
  body: string;
}

export interface ApproveOptions {
  userId: string;
  expectedVersion: number;
  /** Text-only edits. Financial parameters are not editable through this path. */
  editedMessage?: EditedMessage;
  note?: string;
  evaluatedAt?: Date;
  client?: PrismaClient;
}

export type ApprovalOutcome =
  | {
      status: "APPROVED";
      interventionId: string;
      approvalId: string;
      version: number;
      evaluation: GuardrailEvaluationResult;
    }
  | {
      status: "BLOCKED";
      interventionId: string;
      version: number;
      evaluation: GuardrailEvaluationResult;
      blockingRules: readonly { ruleId: string; message: string }[];
    }
  | { status: "EXPIRED"; interventionId: string; version: number };

/**
 * Approve an intervention.
 *
 * Order matters and is deliberate:
 *   1. lapse the proposal if it has expired
 *   2. re-run the guardrails against CURRENT state (PRE_EXECUTION)
 *   3. on BLOCK, record the evaluation, move to GUARDRAIL_BLOCKED, create NO
 *      Approval row, and stop
 *   4. otherwise create the Approval and transition to APPROVED
 *
 * Step 2 is the point of the whole design. The state a merchant reviewed may
 * not be the state that exists when they click: budget gets consumed, consent
 * gets withdrawn, another intervention contacts the same customer. Approving
 * against a stale reading is exactly how an agent does something nobody meant.
 */
export async function approveIntervention(
  interventionId: string,
  options: ApproveOptions,
): Promise<ApprovalOutcome> {
  const db = options.client ?? prisma;
  const evaluatedAt = options.evaluatedAt ?? new Date();

  const lapsed = await expireIfLapsed(interventionId, { evaluatedAt, client: db });
  if (lapsed) {
    return { status: "EXPIRED", interventionId, version: lapsed.version };
  }

  const current = await db.intervention.findUnique({
    where: { id: interventionId },
    select: { id: true, merchantId: true, state: true, version: true, customerMessage: true },
  });
  if (!current) throw new TransitionError(`Unknown intervention: ${interventionId}`, "NOT_FOUND");

  if (current.version !== options.expectedVersion) {
    throw new TransitionError(
      `This intervention changed since you loaded it (you have version ` +
        `${options.expectedVersion}, current is ${current.version}). Reload and review it again.`,
      "STALE_VERSION",
      current.version,
      current.state,
    );
  }

  // Only an undecided proposal may be decided. Without this, a second approval
  // would run the guardrails and then fail on a unique constraint -- a database
  // error where the honest answer is "this was already decided".
  if (!DECIDABLE_STATES.includes(current.state)) {
    throw new TransitionError(
      `This intervention is ${current.state} and can no longer be approved.`,
      "ILLEGAL_TRANSITION",
      current.version,
      current.state,
    );
  }

  // ---- PRE_EXECUTION guardrails, against state as it is right now ----------
  const { evaluation } = await evaluateInterventionGuardrails(interventionId, {
    phase: "PRE_EXECUTION",
    evaluatedAt,
    client: db,
  });

  if (evaluation.blocked) {
    const blocked = await transitionIntervention(interventionId, {
      to: "GUARDRAIL_BLOCKED",
      expectedVersion: current.version,
      actorType: "USER",
      actorId: options.userId,
      action: "APPROVAL_BLOCKED_BY_GUARDRAIL",
      metadata: {
        phase: "PRE_EXECUTION",
        decision: evaluation.decision,
        policyVersion: evaluation.policyVersion,
        blockingRules: evaluation.failures
          .filter((failure) => failure.severity === "BLOCK")
          .map((failure) => ({
            ruleId: failure.ruleId, observed: failure.observed, limit: failure.limit,
          })),
      },
      data: { closedAt: evaluatedAt },
      evaluatedAt,
      client: db,
    });

    return {
      status: "BLOCKED",
      interventionId,
      version: blocked.version,
      evaluation,
      blockingRules: evaluation.failures
        .filter((failure) => failure.severity === "BLOCK")
        .map((failure) => ({ ruleId: failure.ruleId, message: failure.message })),
    };
  }

  // ---- Approve --------------------------------------------------------------
  const message = current.customerMessage as Record<string, unknown> | null;
  const edited = options.editedMessage;

  const approvalId = await db.$transaction(async (tx) => {
    const approval = await tx.approval.create({
      data: {
        merchantId: current.merchantId,
        interventionId,
        userId: options.userId,
        decision: "APPROVED",
        note: options.note ?? null,
        // The original AI draft stays on the Intervention; the edit is recorded
        // separately so the diff is always visible in the audit trail.
        editedMessage: (edited
          ? { subject: edited.subject, body: edited.body }
          : undefined) as Prisma.InputJsonValue | undefined,
        interventionVersion: current.version,
        decidedAt: evaluatedAt,
      },
      select: { id: true },
    });

    await appendAuditEntry(tx, {
      merchantId: current.merchantId,
      actorType: "USER",
      actorId: options.userId,
      entityType: "Approval",
      entityId: approval.id,
      action: "APPROVAL_RECORDED",
      after: {
        interventionId,
        decision: "APPROVED",
        interventionVersion: current.version,
        messageEdited: Boolean(edited),
        ...(edited && message
          ? {
              subjectChanged: edited.subject !== message.subject,
              bodyChanged: edited.body !== message.body,
            }
          : {}),
      },
    });

    return approval.id;
  });

  const approved = await transitionIntervention(interventionId, {
    to: "APPROVED",
    expectedVersion: current.version,
    actorType: "USER",
    actorId: options.userId,
    action: "INTERVENTION_APPROVED",
    metadata: {
      approvalId,
      policyVersion: evaluation.policyVersion,
      guardrailDecision: evaluation.decision,
      messageEdited: Boolean(edited),
    },
    data: {
      approvedAt: evaluatedAt,
      // The edited copy is what a future executor will send.
      ...(edited
        ? {
            customerMessage: {
              ...(message ?? {}),
              subject: edited.subject,
              body: edited.body,
              originalSubject: message?.subject ?? null,
              originalBody: message?.body ?? null,
              editedByUserId: options.userId,
              editedAt: evaluatedAt.toISOString(),
            } as Prisma.InputJsonObject,
          }
        : {}),
    },
    evaluatedAt,
    client: db,
  });

  return {
    status: "APPROVED",
    interventionId,
    approvalId,
    version: approved.version,
    evaluation,
  };
}

export interface RejectOptions {
  userId: string;
  expectedVersion: number;
  reason: string;
  evaluatedAt?: Date;
  client?: PrismaClient;
}

/** Reject an intervention. Terminal for this MVP. */
export async function rejectIntervention(
  interventionId: string,
  options: RejectOptions,
): Promise<{ interventionId: string; approvalId: string; version: number }> {
  const db = options.client ?? prisma;
  const evaluatedAt = options.evaluatedAt ?? new Date();

  const current = await db.intervention.findUnique({
    where: { id: interventionId },
    select: { merchantId: true, version: true, state: true },
  });
  if (!current) throw new TransitionError(`Unknown intervention: ${interventionId}`, "NOT_FOUND");

  if (!DECIDABLE_STATES.includes(current.state)) {
    throw new TransitionError(
      `This intervention is ${current.state} and can no longer be rejected.`,
      "ILLEGAL_TRANSITION",
      current.version,
      current.state,
    );
  }

  const approvalId = await db.$transaction(async (tx) => {
    const approval = await tx.approval.create({
      data: {
        merchantId: current.merchantId,
        interventionId,
        userId: options.userId,
        decision: "REJECTED",
        note: options.reason,
        interventionVersion: options.expectedVersion,
        decidedAt: evaluatedAt,
      },
      select: { id: true },
    });
    await appendAuditEntry(tx, {
      merchantId: current.merchantId,
      actorType: "USER",
      actorId: options.userId,
      entityType: "Approval",
      entityId: approval.id,
      action: "REJECTION_RECORDED",
      after: { interventionId, decision: "REJECTED", reason: options.reason },
    });
    return approval.id;
  });

  const rejected = await transitionIntervention(interventionId, {
    to: "REJECTED",
    expectedVersion: options.expectedVersion,
    actorType: "USER",
    actorId: options.userId,
    action: "INTERVENTION_REJECTED",
    metadata: { approvalId, reason: options.reason },
    data: { closedAt: evaluatedAt },
    evaluatedAt,
    client: db,
  });

  return { interventionId, approvalId, version: rejected.version };
}

/**
 * Move a fresh proposal through PRE_APPROVAL guardrails.
 *
 * PASS, WARN, and REQUIRE_APPROVAL all lead to PENDING_APPROVAL — a human sees
 * every one of them. Only BLOCK stops the proposal here.
 */
export async function submitForApproval(
  interventionId: string,
  options: { evaluatedAt?: Date; client?: PrismaClient; expiresInHours?: number } = {},
): Promise<{
  interventionId: string;
  state: "PENDING_APPROVAL" | "GUARDRAIL_BLOCKED";
  version: number;
  evaluation: GuardrailEvaluationResult;
}> {
  const db = options.client ?? prisma;
  const evaluatedAt = options.evaluatedAt ?? new Date();

  const current = await db.intervention.findUnique({
    where: { id: interventionId },
    select: { version: true, state: true, expiresAt: true },
  });
  if (!current) throw new TransitionError(`Unknown intervention: ${interventionId}`, "NOT_FOUND");

  const { evaluation } = await evaluateInterventionGuardrails(interventionId, {
    phase: "PRE_APPROVAL",
    evaluatedAt,
    client: db,
  });

  const target = evaluation.blocked ? "GUARDRAIL_BLOCKED" : "PENDING_APPROVAL";
  const expiresAt =
    current.expiresAt ??
    new Date(evaluatedAt.getTime() + (options.expiresInHours ?? 72) * 3_600_000);

  const result = await transitionIntervention(interventionId, {
    to: target,
    expectedVersion: current.version,
    actorType: "AGENT",
    action: evaluation.blocked
      ? "PROPOSAL_BLOCKED_BY_GUARDRAIL"
      : "PROPOSAL_SUBMITTED_FOR_APPROVAL",
    metadata: {
      phase: "PRE_APPROVAL",
      decision: evaluation.decision,
      policyVersion: evaluation.policyVersion,
      failedRules: evaluation.failures.map((f) => f.ruleId),
    },
    data: evaluation.blocked ? { closedAt: evaluatedAt } : { expiresAt },
    evaluatedAt,
    client: db,
  });

  return { interventionId, state: target, version: result.version, evaluation };
}
