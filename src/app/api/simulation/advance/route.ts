import { NextResponse } from "next/server";

import { z } from "zod";

import { jsonError, parseJson, route } from "@/server/api/handler";
import { requireRole } from "@/server/auth/session";
import { getEnv } from "@/lib/env";
import { advanceSimulationTime } from "@/server/services/simulation";

const bodySchema = z.object({ minutes: z.number().int().min(1).max(1_440) });

/**
 * Move the demo clock forward.
 *
 * Presentation only: no detector, estimator, guardrail or attribution logic
 * reads this clock, so advancing it cannot change a financial outcome.
 */
export async function POST(request: Request) {
  return route(async () => {
    if (!getEnv().DEMO_MODE) {
      return jsonError("NOT_AVAILABLE", "Simulation controls require DEMO_MODE.", 403);
    }
    const session = await requireRole("APPROVER", "ADMIN");
    const body = await parseJson(request, bodySchema);

    const state = await advanceSimulationTime(session.merchantId, body.minutes);
    return NextResponse.json({
      data: {
        simulatedNow: state.simulatedNow.toISOString(),
        advancedMinutes: state.advancedMinutes,
      },
    });
  });
}
