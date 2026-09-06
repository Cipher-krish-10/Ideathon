import { NextResponse } from "next/server";

import { route } from "@/server/api/handler";
import { requireSession } from "@/server/auth/session";
import { getEnv } from "@/lib/env";
import { getActivityFeed, getSimulationState } from "@/server/services/simulation";

/** Clock + activity feed for the command centre. */
export async function GET() {
  return route(async () => {
    const session = await requireSession();
    const [state, activity] = await Promise.all([
      getSimulationState(session.merchantId),
      getActivityFeed(session.merchantId),
    ]);

    return NextResponse.json({
      data: {
        simulation: {
          baselineAt: state.baselineAt.toISOString(),
          simulatedNow: state.simulatedNow.toISOString(),
          status: state.status,
          advancedMinutes: state.advancedMinutes,
        },
        activity,
        // The controls are a demo convenience, never an authority layer.
        controlsEnabled: getEnv().DEMO_MODE,
      },
    });
  });
}
