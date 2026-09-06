import { NextResponse } from "next/server";

import { z } from "zod";

import { parseJson, route } from "@/server/api/handler";
import { requireRole } from "@/server/auth/session";
import { transitionIntervention } from "@/server/services/intervention-state.service";

const bodySchema = z.object({
  version: z.number().int().min(0),
  reason: z.string().max(1_000).optional(),
});

/** Pre-execution abort. Terminal, and records who called it off. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const session = await requireRole("APPROVER", "ADMIN");
    const { id } = await context.params;
    const body = await parseJson(request, bodySchema);

    const result = await transitionIntervention(id, {
      to: "CANCELLED",
      expectedVersion: body.version,
      actorType: "USER",
      actorId: session.userId,
      action: "INTERVENTION_CANCELLED",
      metadata: { reason: body.reason ?? null },
      data: { closedAt: new Date() },
    });
    return NextResponse.json({ data: { status: "CANCELLED", ...result } });
  });
}
