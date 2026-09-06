import "server-only";

import { createHash } from "node:crypto";

import type { ActorType, Prisma } from "@/generated/prisma/client";
import type { PrismaClient } from "@/server/db";

/**
 * Append-only, hash-chained audit log.
 *
 * ARCHITECTURE.md promised the table would exist from the start and the writer
 * would arrive with the first thing that emits events. This is that writer.
 *
 * Each entry commits to its predecessor:
 *
 *     hash = sha256(seq : prevHash : canonicalJson(payload))
 *
 * so editing any historical row invalidates every row after it. The database
 * refuses UPDATE outright and refuses DELETE without an explicit session flag,
 * which makes "complete audit trail" a property you can verify rather than a
 * sentence in a pitch.
 */

export const GENESIS_HASH = "0".repeat(64);

type TxClient = Prisma.TransactionClient;

export interface AuditEntryInput {
  merchantId: string;
  actorType: ActorType;
  actorId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
}

/**
 * Deterministic JSON: object keys sorted at every depth.
 *
 * The hash must be reproducible from the stored payload, and JavaScript's
 * insertion-ordered keys would otherwise make an identical payload hash
 * differently depending on how it was built.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computeEntryHash(
  seq: bigint,
  prevHash: string,
  payload: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(`${seq.toString()}:${prevHash}:${canonicalJson(payload)}`)
    .digest("hex");
}

/**
 * Append one entry. MUST run inside a transaction.
 *
 * Takes a per-merchant advisory lock so two concurrent writers cannot read the
 * same tip and produce a forked chain. Without it the unique (merchantId, seq)
 * index would reject the loser — correct, but a needless failure.
 */
export async function appendAuditEntry(
  tx: TxClient,
  entry: AuditEntryInput,
): Promise<{ id: string; seq: bigint; hash: string }> {
  await tx.$executeRawUnsafe(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    `revenuepilot.audit.${entry.merchantId}`,
  );

  const tip = await tx.auditLog.findFirst({
    where: { merchantId: entry.merchantId },
    orderBy: { seq: "desc" },
    select: { seq: true, hash: true },
  });

  const seq = (tip?.seq ?? 0n) + 1n;
  const prevHash = tip?.hash ?? GENESIS_HASH;

  const payload: Record<string, unknown> = {
    merchantId: entry.merchantId,
    actorType: entry.actorType,
    actorId: entry.actorId ?? null,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    before: entry.before ?? null,
    after: entry.after ?? null,
  };

  const hash = computeEntryHash(seq, prevHash, payload);

  const created = await tx.auditLog.create({
    data: {
      merchantId: entry.merchantId,
      seq,
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      before: (entry.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (entry.after ?? undefined) as Prisma.InputJsonValue | undefined,
      prevHash,
      hash,
    },
    select: { id: true, seq: true, hash: true },
  });

  return created;
}

export interface ChainVerification {
  valid: boolean;
  entryCount: number;
  /** Sequence number of the first entry that failed, if any. */
  brokenAtSeq: bigint | null;
  reason: string | null;
}

/**
 * Recompute the whole chain and report whether it still holds.
 *
 * Cheap, and it turns the audit claim into something demonstrable: the UI can
 * say "integrity verified — N events" and mean it.
 */
export async function verifyAuditChain(
  db: PrismaClient,
  merchantId: string,
): Promise<ChainVerification> {
  const entries = await db.auditLog.findMany({
    where: { merchantId },
    orderBy: { seq: "asc" },
  });

  let expectedPrevHash = GENESIS_HASH;
  let expectedSeq = 1n;

  for (const entry of entries) {
    if (entry.seq !== expectedSeq) {
      return {
        valid: false,
        entryCount: entries.length,
        brokenAtSeq: entry.seq,
        reason: `Expected seq ${expectedSeq}, found ${entry.seq}`,
      };
    }
    if (entry.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        entryCount: entries.length,
        brokenAtSeq: entry.seq,
        reason: "prevHash does not match the preceding entry's hash",
      };
    }

    const recomputed = computeEntryHash(entry.seq, entry.prevHash, {
      merchantId: entry.merchantId,
      actorType: entry.actorType,
      actorId: entry.actorId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
    if (recomputed !== entry.hash) {
      return {
        valid: false,
        entryCount: entries.length,
        brokenAtSeq: entry.seq,
        reason: "Recomputed hash does not match the stored hash",
      };
    }

    expectedPrevHash = entry.hash;
    expectedSeq += 1n;
  }

  return { valid: true, entryCount: entries.length, brokenAtSeq: null, reason: null };
}
