import "server-only";

import { prisma } from "@/server/db";
import type { PrismaClient } from "@/server/db";

/**
 * One clock for the whole product.
 *
 * PRESENTATION ONLY. Nothing here is persisted and nothing in the detector,
 * estimator, guardrail engine or attribution engine reads it. Rows keep their
 * real `createdAt` — they must, an audit record that lies about when it was
 * written is worthless.
 *
 * The problem this solves is a display one. The merchant's synthetic history
 * ends at a known instant, and the header shows a simulation clock anchored
 * there. But rows are written at real wall-clock time, which is whenever the
 * demo happens to be running. Showing both meant the header said
 * "1 Sept 2026, 11:59 pm" while the tables underneath said "8 Sept 2026,
 * 4:21 am" — two clocks, no explanation, and nothing to tell the reader which
 * one means anything.
 *
 * So session events are projected onto the simulation clock: the session's
 * FIRST audited event sits at the baseline instant, and every later event is
 * offset by the real time that actually elapsed after it. Spacing between
 * events is therefore real — only the origin moves. Anchoring to the oldest
 * event rather than to "now" keeps timestamps stable, so they do not shift
 * under a table every time the page polls.
 */
export interface SessionProjection {
  /** Project a real instant onto the simulation clock. */
  project(real: Date): Date;
  /** Simulation-clock ISO string, or null when there is nothing to project. */
  projectIso(real: Date | null | undefined): string | null;
  /**
   * "Now" on the simulation clock — the instant the header shows.
   *
   * This has to be the same clock the events are on. Showing a header time of
   * 23:59 above a feed whose newest event reads 00:04 is a clock that runs
   * backwards, which is worse than having two clocks openly.
   */
  now(): Date;
}

/** A projection that leaves instants untouched, for when a session is empty. */
function identity(fallbackNow: Date): SessionProjection {
  return {
    project: (real) => real,
    projectIso: (real) => real?.toISOString() ?? null,
    now: () => fallbackNow,
  };
}

export async function getSessionProjection(
  merchantId: string,
  client: PrismaClient = prisma,
): Promise<SessionProjection> {
  const [state, first] = await Promise.all([
    client.simulationState.findUnique({
      where: { merchantId }, select: { baselineAt: true, simulatedNow: true },
    }),
    // The session's first audited event: the origin everything hangs off.
    client.auditLog.findFirst({
      where: { merchantId }, orderBy: { seq: "asc" }, select: { createdAt: true },
    }),
  ]);

  const fallbackNow = state?.simulatedNow ?? new Date();
  if (!first) return identity(fallbackNow);

  const baseline = state
    ? state.baselineAt.getTime()
    : (await client.merchant.findUnique({
        where: { id: merchantId }, select: { datasetReferenceAt: true },
      }))?.datasetReferenceAt.getTime();

  if (baseline === undefined) return identity(fallbackNow);

  const origin = first.createdAt.getTime();
  const project = (real: Date) => new Date(baseline + (real.getTime() - origin));

  /*
   * Any minutes the demo controls jumped forward. `simulatedNow` already
   * carries them, so the offset from the baseline is exactly what those
   * clicks added — and it must survive into the header, or "+5 min" would
   * appear to do nothing.
   */
  const advanced = state ? state.simulatedNow.getTime() - baseline : 0;

  return {
    project,
    projectIso: (real) => (real ? project(real).toISOString() : null),
    now: () => new Date(project(new Date()).getTime() + advanced),
  };
}
