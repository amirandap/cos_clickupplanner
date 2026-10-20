import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, test, type TestContext } from "node:test";
import { configureTestEnvironment, createTestDatabase, createTestUser, loadModule, sessionCookieFor } from "./helpers";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const ORIGIN = "https://planner.test";
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

async function fixture() {
  configureTestEnvironment();
  const database = await createTestDatabase();
  await createTestUser(database.db, "user-a");
  await createTestUser(database.db, "user-b");
  const deps = { "@/lib/db/client": { db: database.db } };
  return {
    ...database,
    start: loadModule<typeof import("../src/app/api/auth/google/route")>("src/app/api/auth/google/route.ts", deps),
    callback: loadModule<typeof import("../src/app/api/auth/google/callback/route")>("src/app/api/auth/google/callback/route.ts", deps),
    calendar: loadModule<typeof import("../src/lib/google/calendar")>("src/lib/google/calendar.ts", deps),
    credentials: loadModule<typeof import("../src/lib/auth/credentials")>("src/lib/auth/credentials.ts", deps),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function begin(f: Fixture, userId: string) {
  const session = await sessionCookieFor(f.db, userId);
  const response = await f.start.GET(new Request(`${ORIGIN}/api/auth/google`, { headers: { cookie: session } }));
  assert.equal(response.status, 303);
  const flowCookie = response.headers.getSetCookie().find((value) => value.startsWith("planner_oauth_flow="))!.split(";")[0];
  return { params: new URL(response.headers.get("location")!).searchParams, session, flowCookie, response };
}

function callbackRequest(flow: Awaited<ReturnType<typeof begin>>, query: Record<string, string>, cookie = `${flow.session}; ${flow.flowCookie}`) {
  const url = new URL(`${ORIGIN}/api/auth/google/callback`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Request(url, { headers: { cookie } });
}

function fakeToken(t: TestContext, payload: Record<string, unknown> | Response) {
  const exchanges: URLSearchParams[] = [];
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    exchanges.push(new URLSearchParams(String(init?.body)));
    return payload instanceof Response ? payload : Response.json(payload);
  });
  return exchanges;
}

const result = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("google");

test("connecting Calendar is a separate step that needs a session and asks for calendar.events offline", async () => {
  const f = await fixture();
  try {
    const anonymous = await f.start.GET(new Request(`${ORIGIN}/api/auth/google`));
    assert.equal(anonymous.status, 401);
    const { params } = await begin(f, "user-a");
    assert.equal(params.get("scope"), CALENDAR_SCOPE);
    assert.equal(params.get("access_type"), "offline");
    assert.equal(params.get("prompt"), "consent");
    assert.equal(params.get("redirect_uri"), `${ORIGIN}/api/auth/google/callback`);
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.equal(params.get("nonce"), null);
    const flow = await f.db.oAuthFlow.findFirstOrThrow();
    assert.equal(flow.kind, "calendar");
    assert.equal(flow.userId, "user-a");
    assert.ok(flow.sessionId, "the flow is bound to the session");
  } finally { await f.cleanup(); }
});

test("the refresh token is stored encrypted for the user who connected it, and nobody else", async (t) => {
  const f = await fixture();
  try {
    const flow = await begin(f, "user-a");
    const exchanges = fakeToken(t, { access_token: "ya29.secret-access", refresh_token: "1//secret-refresh", expires_in: 3600, scope: CALENDAR_SCOPE });
    const response = await f.callback.GET(callbackRequest(flow, { state: flow.params.get("state")!, code: "code" }));
    assert.equal(result(response), "connected");
    assert.equal(createHash("sha256").update(exchanges[0].get("code_verifier")!).digest("base64url"), flow.params.get("code_challenge"));
    const rows = await f.db.userCredential.findMany();
    assert.deepEqual(rows.map((row) => [row.userId, row.provider]), [["user-a", "google_calendar"]]);
    assert.equal(JSON.stringify(rows).includes("secret"), false);
    assert.equal((await f.credentials.getCredential("user-a", "google_calendar"))?.refreshToken, "1//secret-refresh");
    assert.equal(await f.credentials.getCredential("user-b", "google_calendar"), null);
  } finally { await f.cleanup(); }
});

test("a callback cannot be completed from another user's session or without the flow cookie", async (t) => {
  const f = await fixture();
  try {
    const flow = await begin(f, "user-a");
    const exchanges = fakeToken(t, { access_token: "a", refresh_token: "r", expires_in: 3600, scope: CALENDAR_SCOPE });
    const state = flow.params.get("state")!;
    const bSession = await sessionCookieFor(f.db, "user-b");
    // User B is tricked into hitting A's callback URL with A's flow cookie.
    assert.equal(result(await f.callback.GET(callbackRequest(flow, { state, code: "c" }, `${bSession}; ${flow.flowCookie}`))), "invalid_state");
    // The flow was single use, so A's own browser fails afterwards too.
    assert.equal(result(await f.callback.GET(callbackRequest(flow, { state, code: "c" }))), "invalid_state");
    const second = await begin(f, "user-a");
    assert.equal(result(await f.callback.GET(callbackRequest(second, { state: second.params.get("state")!, code: "c" }, second.session))), "invalid_state");
    // Same user, a fresh login session: the flow is tied to the session that started it.
    const third = await begin(f, "user-a");
    const newSession = await sessionCookieFor(f.db, "user-a");
    assert.equal(result(await f.callback.GET(callbackRequest(third, { state: third.params.get("state")!, code: "c" }, `${newSession}; ${third.flowCookie}`))), "invalid_state");
    assert.equal(exchanges.length, 0);
    assert.equal(await f.db.userCredential.count(), 0);
  } finally { await f.cleanup(); }
});

test("an anonymous callback goes to /login and a wrong state is refused", async (t) => {
  const f = await fixture();
  try {
    const flow = await begin(f, "user-a");
    const exchanges = fakeToken(t, { access_token: "a", refresh_token: "r", expires_in: 3600, scope: CALENDAR_SCOPE });
    const anonymous = await f.callback.GET(callbackRequest(flow, { state: flow.params.get("state")!, code: "c" }, flow.flowCookie));
    assert.equal(new URL(anonymous.headers.get("location")!).pathname, "/login");
    const again = await begin(f, "user-a");
    assert.equal(result(await f.callback.GET(callbackRequest(again, { state: "forged", code: "c" }))), "invalid_state");
    assert.equal(exchanges.length, 0);
  } finally { await f.cleanup(); }
});

test("a grant without a refresh token or without the Calendar scope is refused", async (t) => {
  const f = await fixture();
  try {
    for (const [payload, expected] of [
      [{ access_token: "a", expires_in: 3600, scope: CALENDAR_SCOPE }, "no_refresh"],
      [{ access_token: "a", refresh_token: " ", expires_in: 3600, scope: CALENDAR_SCOPE }, "no_refresh"],
      [{ access_token: "a", refresh_token: "r", expires_in: 3600, scope: "openid email" }, "missing_scope"],
      [{ access_token: "a", refresh_token: "r", expires_in: 3600 }, "missing_scope"],
      [{ access_token: "", refresh_token: "r", expires_in: 3600, scope: CALENDAR_SCOPE }, "failed"],
      [{ access_token: "a", refresh_token: "r", expires_in: -1, scope: CALENDAR_SCOPE }, "failed"],
    ] as const) {
      const flow = await begin(f, "user-a");
      fakeToken(t, payload);
      assert.equal(result(await f.callback.GET(callbackRequest(flow, { state: flow.params.get("state")!, code: "c" }))), expected, JSON.stringify(payload));
      t.mock.restoreAll();
    }
    assert.equal(await f.db.userCredential.count(), 0);
  } finally { await f.cleanup(); }
});

test("a provider error body never leaks into the redirect", async (t) => {
  const f = await fixture();
  try {
    const flow = await begin(f, "user-a");
    fakeToken(t, new Response("provider-secret-that-must-not-appear", { status: 400 }));
    const response = await f.callback.GET(callbackRequest(flow, { state: flow.params.get("state")!, code: "c" }));
    assert.equal(result(response), "failed");
    assert.equal(response.headers.get("location")!.includes("secret"), false);
  } finally { await f.cleanup(); }
});

test("refreshing uses only that user's refresh token and stores the new access token encrypted", async (t) => {
  const f = await fixture();
  try {
    await f.credentials.saveCredential("user-a", "google_calendar", { accessToken: "old-a", refreshToken: "refresh-a", expiresAt: new Date(Date.now() - 1000) });
    await f.credentials.saveCredential("user-b", "google_calendar", { accessToken: "old-b", refreshToken: "refresh-b", expiresAt: new Date(Date.now() - 1000) });
    const seen: { refresh: string | null; bearer: string | null }[] = [];
    t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes("oauth2.googleapis.com")) {
        const refresh = new URLSearchParams(String(init?.body)).get("refresh_token");
        return Response.json({ access_token: `fresh-for-${refresh}`, expires_in: 3600 });
      }
      seen.push({ refresh: null, bearer: new Headers(init?.headers).get("Authorization") });
      return Response.json({ items: [], nextSyncToken: "t" });
    });
    const ctx = (userId: string) => ({ userId, calendarId: "primary", listIds: [], timezone: "UTC", clickupUserId: null, mock: false });
    await f.calendar.listRemoteEvents(ctx("user-a"));
    await f.calendar.listRemoteEvents(ctx("user-b"));
    assert.deepEqual(seen.map((item) => item.bearer), ["Bearer fresh-for-refresh-a", "Bearer fresh-for-refresh-b"]);
    assert.equal((await f.credentials.getCredential("user-a", "google_calendar"))?.refreshToken, "refresh-a");
    assert.equal(JSON.stringify(await f.db.userCredential.findMany()).includes("fresh-for"), false);
  } finally { await f.cleanup(); }
});

test("invalid_grant marks the credential revoked and asks the user to reconnect", async (t) => {
  const f = await fixture();
  try {
    await f.credentials.saveCredential("user-a", "google_calendar", { accessToken: "old", refreshToken: "dead", expiresAt: new Date(Date.now() - 1000) });
    await f.credentials.saveCredential("user-b", "google_calendar", { accessToken: "ok", refreshToken: "alive", expiresAt: new Date(Date.now() + 3600_000) });
    let tokenCalls = 0;
    t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
      if (String(input).includes("oauth2.googleapis.com")) { tokenCalls++; return Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 }); }
      return Response.json({ items: [], nextSyncToken: "t" });
    });
    const ctx = (userId: string) => ({ userId, calendarId: "primary", listIds: [], timezone: "UTC", clickupUserId: null, mock: false });
    await assert.rejects(f.calendar.listRemoteEvents(ctx("user-a")), (error: unknown) => (error as { code?: string; status?: number }).code === "reconnect_required" && (error as { status?: number }).status === 409);
    const row = await f.db.userCredential.findUniqueOrThrow({ where: { userId_provider: { userId: "user-a", provider: "google_calendar" } } });
    assert.ok(row.revokedAt);
    assert.equal(row.refreshTokenEnc, null);
    assert.deepEqual(await f.credentials.connectionStates("user-a"), { googleCalendar: "revoked", clickup: "none" });
    // No more calls with the dead token, and user B is unaffected.
    await assert.rejects(f.calendar.listRemoteEvents(ctx("user-a")), /Ajustes/);
    assert.equal(tokenCalls, 1);
    assert.equal((await f.calendar.listRemoteEvents(ctx("user-b"))).nextSyncToken, "t");
    assert.equal((await f.credentials.connectionStates("user-b")).googleCalendar, "connected");
    // Reconnecting through the callback clears the revoked flag.
    await f.credentials.saveCredential("user-a", "google_calendar", { accessToken: "new", refreshToken: "new-refresh" });
    assert.equal((await f.credentials.connectionStates("user-a")).googleCalendar, "connected");
  } finally { await f.cleanup(); }
});
