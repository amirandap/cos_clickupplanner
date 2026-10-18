import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { NextRequest } from "next/server";
import * as http from "../src/lib/providers/http";
import * as credentials from "../src/lib/sync/credentials";
import { loadModule } from "./helpers";

type Provider = "google" | "clickup";
type Callback = { GET(request: NextRequest): Promise<Response> };
type OAuthResult = { provider: Provider; connected: boolean; error?: string };
const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

function configure() {
  process.env.APP_URL = "https://planner.test";
  process.env.GOOGLE_CLIENT_ID = "google-test-client";
  process.env.GOOGLE_CLIENT_SECRET = "google-test-secret";
  process.env.CLICKUP_CLIENT_ID = "clickup-test-client";
  process.env.CLICKUP_CLIENT_SECRET = "clickup-test-secret";
}

function callback(provider: Provider, validateOAuth = () => "authorization-code") {
  const writes: unknown[] = [];
  const db = { oAuthCredential: {
    findUnique: async () => ({ refreshToken: "existing-refresh" }),
    upsert: async (args: unknown) => { writes.push(args); },
  } };
  const oauth = {
    appUrl: () => "https://planner.test",
    validateOAuth,
    finishOAuth: (value: Provider, error?: string) => Response.json({ provider: value, connected: !error, ...(error ? { error } : {}) }),
  };
  const route = loadModule<Callback>(`src/app/api/auth/${provider}/callback/route.ts`, {
    "@/lib/db/client": { db },
    "@/lib/sync/oauth": oauth,
    "@/lib/providers/http": http,
    "@/lib/sync/credentials": credentials,
  });
  return { route, writes };
}

function request(provider: Provider) {
  return new NextRequest(`https://planner.test/api/auth/${provider}/callback?state=state&code=code`);
}

test("Google callback refuses invalid credentials before any persistence", async (t) => {
  configure();
  const invalid = [
    {}, { access_token: "", expires_in: 3600 }, { access_token: "   ", expires_in: 3600 },
    { access_token: "access", expires_in: 3600 }, { access_token: "access", expires_in: 3600, refresh_token: " " },
    { access_token: 123, expires_in: 3600 }, { access_token: "access", expires_in: "3600" },
    { access_token: "access", expires_in: 0 }, { access_token: "access", expires_in: -1 },
    { access_token: "access", expires_in: 1e16 }, { access_token: "access", expires_in: 3600, refresh_token: 123 },
  ];
  for (const payload of invalid) {
    const { route, writes } = callback("google");
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    const result = await (await route.GET(request("google"))).json() as OAuthResult;
    assert.equal(result.connected, false, `invalid payload was accepted: ${JSON.stringify(payload)}`);
    assert.equal(writes.length, 0);
  }
});

test("ClickUp callback refuses missing and whitespace access tokens", async (t) => {
  configure();
  for (const payload of [{}, { access_token: "" }, { access_token: " " }, { access_token: false }]) {
    const { route, writes } = callback("clickup");
    t.mock.method(globalThis, "fetch", async () => Response.json(payload));
    const result = await (await route.GET(request("clickup"))).json() as OAuthResult;
    assert.equal(result.connected, false);
    assert.equal(writes.length, 0);
  }
});

test("OAuth callbacks fail before network access when client configuration is missing", async (t) => {
  configure();
  delete process.env.GOOGLE_CLIENT_SECRET;
  process.env.CLICKUP_CLIENT_ID = " ";
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ access_token: "access", expires_in: 3600 }); });
  for (const provider of ["google", "clickup"] as const) {
    const { route, writes } = callback(provider);
    const result = await (await route.GET(request(provider))).json() as OAuthResult;
    assert.equal(result.connected, false);
    assert.equal(writes.length, 0);
  }
  assert.equal(requests, 0);
});

test("OAuth callbacks use bounded requests without retrying token exchanges", async (t) => {
  configure();
  const signals: (AbortSignal | null | undefined)[] = [];
  t.mock.method(globalThis, "fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    signals.push(init?.signal);
    return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  });
  for (const provider of ["google", "clickup"] as const) {
    const { route, writes } = callback(provider);
    const result = await (await route.GET(request(provider))).json() as OAuthResult;
    assert.equal(result.connected, true);
    assert.equal(writes.length, 1);
  }
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
});

test("OAuth callback errors never disclose upstream bodies or database error details", async (t) => {
  configure();
  const secret = "provider-secret-that-must-not-appear";
  for (const provider of ["google", "clickup"] as const) {
    const { route, writes } = callback(provider);
    t.mock.method(globalThis, "fetch", async () => new Response(secret, { status: 400 }));
    const response = await route.GET(request(provider));
    assert.equal((await response.json() as OAuthResult).connected, false);
    assert.equal(writes.length, 0);
  }
  const failing = loadModule<Callback>("src/app/api/auth/clickup/callback/route.ts", {
    "@/lib/db/client": { db: { oAuthCredential: { upsert: async () => { throw new Error(secret); } } } },
    "@/lib/sync/oauth": { validateOAuth: () => "code", finishOAuth: (_provider: string, error?: string) => Response.json({ error }) },
    "@/lib/providers/http": http,
    "@/lib/sync/credentials": credentials,
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({ access_token: "access" }));
  assert.equal((await (await failing.GET(request("clickup"))).text()).includes(secret), false);
});

test("OAuth state rejection performs no token exchange", async (t) => {
  configure();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({}); });
  const { route, writes } = callback("google", () => { throw new Error("Estado OAuth inválido"); });
  assert.equal((await (await route.GET(request("google"))).json() as OAuthResult).connected, false);
  assert.equal(requests, 0);
  assert.equal(writes.length, 0);
});
