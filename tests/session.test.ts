import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NextRequest } from "next/server";
import { configureTestEnvironment, createTestDatabase, createTestUser, loadModule } from "./helpers";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

async function fixture() {
  configureTestEnvironment();
  const database = await createTestDatabase();
  await createTestUser(database.db, "user-a");
  const deps = { "@/lib/db/client": { db: database.db } };
  const session = loadModule<typeof import("../src/lib/auth/session")>("src/lib/auth/session.ts", deps);
  const requireUser = loadModule<typeof import("../src/lib/auth/require-user")>("src/lib/auth/require-user.ts", deps);
  const cookies = loadModule<typeof import("../src/lib/auth/cookies")>("src/lib/auth/cookies.ts");
  const proxy = loadModule<typeof import("../src/proxy")>("src/proxy.ts");
  return { ...database, session, requireUser, cookies, proxy };
}

test("only the hash of the session token is stored", async () => {
  const f = await fixture();
  try {
    const { token } = await f.session.createSession("user-a");
    const rows = await f.db.session.findMany();
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].id, token);
    assert.equal(rows[0].id, f.session.hashToken(token));
    assert.equal(JSON.stringify(rows).includes(token), false);
    assert.ok(token.length >= 43, "at least 256 bits of entropy");
  } finally { await f.cleanup(); }
});

test("a session resolves to its user, and unknown or empty tokens do not", async () => {
  const f = await fixture();
  try {
    const { token } = await f.session.createSession("user-a");
    assert.equal((await f.session.resolveSession(token))?.id, "user-a");
    assert.equal(await f.session.resolveSession("not-a-real-token"), null);
    assert.equal(await f.session.resolveSession(undefined), null);
    assert.equal(await f.session.resolveSession("x".repeat(5000)), null);
  } finally { await f.cleanup(); }
});

test("idle expiry rolls forward on use but never past the absolute cap", async () => {
  const f = await fixture();
  try {
    const start = new Date("2026-10-01T00:00:00Z");
    const { token } = await f.session.createSession("user-a", start);
    const hour = 3600_000;
    // Used every few days: the idle window keeps sliding.
    for (let day = 3; day <= 27; day += 3) {
      assert.ok(await f.session.resolveSession(token, new Date(start.getTime() + day * 24 * hour)), `day ${day}`);
    }
    const row = await f.db.session.findFirstOrThrow();
    assert.ok(row.expiresAt.getTime() <= row.maxExpiresAt.getTime());
    // The 30 day cap wins over activity.
    assert.equal(await f.session.resolveSession(token, new Date(start.getTime() + 31 * 24 * hour)), null);
    assert.equal(await f.db.session.count(), 0, "an expired session is deleted");
  } finally { await f.cleanup(); }
});

test("an unused session expires after the idle window", async () => {
  const f = await fixture();
  try {
    const start = new Date("2026-10-01T00:00:00Z");
    const { token } = await f.session.createSession("user-a", start);
    assert.equal(await f.session.resolveSession(token, new Date(start.getTime() + 8 * 24 * 3600_000)), null);
  } finally { await f.cleanup(); }
});

test("logout destroys the session server-side", async () => {
  const f = await fixture();
  try {
    const { token } = await f.session.createSession("user-a");
    await f.session.destroySession(token);
    assert.equal(await f.session.resolveSession(token), null);
  } finally { await f.cleanup(); }
});

test("session cookie is HttpOnly, SameSite=Lax, Secure and __Host- prefixed over https", async () => {
  const f = await fixture();
  try {
    const header = f.session.sessionSetCookie("tok", new Date(Date.now() + 60_000));
    assert.match(header, /^__Host-planner_session=tok; /);
    for (const attribute of ["HttpOnly", "SameSite=Lax", "Secure", "Path=/"]) assert.ok(header.includes(attribute), attribute);
    assert.equal(header.includes("Domain="), false);
    process.env.APP_URL = "http://127.0.0.1:3000";
    const dev = f.session.sessionSetCookie("tok", new Date(Date.now() + 60_000));
    assert.match(dev, /^planner_session=tok; /);
    assert.equal(dev.includes("Secure"), false);
    assert.match(f.session.sessionClearCookie(), /Max-Age=0/);
  } finally { await f.cleanup(); }
});

test("requireUser accepts a valid cookie and rejects anything else with 401", async () => {
  const f = await fixture();
  try {
    const { token } = await f.session.createSession("user-a");
    const name = f.cookies.sessionCookieName();
    const ok = await f.requireUser.requireUser(new Request("https://planner.test/api/planner", { headers: { cookie: `a=b; ${name}=${token}` } }));
    assert.equal(ok.id, "user-a");
    for (const cookie of [undefined, `${name}=forged`, "planner_session=" + token, `${name}=`]) {
      await assert.rejects(f.requireUser.requireUser(new Request("https://planner.test/api/planner", { headers: cookie ? { cookie } : {} })), (error: unknown) => (error as { status?: number }).status === 401);
    }
  } finally { await f.cleanup(); }
});

test("the proxy sends anonymous browsers to /login and anonymous API calls get 401", async () => {
  const f = await fixture();
  try {
    const page = f.proxy.proxy(new NextRequest("https://planner.test/"));
    assert.equal(page.status, 307);
    assert.equal(new URL(page.headers.get("location")!).pathname, "/login");
    assert.equal(f.proxy.proxy(new NextRequest("https://planner.test/settings")).status, 307);
    for (const path of ["/api/planner", "/api/planner/events", "/api/sync", "/api/settings", "/api/auth/google", "/api/auth/google/callback", "/api/auth/logout"]) {
      const response = f.proxy.proxy(new NextRequest(`https://planner.test${path}`));
      assert.equal(response.status, 401, path);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  } finally { await f.cleanup(); }
});

test("the proxy lets public paths and requests carrying a session cookie through", async () => {
  const f = await fixture();
  try {
    for (const path of ["/login", "/api/auth/login/google", "/api/auth/login/google/callback"]) {
      assert.equal(f.proxy.proxy(new NextRequest(`https://planner.test${path}`)).headers.get("x-middleware-next"), "1", path);
    }
    for (const path of ["/api/auth/loginx", "/login-evil", "/api/auth/login-evil"]) {
      assert.notEqual(f.proxy.proxy(new NextRequest(`https://planner.test${path}`)).headers.get("x-middleware-next"), "1", path);
    }
    const withCookie = f.proxy.proxy(new NextRequest("https://planner.test/api/planner", { headers: { cookie: `${f.cookies.sessionCookieName()}=abc` } }));
    assert.equal(withCookie.headers.get("x-middleware-next"), "1");
  } finally { await f.cleanup(); }
});

test("Basic Auth is gone: credentials in an Authorization header grant nothing", async () => {
  const f = await fixture();
  try {
    process.env.PLANNER_AUTH_USERNAME = "planner";
    process.env.PLANNER_AUTH_PASSWORD = "secret-for-tests";
    const response = f.proxy.proxy(new NextRequest("https://planner.test/api/planner", { headers: { authorization: `Basic ${Buffer.from("planner:secret-for-tests").toString("base64")}` } }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), null);
  } finally { await f.cleanup(); }
});

test("USE_MOCK_DATA bypass works in development and never in production", async () => {
  const f = await fixture();
  try {
    process.env.USE_MOCK_DATA = "true";
    const env = process.env as Record<string, string | undefined>;
    env.NODE_ENV = "development";
    assert.equal(f.proxy.proxy(new NextRequest("https://planner.test/api/planner")).headers.get("x-middleware-next"), "1");
    const mock = await f.requireUser.requireUser(new Request("https://planner.test/api/planner"));
    assert.equal(mock.id, "mock-user");
    env.NODE_ENV = "production";
    assert.equal(f.proxy.proxy(new NextRequest("https://planner.test/api/planner")).status, 401);
    assert.equal(f.proxy.proxy(new NextRequest("https://planner.test/")).status, 307);
    await assert.rejects(f.requireUser.requireUser(new Request("https://planner.test/api/planner")), (error: unknown) => (error as { status?: number }).status === 401);
    assert.equal(await f.requireUser.userFromCookieStore({ get: () => undefined }), null);
  } finally { await f.cleanup(); }
});
