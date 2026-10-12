import { NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { appUrl, finishOAuth, validateOAuth } from "@/lib/sync/oauth";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const code = validateOAuth(request, "google");
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ code, client_id: process.env.GOOGLE_CLIENT_ID || "", client_secret: process.env.GOOGLE_CLIENT_SECRET || "", redirect_uri: `${appUrl()}/api/auth/google/callback`, grant_type: "authorization_code" }),
    });
    if (!response.ok) throw new Error(`Google rechazó OAuth (${response.status})`);
    const token = await response.json() as { access_token: string; refresh_token?: string; expires_in: number };
    const existing = await db.oAuthCredential.findUnique({ where: { provider: "google" } });
    await db.oAuthCredential.upsert({ where: { provider: "google" }, create: { provider: "google", accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: new Date(Date.now() + token.expires_in * 1000) }, update: { accessToken: token.access_token, refreshToken: token.refresh_token || existing?.refreshToken, expiresAt: new Date(Date.now() + token.expires_in * 1000) } });
    return finishOAuth("google");
  } catch (error) { return finishOAuth("google", error instanceof Error ? error.message : "OAuth falló"); }
}
