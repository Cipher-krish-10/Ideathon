import { NextResponse } from "next/server";

import { z } from "zod";

import { parseJson, route } from "@/server/api/handler";
import { requireRole } from "@/server/auth/session";
import { rejectIntervention } from "@/server/services/approval.service";

const bodySchema = z.object({
  version: z.number().int().min(0),
  reason: z.string().min(1).max(1_000),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const session = await requireRole("APPROVER", "ADMIN");
    const { id } = await context.params;
    const body = await parseJson(request, bodySchema);

    const result = await rejectIntervention(id, {
      userId: session.userId,
      expectedVersion: body.version,
      reason: body.reason,
    });
    return NextResponse.json({ data: { status: "REJECTED", ...result } });
  });
}
