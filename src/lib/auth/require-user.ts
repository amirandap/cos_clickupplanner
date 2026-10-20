import { db } from "@/lib/db/client";
import { mockBypassEnabled } from "@/lib/config/env";
import { readCookie, sessionCookieName } from "@/lib/auth/cookies";
import { resolveSession, type SessionUser } from "@/lib/auth/session";
import { UnauthorizedError } from "@/lib/planner/http";

export const MOCK_USER_ID = "mock-user";

/** Dev-only identity for USE_MOCK_DATA. mockBypassEnabled() is false when NODE_ENV=production. */
async function mockUser(): Promise<SessionUser> {
  const user = await db.user.upsert({
    where: { id: MOCK_USER_ID }, update: {},
    create: { id: MOCK_USER_ID, googleSub: "mock:mock-user", email: "mock@planner.invalid", name: "Usuario de demostración" },
  });
  return { id: user.id, email: user.email, name: user.name, sessionId: null };
}

export async function sessionTokenFromRequest(request: Request) {
  return readCookie(request.headers.get("cookie"), sessionCookieName());
}

export async function currentUser(request: Request): Promise<SessionUser | null> {
  if (mockBypassEnabled()) return mockUser();
  return resolveSession(await sessionTokenFromRequest(request));
}

export async function requireUser(request: Request): Promise<SessionUser> {
  const user = await currentUser(request);
  if (!user) throw new UnauthorizedError();
  return user;
}

/** For server components, where the Cookie header comes from next/headers. */
export async function userFromCookieStore(store: { get(name: string): { value: string } | undefined }) {
  if (mockBypassEnabled()) return mockUser();
  return resolveSession(store.get(sessionCookieName())?.value);
}
