import { NextResponse } from "next/server";

import { requireSession } from "@/server/auth/session";
import { route } from "@/server/api/handler";
import { listInterventions } from "@/server/services/read.service";

export async function GET(request: Request) {
  return route(async () => {
    const session = await requireSession();
    const state = new URL(request.url).searchParams.get("state");
    return NextResponse.json({
      data: await listInterventions(session.merchantId, state ?? undefined),
    });
  });
}
