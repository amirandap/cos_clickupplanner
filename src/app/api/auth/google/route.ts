import { NextResponse } from "next/server";
import { apiFailure } from "@/lib/planner/http";
import { googleClient } from "@/lib/config/env";
import { calendarAuthorizationUrl } from "@/lib/auth/google-oauth";
import { startFlow } from "@/lib/auth/flows";
import { requireUser } from "@/lib/auth/require-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Step 2 of the Google connection: explicit Calendar consent, bound to the signed-in session. */
export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    googleClient();
    const flow = await startFlow("calendar", { userId: user.id, sessionId: user.sessionId });
    const response = NextResponse.redirect(calendarAuthorizationUrl(flow, user.email), 303);
    response.headers.append("Set-Cookie", flow.setCookie);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) { return apiFailure(error); }
}
