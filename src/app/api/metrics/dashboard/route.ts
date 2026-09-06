import { NextResponse } from "next/server";

import { route } from "@/server/api/handler";
import { requireSession } from "@/server/auth/session";
import { getDashboardMetrics } from "@/server/services/read.service";

export async function GET() {
  return route(async () => {
    const session = await requireSession();
    return NextResponse.json({ data: await getDashboardMetrics(session.merchantId) });
  });
}
