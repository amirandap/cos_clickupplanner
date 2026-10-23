import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db/client";
import { cookieAttributes, sessionCookieName } from "@/lib/auth/cookies";

// Rolling idle expiry, capped by an absolute lifetime.
export const SESSION_IDLE_MS = 7 * 24 * 3600_000;
export const SESSION_MAX_MS = 30 * 24 * 3600_000;
const TOUCH_INTERVAL_MS = 5 * 60_000;

export type SessionUser = { id: string; email: string; name: string | null; sessionId: string | null };

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession(userId: string, now = new Date()) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_IDLE_MS);
  await db.session.create({ data: {
    id: hashToken(token), userId, createdAt: now, lastSeenAt: now, expiresAt,
    maxExpiresAt: new Date(now.getTime() + SESSION_MAX_MS),
  } });
  // Opportunistic cleanup keeps the table small without a scheduler.
  await db.session.deleteMany({ where: { expiresAt: { lte: now } } });
  return { token, expiresAt };
}

export async function resolveSession(token: string | undefined, now = new Date()): Promise<SessionUser | null> {
  if (!token || token.length > 256) return null;
  const id = hashToken(token);
  const session = await db.session.findUnique({ where: { id }, include: { user: true } });
  if (!session) return null;
  if (session.expiresAt <= now || session.maxExpiresAt <= now) {
    await db.session.deleteMany({ where: { id } });
    return null;
  }
  if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    const expiresAt = new Date(Math.min(now.getTime() + SESSION_IDLE_MS, session.maxExpiresAt.getTime()));
    await db.session.update({ where: { id }, data: { lastSeenAt: now, expiresAt } });
  }
  return { id: session.user.id, email: session.user.email, name: session.user.name, sessionId: id };
}

export async function destroySession(token: string | undefined) {
  if (token) await db.session.deleteMany({ where: { id: hashToken(token) } });
}

export function sessionSetCookie(token: string, expiresAt: Date, now = new Date()) {
  const maxAgeSeconds = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  return `${sessionCookieName()}=${token}; ${cookieAttributes({ path: "/", maxAgeSeconds })}`;
}

export function sessionClearCookie() {
  return `${sessionCookieName()}=; ${cookieAttributes({ path: "/", maxAgeSeconds: 0 })}`;
}
