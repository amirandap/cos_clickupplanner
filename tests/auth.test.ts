import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { loadModule } from "./helpers";
import { NextRequest } from "next/server";

type Authorization = { allowed: boolean; status?: number };
const auth = loadModule<{
  authorizeRequest(request: Request): Authorization;
}>("src/lib/auth.ts");
const interception = loadModule<typeof import("../src/proxy")>("src/proxy.ts", { "@/lib/auth": auth });
const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});

function configure() {
  process.env.USE_MOCK_DATA = "false";
  process.env.PLANNER_AUTH_USERNAME = "planner";
  process.env.PLANNER_AUTH_PASSWORD = "a-test-password-for-local-tests";
}

test("real mode denies reads without a user identity", () => {
  configure();
  assert.deepEqual(auth.authorizeRequest(new Request("https://planner.test/api/planner")), {
    allowed: false, status: 401,
  });
});

test("matching Origin does not authorize a write", () => {
  configure();
  const request = new Request("https://planner.test/api/planner/events", {
    method: "POST", headers: { Origin: "https://planner.test" },
  });
  assert.equal(auth.authorizeRequest(request).allowed, false);
});

test("real mode fails closed when credentials are missing or incomplete", () => {
  configure();
  delete process.env.PLANNER_AUTH_PASSWORD;
  assert.deepEqual(auth.authorizeRequest(new Request("https://planner.test/")), {
    allowed: false, status: 503,
  });
});

test("valid credentials authorize reads, writes and OAuth routes", () => {
  configure();
  const authorization = `Basic ${Buffer.from("planner:a-test-password-for-local-tests").toString("base64")}`;
  for (const pathname of ["/", "/api/planner/events", "/api/auth/google/callback"]) {
    assert.deepEqual(auth.authorizeRequest(new Request(`https://planner.test${pathname}`, {
      headers: { authorization },
    })), { allowed: true });
  }
});

test("wrong passwords and malformed Authorization remain unauthorized", () => {
  configure();
  for (const authorization of ["Bearer token", "Basic %%%", `Basic ${Buffer.from("planner:wrong").toString("base64")}`]) {
    assert.equal(auth.authorizeRequest(new Request("https://planner.test/", {
      headers: { authorization },
    })).allowed, false);
  }
});

test("only an explicit mock configuration may run without credentials", () => {
  process.env.USE_MOCK_DATA = "true";
  delete process.env.PLANNER_AUTH_USERNAME;
  delete process.env.PLANNER_AUTH_PASSWORD;
  assert.deepEqual(auth.authorizeRequest(new Request("http://localhost/")), { allowed: true });
  process.env.PLANNER_AUTH_USERNAME = "planner";
  assert.equal(auth.authorizeRequest(new Request("http://localhost/")).allowed, false);
});

test("the real Next proxy protects API and OAuth routes and challenges the browser", async () => {
  configure();
  for (const pathname of ["/", "/api/planner", "/api/planner/events", "/api/auth/google/callback"]) {
    const response = interception.proxy(new NextRequest(`https://planner.test${pathname}`));
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Basic/);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("authenticated Next requests continue to the application", () => {
  configure();
  const response = interception.proxy(new NextRequest("https://planner.test/api/planner", {
    headers: { authorization: `Basic ${Buffer.from("planner:a-test-password-for-local-tests").toString("base64")}` },
  }));
  assert.equal(response.headers.get("x-middleware-next"), "1");
});
