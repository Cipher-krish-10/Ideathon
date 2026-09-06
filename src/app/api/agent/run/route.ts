import { NextResponse } from "next/server";

import { requireRole } from "@/server/auth/session";
import { route } from "@/server/api/handler";
import { runAgentCycle } from "@/server/services/agent-run.service";

/** Run the full OBSERVE -> REASON -> PLAN -> GUARDRAIL cycle. */
export async function POST(request: Request) {
  return route(async () => {
    // Running the agent creates a proposal a human will be asked to approve,
    // so it is not a viewer-level action.
    const session = await requireRole("APPROVER", "ADMIN");
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "true";

    const result = await runAgentCycle(session.merchantId, { force });
    return NextResponse.json({ data: result });
  });
}
