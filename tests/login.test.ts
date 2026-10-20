import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, type JsonWebKey } from "node:crypto";
import { afterEach, test, type TestContext } from "node:test";
import { configureTestEnvironment, createTestDatabase, loadModule } from "./helpers";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

const ORIGIN = "https://planner.test";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "kid-1", alg: "RS256", use: "sig" };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function signToken(claims: Record<string, unknown>, options: { key?: typeof privateKey; header?: Record<string, unknown> } = {}) {
  const header = b64({ alg: "RS256", kid: "kid-1", typ: "JWT", ...options.header });
  const body = b64(claims);
  const signature = createSign("RSA-SHA256").update(`${header}.${body}`).sign(options.key ?? privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

function goodClaims(nonce: string, overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: "https://accounts.google.com", aud: "google-test-client", sub: "google-sub-1", email: "ana@example.test", email_verified: true,
    name: "Ana", nonce, iat: now, exp: now + 3600, ...overrides };
}

async function fixture() {
  configureTestEnvironment();
  const database = await createTestDatabase();
  const deps = { "@/lib/db/client": { db: database.db } };
  const start = loadModule<typeof import("../src/app/api/auth/login/google/route")>("src/app/api/auth/login/google/route.ts", deps);
  const callback = loadModule<typeof import("../src/app/api/auth/login/google/callback/route")>("src/app/api/auth/login/google/callback/route.ts", deps);
  const idToken = loadModule<typeof import("../src/lib/auth/id-token")>("src/lib/auth/id-token.ts");
  return { ...database, start, callback, idToken };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Fake Google: serves the JWKS and the token endpoint, recording what the app posts. */
function fakeGoogle(t: TestContext, respond: (form: URLSearchParams) => Record<string, unknown> | Response, keys: object[] = [jwk]) {
  const exchanges: URLSearchParams[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys });
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init?.body));
      exchanges.push(form);
      const result = respond(form);
      return result instanceof Response ? result : Response.json(result);
    }
    throw new Error(`unexpected request ${url}`);
  });
  return exchanges;
}

async function begin(f: Fixture) {
  const response = await f.start.GET(new Request(`${ORIGIN}/api/auth/login/google`));
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get("location")!);
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("planner_oauth_flow="))!.split(";")[0];
  return { target, cookie, params: target.searchParams };
}

async function finish(f: Fixture, flow: Awaited<ReturnType<typeof begin>>, query: Record<string, string>, cookie = flow.cookie) {
  const url = new URL(`${ORIGIN}/api/auth/login/google/callback`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return f.callback.GET(new Request(url, { headers: { cookie } }));
}

const failureCode = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("error");

test("login asks only for openid email profile, with state, nonce and PKCE S256, and no Calendar scope", async () => {
  const f = await fixture();
  try {
    const { target, params, cookie } = await begin(f);
    assert.equal(target.origin + target.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(params.get("scope"), "openid email profile");
    assert.equal(params.get("redirect_uri"), `${ORIGIN}/api/auth/login/google/callback`);
    assert.equal(params.get("code_challenge_method"), "S256");
    assert.ok(params.get("state") && params.get("nonce") && params.get("code_challenge"));
    assert.equal(params.get("access_type"), null);
    assert.equal(params.get("scope")!.includes("calendar"), false);
    assert.equal(params.get("hd"), null);
    // The secrets are not in the cookie: it is only an opaque handle for the server-side flow.
    assert.equal(cookie.includes(params.get("state")!) || cookie.includes(params.get("nonce")!), false);
    const flow = await f.db.oAuthFlow.findFirstOrThrow();
    assert.equal(flow.kind, "login");
    assert.equal(flow.state, params.get("state"));
  } finally { await f.cleanup(); }
});

test("a valid login creates the user by Google sub and an opaque session cookie", async (t) => {
  const f = await fixture();
  try {
    const flow = await begin(f);
    const exchanges = fakeGoogle(t, () => ({ access_token: "a", id_token: signToken(goodClaims(flow.params.get("nonce")!)) }));
    const response = await finish(f, flow, { state: flow.params.get("state")!, code: "auth-code" });
    assert.equal(response.status, 303);
    assert.equal(new URL(response.headers.get("location")!).pathname, "/");
    const session = response.headers.getSetCookie().find((value) => value.startsWith("__Host-planner_session="))!;
    assert.ok(session.includes("HttpOnly") && session.includes("SameSite=Lax") && session.includes("Secure"));
    const user = await f.db.user.findFirstOrThrow();
    assert.deepEqual([user.googleSub, user.email, user.name], ["google-sub-1", "ana@example.test", "Ana"]);
    assert.equal(await f.db.session.count({ where: { userId: user.id } }), 1);
    // The code is exchanged with the PKCE verifier whose hash was sent as the challenge.
    const verifier = exchanges[0].get("code_verifier")!;
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), flow.params.get("code_challenge"));
    assert.equal(exchanges[0].get("redirect_uri"), `${ORIGIN}/api/auth/login/google/callback`);
    assert.equal(await f.db.oAuthFlow.count(), 0, "the flow is single use");
  } finally { await f.cleanup(); }
});

test("identity is the sub: a changed email updates the same user, a reused email with another sub is a new user", async (t) => {
  const f = await fixture();
  try {
    for (const [sub, email] of [["google-sub-1", "ana@example.test"], ["google-sub-1", "ana.new@example.test"], ["google-sub-2", "ana@example.test"]]) {
      const flow = await begin(f);
      fakeGoogle(t, () => ({ id_token: signToken(goodClaims(flow.params.get("nonce")!, { sub, email })) }));
      assert.equal((await finish(f, flow, { state: flow.params.get("state")!, code: "c" })).status, 303);
      t.mock.restoreAll();
    }
    const users = await f.db.user.findMany({ orderBy: { createdAt: "asc" } });
    assert.deepEqual(users.map((user) => [user.googleSub, user.email]).sort(), [["google-sub-1", "ana.new@example.test"], ["google-sub-2", "ana@example.test"]]);
  } finally { await f.cleanup(); }
});

test("id_token with a wrong aud, iss, nonce, expiry, signature, algorithm or key is refused and creates nothing", async (t) => {
  const f = await fixture();
  try {
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, (nonce: string) => string][] = [
      ["aud", (nonce) => signToken(goodClaims(nonce, { aud: "another-client" }))],
      ["aud array without our client", (nonce) => signToken(goodClaims(nonce, { aud: ["x", "y"] }))],
      ["iss", (nonce) => signToken(goodClaims(nonce, { iss: "https://evil.example" }))],
      ["nonce", () => signToken(goodClaims("a-different-nonce"))],
      ["missing nonce", (nonce) => signToken({ ...goodClaims(nonce), nonce: undefined })],
      ["expired", (nonce) => signToken(goodClaims(nonce, { iat: now - 7200, exp: now - 3600 }))],
      ["issued in the future", (nonce) => signToken(goodClaims(nonce, { iat: now + 3600, exp: now + 7200 }))],
      ["signed by another key", (nonce) => signToken(goodClaims(nonce), { key: other.privateKey })],
      ["alg none", (nonce) => `${b64({ alg: "none", kid: "kid-1" })}.${b64(goodClaims(nonce))}.`],
      ["alg HS256", (nonce) => signToken(goodClaims(nonce), { header: { alg: "HS256" } })],
      ["unknown kid", (nonce) => signToken(goodClaims(nonce), { header: { kid: "kid-unknown" } })],
      ["tampered payload", (nonce) => { const [h, , s] = signToken(goodClaims(nonce)).split("."); return `${h}.${b64(goodClaims(nonce, { sub: "admin" }))}.${s}`; }],
      ["email_verified false", (nonce) => signToken(goodClaims(nonce, { email_verified: false }))],
      ["email_verified missing", (nonce) => signToken({ ...goodClaims(nonce), email_verified: undefined })],
      ["no sub", (nonce) => signToken({ ...goodClaims(nonce), sub: undefined })],
      ["garbage", () => "not.a.jwt"],
    ];
    for (const [name, build] of cases) {
      const flow = await begin(f);
      fakeGoogle(t, () => ({ id_token: build(flow.params.get("nonce")!) }));
      const response = await finish(f, flow, { state: flow.params.get("state")!, code: "c" });
      assert.equal(response.status, 303, name);
      assert.match(failureCode(response) ?? "", /^(failed|unverified)$/, name);
      assert.equal(response.headers.getSetCookie().some((value) => value.startsWith("__Host-planner_session=") && !value.includes("Max-Age=0")), false, `${name}: no session issued`);
      t.mock.restoreAll();
    }
    assert.equal(await f.db.user.count(), 0);
    assert.equal(await f.db.session.count(), 0);
  } finally { await f.cleanup(); }
});

test("email_verified=false is reported as an unverified account", async (t) => {
  const f = await fixture();
  try {
    const flow = await begin(f);
    fakeGoogle(t, () => ({ id_token: signToken(goodClaims(flow.params.get("nonce")!, { email_verified: false })) }));
    assert.equal(failureCode(await finish(f, flow, { state: flow.params.get("state")!, code: "c" })), "unverified");
  } finally { await f.cleanup(); }
});

test("a wrong, missing or replayed state never reaches the token endpoint", async (t) => {
  const f = await fixture();
  try {
    let exchanges = 0;
    const flow = await begin(f);
    fakeGoogle(t, () => { exchanges++; return { id_token: signToken(goodClaims(flow.params.get("nonce")!)) }; });
    assert.equal(failureCode(await finish(f, flow, { state: "forged", code: "c" })), "invalid_state");
    // The failed attempt consumed the flow, so even the right state is now useless.
    assert.equal(failureCode(await finish(f, flow, { state: flow.params.get("state")!, code: "c" })), "invalid_state");
    const second = await begin(f);
    assert.equal(failureCode(await finish(f, second, { code: "c" })), "invalid_state");
    const third = await begin(f);
    assert.equal(failureCode(await finish(f, third, { state: third.params.get("state")!, code: "c" }, "planner_oauth_flow=not-the-cookie")), "invalid_state");
    const fourth = await begin(f);
    assert.equal(failureCode(await finish(f, fourth, { state: fourth.params.get("state")! , code: "c" }, "")), "invalid_state");
    assert.equal(exchanges, 0);
    assert.equal(await f.db.user.count(), 0);
  } finally { await f.cleanup(); }
});

test("a state from another browser's flow cannot be completed with this browser's cookie", async (t) => {
  const f = await fixture();
  try {
    const victim = await begin(f);
    const attacker = await begin(f);
    fakeGoogle(t, () => ({ id_token: signToken(goodClaims(victim.params.get("nonce")!)) }));
    assert.equal(failureCode(await finish(f, victim, { state: victim.params.get("state")!, code: "c" }, attacker.cookie)), "invalid_state");
  } finally { await f.cleanup(); }
});

test("an expired flow is refused", async (t) => {
  const f = await fixture();
  try {
    const flow = await begin(f);
    await f.db.oAuthFlow.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    fakeGoogle(t, () => ({ id_token: signToken(goodClaims(flow.params.get("nonce")!)) }));
    assert.equal(failureCode(await finish(f, flow, { state: flow.params.get("state")!, code: "c" })), "invalid_state");
  } finally { await f.cleanup(); }
});

test("the user denying consent returns to /login with a fixed error code", async () => {
  const f = await fixture();
  try {
    const flow = await begin(f);
    assert.equal(failureCode(await finish(f, flow, { state: flow.params.get("state")!, error: "access_denied" })), "denied");
  } finally { await f.cleanup(); }
});

test("an upstream failure reveals nothing and issues no session", async (t) => {
  const f = await fixture();
  try {
    const flow = await begin(f);
    fakeGoogle(t, () => new Response("provider-secret-that-must-not-appear", { status: 400 }));
    const response = await finish(f, flow, { state: flow.params.get("state")!, code: "c" });
    assert.equal(failureCode(response), "failed");
    assert.equal(response.headers.get("location")!.includes("secret"), false);
  } finally { await f.cleanup(); }
});

test("without AUTH_ALLOWED_DOMAIN any verified account may sign in", async (t) => {
  const f = await fixture();
  try {
    const flow = await begin(f);
    assert.equal(flow.params.get("hd"), null);
    fakeGoogle(t, () => ({ id_token: signToken(goodClaims(flow.params.get("nonce")!, { email: "someone@gmail.test", sub: "gm-1" })) }));
    assert.equal(new URL((await finish(f, flow, { state: flow.params.get("state")!, code: "c" })).headers.get("location")!).pathname, "/");
  } finally { await f.cleanup(); }
});

test("with AUTH_ALLOWED_DOMAIN set, other domains are rejected and the hint is sent to Google", async (t) => {
  const f = await fixture();
  try {
    process.env.AUTH_ALLOWED_DOMAIN = "@Example.Test";
    for (const [email, allowed] of [["ana@example.test", true], ["eve@evil.test", false], ["eve@sub.example.test", false], ["eve@example.test.evil.test", false]] as const) {
      const flow = await begin(f);
      assert.equal(flow.params.get("hd"), "example.test");
      fakeGoogle(t, () => ({ id_token: signToken(goodClaims(flow.params.get("nonce")!, { email, sub: `sub-${email}` })) }));
      const response = await finish(f, flow, { state: flow.params.get("state")!, code: "c" });
      if (allowed) assert.equal(new URL(response.headers.get("location")!).pathname, "/", email);
      else { assert.equal(failureCode(response), "domain", email); assert.equal(await f.db.user.count({ where: { email } }), 0); }
      t.mock.restoreAll();
    }
  } finally { await f.cleanup(); }
});

test("an already signed-in browser is sent home instead of starting another login", async () => {
  const f = await fixture();
  try {
    const user = await f.db.user.create({ data: { googleSub: "s", email: "a@example.test" } });
    const session = loadModule<typeof import("../src/lib/auth/session")>("src/lib/auth/session.ts", { "@/lib/db/client": { db: f.db } });
    const { token } = await session.createSession(user.id);
    const response = await f.start.GET(new Request(`${ORIGIN}/api/auth/login/google`, { headers: { cookie: `__Host-planner_session=${token}` } }));
    assert.equal(new URL(response.headers.get("location")!).pathname, "/");
    assert.equal(await f.db.oAuthFlow.count(), 0);
  } finally { await f.cleanup(); }
});

test("logging in again replaces the previous session rather than reusing its id", async (t) => {
  const f = await fixture();
  try {
    const user = await f.db.user.create({ data: { googleSub: "google-sub-1", email: "ana@example.test" } });
    const session = loadModule<typeof import("../src/lib/auth/session")>("src/lib/auth/session.ts", { "@/lib/db/client": { db: f.db } });
    const old = await session.createSession(user.id);
    const flow = await begin(f);
    fakeGoogle(t, () => ({ id_token: signToken(goodClaims(flow.params.get("nonce")!)) }));
    await finish(f, flow, { state: flow.params.get("state")!, code: "c" }, `${flow.cookie}; __Host-planner_session=${old.token}`);
    assert.equal(await session.resolveSession(old.token), null);
    assert.equal(await f.db.session.count(), 1);
  } finally { await f.cleanup(); }
});

test("pre-multiuser data is claimed by the first login, or only by BOOTSTRAP_ADMIN_EMAIL when set", async (t) => {
  for (const [bootstrap, order] of [[undefined, ["first@example.test"]], ["admin@example.test", ["eve@example.test", "admin@example.test"]]] as const) {
    const f = await fixture();
    try {
      if (bootstrap) process.env.BOOTSTRAP_ADMIN_EMAIL = bootstrap; else delete process.env.BOOTSTRAP_ADMIN_EMAIL;
      await f.db.user.create({ data: { id: "legacy-single-user", googleSub: "pending:legacy-single-user", email: "pending@legacy.invalid" } });
      await f.db.clickUpTask.create({ data: { id: "old-task", title: "Old" } });
      await f.db.userTask.create({ data: { userId: "legacy-single-user", taskId: "old-task" } });
      const owners: string[] = [];
      for (const email of order) {
        const flow = await begin(f);
        fakeGoogle(t, () => ({ id_token: signToken(goodClaims(flow.params.get("nonce")!, { email, sub: `sub-${email}` })) }));
        await finish(f, flow, { state: flow.params.get("state")!, code: "c" });
        owners.push((await f.db.user.findFirstOrThrow({ where: { email } })).id);
        t.mock.restoreAll();
      }
      assert.equal(owners[owners.length - 1], "legacy-single-user", `claimed (bootstrap=${bootstrap})`);
      if (order.length > 1) assert.notEqual(owners[0], "legacy-single-user", "an uninvited first login must not take the data");
      assert.equal((await f.db.userTask.findMany({ where: { userId: owners[0] } })).length, order.length > 1 ? 0 : 1);
      assert.equal((await f.db.user.findUniqueOrThrow({ where: { id: "legacy-single-user" } })).googleSub, `sub-${order[order.length - 1]}`);
    } finally { await f.cleanup(); }
  }
});

test("logout clears the cookie, needs a same-origin request and deletes the server session", async () => {
  const f = await fixture();
  try {
    const user = await f.db.user.create({ data: { googleSub: "s", email: "a@example.test" } });
    const deps = { "@/lib/db/client": { db: f.db } };
    const session = loadModule<typeof import("../src/lib/auth/session")>("src/lib/auth/session.ts", deps);
    const logout = loadModule<typeof import("../src/app/api/auth/logout/route")>("src/app/api/auth/logout/route.ts", deps);
    const { token } = await session.createSession(user.id);
    const headers = { cookie: `__Host-planner_session=${token}` };
    assert.equal((await logout.POST(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers }))).status, 403);
    assert.ok(await session.resolveSession(token), "a cross-site logout attempt changes nothing");
    const response = await logout.POST(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST", headers: { ...headers, origin: ORIGIN } }));
    assert.equal(response.status, 200);
    assert.match(response.headers.getSetCookie().join(), /__Host-planner_session=; .*Max-Age=0/);
    assert.equal(await session.resolveSession(token), null);
  } finally { await f.cleanup(); }
});
