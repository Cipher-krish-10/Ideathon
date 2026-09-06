import { NextResponse } from "next/server";

import { jsonError, route } from "@/server/api/handler";
import { requireSession } from "@/server/auth/session";
import { getOpportunityDetail } from "@/server/services/read.service";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async () => {
    const session = await requireSession();
    const { id } = await context.params;
    const detail = await getOpportunityDetail(session.merchantId, id);
    if (!detail) return jsonError("NOT_FOUND", "Opportunity not found.", 404);
    return NextResponse.json({ data: detail });
  });
}
