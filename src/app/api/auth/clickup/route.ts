import { NextResponse } from "next/server";
import { appUrl, beginOAuth } from "@/lib/sync/oauth";

export const runtime = "nodejs";
export function GET() {
  if (!process.env.CLICKUP_CLIENT_ID || !process.env.CLICKUP_CLIENT_SECRET) return NextResponse.json({ error: "Configura CLICKUP_CLIENT_ID y CLICKUP_CLIENT_SECRET" }, { status: 400 });
  const target = new URL("https://app.clickup.com/api");
  target.searchParams.set("client_id", process.env.CLICKUP_CLIENT_ID);
  target.searchParams.set("redirect_uri", `${appUrl()}/api/auth/clickup/callback`);
  return beginOAuth("clickup", target);
}
