import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./helpers";

const http = loadModule<typeof import("../src/lib/planner/http")>("src/lib/planner/http.ts");

test("a rejected origin is an authorization error", async () => {
  assert.throws(() => http.assertSameOrigin(new Request("https://planner.test/api/events", {
    headers: { origin: "https://other.test" },
  })), http.OriginError);
  const result = http.apiFailure(new http.OriginError("Origen no permitido"));
  assert.equal(result.status, 403);
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
