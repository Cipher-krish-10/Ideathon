import { NextResponse } from "next/server";

import { z } from "zod";

import { parseJson, route } from "@/server/api/handler";
import { requireRole } from "@/server/auth/session";
import { approveIntervention } from "@/server/services/approval.service";

const bodySchema = z.object({
  version: z.number().int().min(0),
  /** Text only. Financial parameters are deliberately not editable here. */
  editedMessage: z
    .object({ subject: z.string().min(1).max(200), body: z.string().min(1).max(4_000) })
    .optional(),
  note: z.string().max(1_000).optional(),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const session = await requireRole("APPROVER", "ADMIN");
    const { id } = await context.params;
    const body = await parseJson(request, bodySchema);

    const outcome = await approveIntervention(id, {
      userId: session.userId,
      expectedVersion: body.version,
      ...(body.editedMessage ? { editedMessage: body.editedMessage } : {}),
      ...(body.note ? { note: body.note } : {}),
    });

    // A guardrail block is a valid, expected outcome -- not a server error.
    // 200 with an explicit status keeps the UI honest about what happened.
    return NextResponse.json({ data: outcome });
  });
}
