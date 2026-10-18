import { NextRequest } from "next/server";
import { db } from "@/lib/db/client";
import { finishOAuth, validateOAuth } from "@/lib/sync/oauth";
import { oauthClient, validateClickUpToken } from "@/lib/sync/credentials";
import { requestJson } from "@/lib/providers/http";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  try {
    const code = validateOAuth(request, "clickup");
    const { clientId, clientSecret } = oauthClient("clickup");
    const token = validateClickUpToken(await requestJson("ClickUp OAuth", "https://api.clickup.com/api/v2/oauth/token", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
    }));
    await db.oAuthCredential.upsert({
      where: { provider: "clickup" },
      create: { provider: "clickup", accessToken: token.accessToken },
      update: { accessToken: token.accessToken },
    });
    return finishOAuth("clickup");
  } catch { return finishOAuth("clickup", "No se pudo conectar con ClickUp. Intenta de nuevo."); }
}
