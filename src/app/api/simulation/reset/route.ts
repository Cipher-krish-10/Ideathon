import { NextResponse } from "next/server";

import { jsonError, route } from "@/server/api/handler";
import { requireRole } from "@/server/auth/session";
import { getEnv } from "@/lib/env";
import { resetDemoState } from "@/server/services/simulation";

/**
 * Reset the demo to its deterministic baseline.
 *
 * Removes what the agent produced; never touches the merchant's historical
 * records or data/*.csv. See reset.service.ts for the exact list.
 */
export async function POST() {
  return route(async () => {
    if (!getEnv().DEMO_MODE) {
      return jsonError("NOT_AVAILABLE", "Simulation controls require DEMO_MODE.", 403);
    }
    const session = await requireRole("APPROVER", "ADMIN");
    const summary = await resetDemoState(session.merchantId);
    return NextResponse.json({ data: summary });
  });
}
