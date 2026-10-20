import { NextResponse } from "next/server";
import { appUrl } from "@/lib/config/env";
import { consumeFlow, flowClearCookie } from "@/lib/auth/flows";
import { sameSecret } from "@/lib/crypto/secrets";
import { CALENDAR_SCOPE, calendarRedirectUri, exchangeCode } from "@/lib/auth/google-oauth";
import { validateGoogleToken } from "@/lib/sync/credentials";
import { saveCredential } from "@/lib/auth/credentials";
import { currentUser } from "@/lib/auth/require-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function finish(error?: string) {
  const target = new URL(`${appUrl()}/settings`);
  target.searchParams.set("google", error ?? "connected");
  const response = NextResponse.redirect(target, 303);
  response.headers.append("Set-Cookie", flowClearCookie());
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const user = await currentUser(request);
    if (!user) return NextResponse.redirect(`${appUrl()}/login`, 303);
    const params = new URL(request.url).searchParams;
    const flow = await consumeFlow(request, "calendar");
    const state = params.get("state");
    // The flow must belong to this very session and user: a callback cannot be replayed from another login.
    if (!flow || flow.userId !== user.id || flow.sessionId !== user.sessionId || !state || !sameSecret(state, flow.state)) return finish("invalid_state");
    if (params.get("error")) return finish("denied");
    const code = params.get("code");
    if (!code || code.length > 2048) return finish("invalid_state");

    const token = validateGoogleToken(await exchangeCode(code, calendarRedirectUri(), flow.codeVerifier));
    // Never keep an older refresh token for a new grant, and require the Calendar scope.
    if (!token.refreshToken?.trim()) return finish("no_refresh");
    if (!token.scope?.split(" ").includes(CALENDAR_SCOPE)) return finish("missing_scope");
    await saveCredential(user.id, "google_calendar", {
      accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt: token.expiresAt, scopes: token.scope,
    });
    return finish();
  } catch { return finish("failed"); }
}
