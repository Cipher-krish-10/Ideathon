import { NextResponse } from "next/server";

import { route } from "@/server/api/handler";
import { requireSession } from "@/server/auth/session";
import { listAuditEntries } from "@/server/services/read.service";

export async function GET(request: Request) {
  return route(async () => {
    const session = await requireSession();
    const limit = Number(new URL(request.url).searchParams.get("limit") ?? 100);
    return NextResponse.json({
      data: await listAuditEntries(session.merchantId, Math.min(Math.max(limit, 1), 500)),
    });
  });
}
