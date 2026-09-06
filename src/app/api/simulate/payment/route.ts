import { NextResponse } from "next/server";

import { z } from "zod";

import { jsonError, parseJson, route } from "@/server/api/handler";
import { requireRole } from "@/server/auth/session";
import { getEnv } from "@/lib/env";
import { simulatePaymentForArtifact } from "@/server/services/simulation.service";

const bodySchema = z.object({ artifactId: z.string().min(1) });

/**
 * Demo-only payment simulation.
 *
 * Enters through the webhook boundary — it cannot mark anything CONVERTED
 * directly. See simulation.service.ts.
 */
export async function POST(request: Request) {
  return route(async () => {
    // Gated: this must not exist outside a demo environment.
    if (!getEnv().DEMO_MODE) {
      return jsonError("NOT_AVAILABLE", "Payment simulation requires DEMO_MODE.", 403);
    }
    await requireRole("APPROVER", "ADMIN");

    const body = await parseJson(request, bodySchema);
    const result = await simulatePaymentForArtifact(body.artifactId);

    if (result.status === "NOT_FOUND") return jsonError("NOT_FOUND", result.message, 404);
    if (result.status === "NOT_SIMULATABLE") {
      return jsonError("NOT_SIMULATABLE", result.message, 422);
    }
    return NextResponse.json({ data: result });
  });
}
