import { NextResponse } from "next/server";

import { requireSession } from "@/server/auth/session";
import { route } from "@/server/api/handler";
import { listOpportunities } from "@/server/services/read.service";

export async function GET() {
  return route(async () => {
    const session = await requireSession();
    return NextResponse.json({ data: await listOpportunities(session.merchantId) });
  });
}
