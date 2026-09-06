import "server-only";

import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";

/**
 * The demo simulation clock.
 *
 * PRESENTATION ONLY. Nothing in the detector, estimator, guardrail engine or
 * attribution engine reads it — those judge against the dataset's own reference
 * instant, which is what keeps their answers reproducible. Wiring business
 * logic to this clock would make the demo's results depend on how many times
 * someone clicked "+5 min".
 *
 * Its job is narrower and honest: show that the historical baseline ended at a
 * known moment, and that everything after it happened during this session.
 */

export interface SimulationState {
  merchantId: string;
  /** The instant the historical baseline ends. Deterministic. */
  baselineAt: Date;
  /** Where this demo session has advanced to. */
  simulatedNow: Date;
  status: "IDLE" | "ACTIVE";
  advancedMinutes: number;
}

/**
 * Read the clock, creating it on first use.
 *
 * The starting point is the merchant's dataset reference instant — the moment
 * the synthetic history stops. So "simulation time" literally means "how far
 * past the end of the merchant's history this session has run".
 */
export async function getSimulationState(
  merchantId: string,
  client: PrismaClient = prisma,
): Promise<SimulationState> {
  const existing = await client.simulationState.findUnique({ where: { merchantId } });
  if (existing) return toState(existing);

  const merchant = await client.merchant.findUniqueOrThrow({
    where: { id: merchantId },
    select: { datasetReferenceAt: true },
  });

  const created = await client.simulationState.create({
    data: {
      merchantId,
      baselineAt: merchant.datasetReferenceAt,
      simulatedNow: merchant.datasetReferenceAt,
      status: "IDLE",
      advancedMinutes: 0,
    },
  });
  return toState(created);
}

/** Move the clock forward. It never moves backwards. */
export async function advanceSimulationTime(
  merchantId: string,
  minutes: number,
  client: PrismaClient = prisma,
): Promise<SimulationState> {
  if (!Number.isInteger(minutes) || minutes <= 0 || minutes > 1_440) {
    throw new Error("Advance must be a whole number of minutes between 1 and 1440.");
  }
  const current = await getSimulationState(merchantId, client);

  const updated = await client.simulationState.update({
    where: { merchantId },
    data: {
      simulatedNow: new Date(current.simulatedNow.getTime() + minutes * 60_000),
      advancedMinutes: { increment: minutes },
    },
  });
  return toState(updated);
}

/** Mark the agent as having run in this session. */
export async function markSimulationActive(
  merchantId: string,
  client: PrismaClient = prisma,
): Promise<void> {
  await getSimulationState(merchantId, client);
  await client.simulationState.update({
    where: { merchantId }, data: { status: "ACTIVE" },
  });
}

/** Return the clock to its deterministic starting point. */
export async function resetSimulationClock(
  merchantId: string,
  client: PrismaClient = prisma,
): Promise<SimulationState> {
  const merchant = await client.merchant.findUniqueOrThrow({
    where: { id: merchantId }, select: { datasetReferenceAt: true },
  });

  const reset = await client.simulationState.upsert({
    where: { merchantId },
    create: {
      merchantId, baselineAt: merchant.datasetReferenceAt,
      simulatedNow: merchant.datasetReferenceAt, status: "IDLE", advancedMinutes: 0,
    },
    update: {
      baselineAt: merchant.datasetReferenceAt,
      simulatedNow: merchant.datasetReferenceAt,
      status: "IDLE", advancedMinutes: 0,
    },
  });
  return toState(reset);
}

function toState(row: {
  merchantId: string; baselineAt: Date; simulatedNow: Date;
  status: string; advancedMinutes: number;
}): SimulationState {
  return {
    merchantId: row.merchantId,
    baselineAt: row.baselineAt,
    simulatedNow: row.simulatedNow,
    status: row.status === "ACTIVE" ? "ACTIVE" : "IDLE",
    advancedMinutes: row.advancedMinutes,
  };
}
