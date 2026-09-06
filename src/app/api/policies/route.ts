import { NextResponse } from "next/server";

import { z } from "zod";

import { guardrailPolicyRulesSchema } from "@/core/guardrails";
import { jsonError, parseJson, route } from "@/server/api/handler";
import { requireRole, requireSession } from "@/server/auth/session";
import { getPolicySnapshot, savePolicyVersion } from "@/server/services/policy.service";

export async function GET() {
  return route(async () => {
    const session = await requireSession();
    const snapshot = await getPolicySnapshot(session.merchantId);
    if (!snapshot) return jsonError("NOT_FOUND", "No guardrail policy found.", 404);
    return NextResponse.json({ data: snapshot });
  });
}

const putSchema = z.object({ rules: guardrailPolicyRulesSchema });

/** Editing creates a new version; the previous one is preserved. */
export async function PUT(request: Request) {
  return route(async () => {
    // Changing the limits that gate money actions is not a viewer-level action.
    const session = await requireRole("ADMIN", "APPROVER");
    const body = await parseJson(request, putSchema);
    const saved = await savePolicyVersion(session.merchantId, session.userId, body.rules);
    return NextResponse.json({ data: saved });
  });
}
