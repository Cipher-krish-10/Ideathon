import { NextResponse } from "next/server";

import { z } from "zod";

import { parseJson, route } from "@/server/api/handler";
import { requireRole } from "@/server/auth/session";
import { executeIntervention } from "@/server/services/execution.service";

const bodySchema = z.object({ version: z.number().int().min(0) });

/**
 * Execute an approved intervention.
 *
 * Not an arbitrary action endpoint. Every gate is server-side and none can be
 * skipped by calling the API directly: role, version, APPROVED state, a real
 * Approval row, PRE_EXECUTION guardrails, and test-mode enforcement — plus the
 * database trigger underneath, which refuses an execution state regardless.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const session = await requireRole("APPROVER", "ADMIN");
    const { id } = await context.params;
    const body = await parseJson(request, bodySchema);

    const outcome = await executeIntervention(id, {
      userId: session.userId,
      expectedVersion: body.version,
    });

    // A guardrail block is an expected outcome, not a server error.
    return NextResponse.json({ data: outcome });
  });
}
