import "server-only";

import type { InterventionState } from "@/core/state-machine";
import { checkTransition, isExpired } from "@/core/state-machine";
import type { ActorType, Prisma } from "@/generated/prisma/client";
import { appendAuditEntry } from "@/server/audit/audit-logger";
import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";

/**
 * Transactional state transitions.
 *
 * Every transition validates the current state, checks the optimistic lock,
 * writes the new state, and appends an audit entry — all in ONE transaction.
 * A state change without its audit row would be a decision nobody can account
 * for, so the two cannot come apart.
 */

export class TransitionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly currentVersion?: number,
    readonly currentState?: InterventionState,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

export interface TransitionOptions {
  to: InterventionState;
  expectedVersion: number;
  actorType: ActorType;
  actorId?: string | null;
  action: string;
  /** Extra context recorded on the audit entry. */
  metadata?: Record<string, unknown>;
  /** Fields to write alongside the state change. */
  data?: Prisma.InterventionUpdateInput;
  evaluatedAt?: Date;
  client?: PrismaClient;
  /**
   * Extra work to run INSIDE the transition's transaction.
   *
   * Used by the LEARN step so a counter update and the state change that
   * authorises it cannot come apart — either both land or neither does.
   */
  onCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
}

export interface TransitionResult {
  interventionId: string;
  from: InterventionState;
  to: InterventionState;
  version: number;
  auditSeq: bigint;
}

export async function transitionIntervention(
  interventionId: string,
  options: TransitionOptions,
): Promise<TransitionResult> {
  const db = options.client ?? prisma;
  const evaluatedAt = options.evaluatedAt ?? new Date();

  return db.$transaction(async (tx) => {
    // Lock the row for the life of the transaction so two approvers cannot both
    // read version N and both write N+1.
    const locked = await tx.$queryRaw<Array<{ id: string; state: InterventionState; version: number }>>`
      SELECT "id", "state"::text AS state, "version"
        FROM "intervention" WHERE "id" = ${interventionId} FOR UPDATE`;

    const current = locked[0];
    if (!current) throw new TransitionError(`Unknown intervention: ${interventionId}`, "NOT_FOUND");

    const intervention = await tx.intervention.findUniqueOrThrow({
      where: { id: interventionId },
      select: { expiresAt: true, merchantId: true },
    });

    const check = checkTransition({
      from: current.state,
      to: options.to,
      expectedVersion: options.expectedVersion,
      currentVersion: current.version,
      expiresAt: intervention.expiresAt,
      evaluatedAt,
    });

    if (!check.allowed) {
      throw new TransitionError(check.reason, check.code, current.version, current.state);
    }

    const updated = await tx.intervention.update({
      where: { id: interventionId },
      data: {
        ...options.data,
        state: options.to,
        version: { increment: 1 },
      },
      select: { version: true },
    });

    const audit = await appendAuditEntry(tx, {
      merchantId: intervention.merchantId,
      actorType: options.actorType,
      actorId: options.actorId ?? null,
      entityType: "Intervention",
      entityId: interventionId,
      action: options.action,
      before: { state: current.state, version: current.version },
      after: { state: options.to, version: updated.version, ...(options.metadata ?? {}) },
    });

    if (options.onCommit) await options.onCommit(tx);

    return {
      interventionId,
      from: current.state,
      to: options.to,
      version: updated.version,
      auditSeq: audit.seq,
    };
  });
}

/**
 * Lapse a proposal that has passed its expiry.
 *
 * Checked at request time rather than by a background job: for the MVP that is
 * enough, and it keeps the expiry deterministic — an intervention is expired
 * exactly when someone looks at it after `expiresAt`, not whenever a worker
 * happened to wake up.
 */
export async function expireIfLapsed(
  interventionId: string,
  options: { evaluatedAt?: Date; client?: PrismaClient } = {},
): Promise<TransitionResult | null> {
  const db = options.client ?? prisma;
  const evaluatedAt = options.evaluatedAt ?? new Date();

  const intervention = await db.intervention.findUnique({
    where: { id: interventionId },
    select: { state: true, version: true, expiresAt: true },
  });
  if (!intervention) return null;
  if (!isExpired(intervention.state, intervention.expiresAt, evaluatedAt)) return null;

  return transitionIntervention(interventionId, {
    to: "EXPIRED",
    expectedVersion: intervention.version,
    actorType: "SYSTEM",
    action: "INTERVENTION_EXPIRED",
    metadata: { expiresAt: intervention.expiresAt?.toISOString() ?? null },
    data: { closedAt: evaluatedAt },
    evaluatedAt,
    client: db,
  });
}
