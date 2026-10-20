import { NextResponse } from "next/server";
import { apiFailure } from "@/lib/planner/http";
import { allowedDomain, appUrl, googleClient } from "@/lib/config/env";
import { loginAuthorizationUrl } from "@/lib/auth/google-oauth";
import { startFlow } from "@/lib/auth/flows";
import { enforceRateLimit } from "@/lib/ratelimit";
import { currentUser } from "@/lib/auth/require-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const LOGIN_LIMIT = 20;
const LOGIN_WINDOW_MS = 60_000;

function clientAddress(request: Request) {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) || "unknown";
}

export async function GET(request: Request) {
  try {
    googleClient();
    if (await currentUser(request)) return NextResponse.redirect(`${appUrl()}/`, 303);
    await enforceRateLimit(`login:${clientAddress(request)}`, LOGIN_LIMIT, LOGIN_WINDOW_MS);
    const flow = await startFlow("login");
    const response = NextResponse.redirect(loginAuthorizationUrl(flow, allowedDomain()), 303);
    response.headers.append("Set-Cookie", flow.setCookie);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) { return apiFailure(error); }
}
