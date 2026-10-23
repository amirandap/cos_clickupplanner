import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configureTestEnvironment, loadModule } from "./helpers";

const http = loadModule<typeof import("../src/lib/planner/http")>("src/lib/planner/http.ts");
const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const post = (headers: Record<string, string>) => new Request("https://planner.test/api/planner/events", { method: "POST", headers });

test("a rejected origin is an authorization error", async () => {
  configureTestEnvironment();
  assert.throws(() => http.assertSameOrigin(post({ origin: "https://other.test" })), http.OriginError);
  const result = http.apiFailure(new http.OriginError("Origen no permitido"));
  assert.equal(result.status, 403);
});

test("CSRF: Origin must match APP_URL, and a missing Origin needs Sec-Fetch-Site same-origin", () => {
  configureTestEnvironment();
  assert.doesNotThrow(() => http.assertSameOrigin(post({ origin: "https://planner.test" })));
  assert.doesNotThrow(() => http.assertSameOrigin(post({ "sec-fetch-site": "same-origin" })));
  for (const headers of [
    {}, // no Origin and no Fetch Metadata used to be let through
    { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "none" },
    { origin: "null" }, { origin: "https://planner.test.evil.test" }, { origin: "http://planner.test" },
    { origin: "https://other.test", "sec-fetch-site": "same-origin" },
  ] as Record<string, string>[]) assert.throws(() => http.assertSameOrigin(post(headers)), http.OriginError, JSON.stringify(headers));
});

test("the Origin check uses APP_URL, not the Host header the client sent", () => {
  configureTestEnvironment();
  process.env.APP_URL = "https://planner.example.org";
  assert.throws(() => http.assertSameOrigin(new Request("https://planner.test/api/x", { method: "POST", headers: { origin: "https://planner.test", host: "planner.test" } })), http.OriginError);
  assert.doesNotThrow(() => http.assertSameOrigin(new Request("http://127.0.0.1:3000/api/x", { method: "POST", headers: { origin: "https://planner.example.org" } })));
});

test("validation failures keep their status and message", async () => {
  const result = http.apiFailure(new http.HttpError(409, "La operación ya existe"));
  assert.equal(result.status, 409);
  assert.deepEqual(await result.json(), { error: "La operación ya existe" });
});

test("unexpected internal errors do not expose provider or database payloads", async () => {
  const result = http.apiFailure(new Error("database connection includes confidential detail"));
  assert.equal(result.status, 500);
  assert.equal(JSON.stringify(await result.json()).includes("confidential"), false);
});

test("a revoked credential is reported as a reconnection request with a stable code", async () => {
  const result = http.apiFailure(new http.ReconnectRequiredError("google_calendar"));
  assert.equal(result.status, 409);
  const body = await result.json();
  assert.equal(body.code, "reconnect_required");
  assert.match(body.error, /Ajustes/);
});
