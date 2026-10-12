import { NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { finishOAuth, validateOAuth } from "@/lib/sync/oauth";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const code = validateOAuth(request, "clickup");
    const response = await fetch("https://api.clickup.com/api/v2/oauth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: process.env.CLICKUP_CLIENT_ID, client_secret: process.env.CLICKUP_CLIENT_SECRET, code }) });
    if (!response.ok) throw new Error(`ClickUp rechazó OAuth (${response.status})`);
    const token = await response.json() as { access_token: string };
    await db.oAuthCredential.upsert({ where: { provider: "clickup" }, create: { provider: "clickup", accessToken: token.access_token }, update: { accessToken: token.access_token } });
    return finishOAuth("clickup");
  } catch (error) { return finishOAuth("clickup", error instanceof Error ? error.message : "OAuth falló"); }
}
