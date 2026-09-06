import { NextResponse } from "next/server";

import { z } from "zod";

import { jsonError, parseJson, route } from "@/server/api/handler";
import { SESSION_COOKIE, getSession, listDemoUsers } from "@/server/auth/session";

export async function GET() {
  return route(async () => {
    const [session, users] = await Promise.all([getSession(), listDemoUsers()]);
    return NextResponse.json({
      data: {
        current: session,
        // Demo-only role switching, so the 403 path can be shown on stage.
        available: users.map((user) => ({
          userId: user.userId, name: user.name, role: user.role,
        })),
      },
    });
  });
}

const bodySchema = z.object({ userId: z.string().min(1) });

export async function POST(request: Request) {
  return route(async () => {
    const body = await parseJson(request, bodySchema);
    const users = await listDemoUsers();
    const user = users.find((candidate) => candidate.userId === body.userId);
    if (!user) return jsonError("NOT_FOUND", "Unknown demo user.", 404);

    const response = NextResponse.json({ data: { current: user } });
    response.cookies.set(SESSION_COOKIE, user.userId, {
      httpOnly: true, sameSite: "lax", path: "/",
    });
    return response;
  });
}
