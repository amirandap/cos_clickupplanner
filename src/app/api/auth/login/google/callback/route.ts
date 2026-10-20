import { NextResponse } from "next/server";
import { appUrl, googleClient } from "@/lib/config/env";
import { consumeFlow, flowClearCookie } from "@/lib/auth/flows";
import { sameSecret } from "@/lib/crypto/secrets";
import { exchangeCode, loginRedirectUri } from "@/lib/auth/google-oauth";
import { verifyGoogleIdToken, IdTokenError } from "@/lib/auth/id-token";
import { DomainNotAllowedError, assertDomainAllowed, userForIdentity } from "@/lib/auth/login";
import { createSession, destroySession, sessionSetCookie } from "@/lib/auth/session";
import { sessionTokenFromRequest } from "@/lib/auth/require-user";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type LoginError = "invalid_state" | "denied" | "unverified" | "domain" | "failed";

function failure(code: LoginError) {
  const response = NextResponse.redirect(`${appUrl()}/login?error=${code}`, 303);
  response.headers.append("Set-Cookie", flowClearCookie());
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const flow = await consumeFlow(request, "login");
    const state = params.get("state");
    if (!flow || !flow.nonce || !state || !sameSecret(state, flow.state)) return failure("invalid_state");
    if (params.get("error")) return failure("denied");
    const code = params.get("code");
    if (!code || code.length > 2048) return failure("invalid_state");

    const tokens = await exchangeCode(code, loginRedirectUri(), flow.codeVerifier);
    if (typeof tokens.id_token !== "string") return failure("failed");
    const identity = await verifyGoogleIdToken(tokens.id_token, { clientId: googleClient().clientId, nonce: flow.nonce });
    assertDomainAllowed(identity.email);

    const user = await userForIdentity(identity);
    // A fresh session id on every login (no fixation). Any previous one is dropped.
    await destroySession(await sessionTokenFromRequest(request));
    const session = await createSession(user.id);
    const response = NextResponse.redirect(`${appUrl()}/`, 303);
    response.headers.append("Set-Cookie", sessionSetCookie(session.token, session.expiresAt));
    response.headers.append("Set-Cookie", flowClearCookie());
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    if (error instanceof DomainNotAllowedError) return failure("domain");
    if (error instanceof IdTokenError) return failure(error.reason === "email_verified" ? "unverified" : "failed");
    return failure("failed");
  }
}
