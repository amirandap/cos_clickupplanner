import { appUrl, googleClient } from "@/lib/config/env";
import { ProviderPayloadError, record, requestJson } from "@/lib/providers/http";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export const loginRedirectUri = () => `${appUrl()}/api/auth/login/google/callback`;
export const calendarRedirectUri = () => `${appUrl()}/api/auth/google/callback`;

/** Step 1: identity only. No Calendar scope, no offline access. */
export function loginAuthorizationUrl(flow: { state: string; nonce: string | null; challenge: string }, hostedDomain: string | null) {
  const target = new URL(GOOGLE_AUTH_URL);
  target.searchParams.set("client_id", googleClient().clientId);
  target.searchParams.set("redirect_uri", loginRedirectUri());
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", "openid email profile");
  target.searchParams.set("state", flow.state);
  if (flow.nonce) target.searchParams.set("nonce", flow.nonce);
  target.searchParams.set("code_challenge", flow.challenge);
  target.searchParams.set("code_challenge_method", "S256");
  target.searchParams.set("prompt", "select_account");
  if (hostedDomain) target.searchParams.set("hd", hostedDomain);
  return target;
}

/** Step 2: a separate, explicit grant of Calendar access with a refresh token. */
export function calendarAuthorizationUrl(flow: { state: string; challenge: string }, loginHint: string | null) {
  const target = new URL(GOOGLE_AUTH_URL);
  target.searchParams.set("client_id", googleClient().clientId);
  target.searchParams.set("redirect_uri", calendarRedirectUri());
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", CALENDAR_SCOPE);
  target.searchParams.set("access_type", "offline");
  target.searchParams.set("prompt", "consent");
  target.searchParams.set("state", flow.state);
  target.searchParams.set("code_challenge", flow.challenge);
  target.searchParams.set("code_challenge_method", "S256");
  if (loginHint) target.searchParams.set("login_hint", loginHint);
  return target;
}

export async function exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<Record<string, unknown>> {
  const { clientId, clientSecret } = googleClient();
  const body = await requestJson("Google OAuth", GOOGLE_TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code", code_verifier: codeVerifier }),
  });
  if (!record(body)) throw new ProviderPayloadError("Google OAuth", "token");
  return body;
}

/** Best effort: the local credential is deleted regardless of the outcome. */
export async function revokeGoogleToken(token: string) {
  try {
    await requestJson("Google OAuth", GOOGLE_REVOKE_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }),
    }, { timeoutMs: 5000 });
  } catch { /* An already revoked token or an outage must not block disconnecting. */ }
}
