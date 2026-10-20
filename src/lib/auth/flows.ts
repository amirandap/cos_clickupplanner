import { db } from "@/lib/db/client";
import { FLOW_COOKIE, FLOW_COOKIE_PATH, cookieAttributes, readCookie } from "@/lib/auth/cookies";
import { hashToken } from "@/lib/auth/session";
import { pkceChallenge, randomToken } from "@/lib/crypto/secrets";

const FLOW_TTL_MS = 10 * 60_000;
export type FlowKind = "login" | "calendar";

/** state, nonce and the PKCE verifier live server-side, keyed by a cookie only this browser holds. */
export async function startFlow(kind: FlowKind, binding?: { userId: string; sessionId: string | null }, now = new Date()) {
  const cookieToken = randomToken();
  const flow = {
    state: randomToken(), nonce: kind === "login" ? randomToken() : null, codeVerifier: randomToken(48),
  };
  await db.oAuthFlow.deleteMany({ where: { expiresAt: { lte: now } } });
  await db.oAuthFlow.create({ data: {
    id: hashToken(cookieToken), kind, ...flow, userId: binding?.userId ?? null, sessionId: binding?.sessionId ?? null,
    expiresAt: new Date(now.getTime() + FLOW_TTL_MS),
  } });
  return { ...flow, challenge: pkceChallenge(flow.codeVerifier), setCookie: flowSetCookie(cookieToken) };
}

/** Single use: the row is deleted whether or not validation succeeds afterwards. */
export async function consumeFlow(request: Request, kind: FlowKind, now = new Date()) {
  const token = readCookie(request.headers.get("cookie"), FLOW_COOKIE);
  if (!token) return null;
  const id = hashToken(token);
  const flow = await db.oAuthFlow.findUnique({ where: { id } });
  if (!flow) return null;
  const removed = await db.oAuthFlow.deleteMany({ where: { id } });
  if (removed.count !== 1 || flow.kind !== kind || flow.expiresAt <= now) return null;
  return flow;
}

export function flowSetCookie(token: string) {
  return `${FLOW_COOKIE}=${token}; ${cookieAttributes({ path: FLOW_COOKIE_PATH, maxAgeSeconds: FLOW_TTL_MS / 1000 })}`;
}

export function flowClearCookie() {
  return `${FLOW_COOKIE}=; ${cookieAttributes({ path: FLOW_COOKIE_PATH, maxAgeSeconds: 0 })}`;
}
