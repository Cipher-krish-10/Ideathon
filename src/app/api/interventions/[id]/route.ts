import { NextResponse } from "next/server";

import { jsonError, route } from "@/server/api/handler";
import { requireSession } from "@/server/auth/session";
import { getDecisionPacket } from "@/server/services/read.service";

/** The decision packet: everything a merchant needs to decide, in one payload. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const packet = await getDecisionPacket(session.merchantId, id);
    if (!packet) return jsonError("NOT_FOUND", "Intervention not found.", 404);
    return NextResponse.json({ data: packet });
  });
}
