import { NextResponse } from "next/server";
import { appUrl, beginOAuth } from "@/lib/sync/oauth";

export const runtime = "nodejs";
export function GET() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return NextResponse.json({ error: "Configura GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET" }, { status: 400 });
  const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  target.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  target.searchParams.set("redirect_uri", `${appUrl()}/api/auth/google/callback`);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("scope", "https://www.googleapis.com/auth/calendar.events");
  target.searchParams.set("access_type", "offline");
  target.searchParams.set("prompt", "consent");
  return beginOAuth("google", target);
}
