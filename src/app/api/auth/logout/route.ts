import { NextResponse } from "next/server";
import { apiFailure, assertSameOrigin } from "@/lib/planner/http";
import { destroySession, sessionClearCookie } from "@/lib/auth/session";
import { sessionTokenFromRequest } from "@/lib/auth/require-user";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    await destroySession(await sessionTokenFromRequest(request));
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    response.headers.append("Set-Cookie", sessionClearCookie());
    return response;
  } catch (error) { return apiFailure(error); }
}
