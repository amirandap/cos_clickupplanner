import { NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { appUrl, finishOAuth, validateOAuth } from "@/lib/sync/oauth";
import { oauthClient, validateGoogleToken } from "@/lib/sync/credentials";
import { requestJson } from "@/lib/providers/http";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const code = validateOAuth(request, "google");
    const { clientId, clientSecret } = oauthClient("google");
    const token = validateGoogleToken(await requestJson("Google OAuth", "https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: `${appUrl()}/api/auth/google/callback`, grant_type: "authorization_code" }),
    }));
    // A callback may belong to a different account; never reuse an older refresh token.
    if (!token.refreshToken?.trim()) throw new Error("Google no devolvió acceso renovable");
    await db.oAuthCredential.upsert({
      where: { provider: "google" },
      create: { provider: "google", ...token },
      update: token,
    });
    return finishOAuth("google");
  } catch { return finishOAuth("google", "No se pudo conectar con Google. Intenta de nuevo."); }
}
