import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configureTestEnvironment, createTestDatabase, createTestUser, loadModule, sessionCookieFor } from "./helpers";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

test("the limiter blocks after the limit, reports Retry-After, and resets with the window", async () => {
  configureTestEnvironment();
  const f = await createTestDatabase();
  try {
    const limiter = loadModule<typeof import("../src/lib/ratelimit")>("src/lib/ratelimit.ts", { "@/lib/db/client": { db: f.db } });
    const start = new Date("2026-10-20T10:00:00Z");
    for (let i = 0; i < 3; i++) await limiter.enforceRateLimit("k", 3, 60_000, new Date(start.getTime() + i * 1000));
    await assert.rejects(limiter.enforceRateLimit("k", 3, 60_000, new Date(start.getTime() + 10_000)), (error: unknown) => {
      const e = error as { status: number; retryAfter: number };
      return e.status === 429 && e.retryAfter === 50;
    });
    await limiter.enforceRateLimit("other-key", 3, 60_000, start);
    await limiter.enforceRateLimit("k", 3, 60_000, new Date(start.getTime() + 61_000));
    assert.equal((await f.db.rateLimit.findUniqueOrThrow({ where: { key: "k" } })).count, 1);
  } finally { await f.cleanup(); }
});

test("concurrent requests cannot exceed the limit", async () => {
  configureTestEnvironment();
  const f = await createTestDatabase();
  try {
    const limiter = loadModule<typeof import("../src/lib/ratelimit")>("src/lib/ratelimit.ts", { "@/lib/db/client": { db: f.db } });
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => limiter.enforceRateLimit("burst", 5, 60_000)));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
  } finally { await f.cleanup(); }
});

test("POST /api/sync is limited per user and answers 429 with Retry-After", async () => {
  configureTestEnvironment();
  const f = await createTestDatabase();
  try {
    await createTestUser(f.db, "user-a"); await createTestUser(f.db, "user-b");
    let syncs = 0;
    const route = loadModule<typeof import("../src/app/api/sync/route")>("src/app/api/sync/route.ts", {
      "@/lib/db/client": { db: f.db },
      "@/lib/sync/run": { syncClickUp: async () => { syncs++; return 0; }, syncGoogle: async () => 0 },
    });
    const cookies = { a: await sessionCookieFor(f.db, "user-a"), b: await sessionCookieFor(f.db, "user-b") };
    const post = (who: "a" | "b") => route.POST(new Request("https://planner.test/api/sync", { method: "POST", headers: { cookie: cookies[who], origin: "https://planner.test" } }));
    for (let i = 0; i < 10; i++) assert.equal((await post("a")).status, 200, `request ${i + 1}`);
    const blocked = await post("a");
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
    assert.equal((await post("b")).status, 200, "user B has an independent budget");
    assert.equal(syncs, 0, "no provider is called without connected credentials");
  } finally { await f.cleanup(); }
});

test("login starts are limited per client address", async () => {
  configureTestEnvironment();
  const f = await createTestDatabase();
  try {
    const start = loadModule<typeof import("../src/app/api/auth/login/google/route")>("src/app/api/auth/login/google/route.ts", { "@/lib/db/client": { db: f.db } });
    const get = (ip: string) => start.GET(new Request("https://planner.test/api/auth/login/google", { headers: { "x-forwarded-for": ip } }));
    for (let i = 0; i < 20; i++) assert.equal((await get("203.0.113.9")).status, 303);
    assert.equal((await get("203.0.113.9")).status, 429);
    assert.equal((await get("203.0.113.10")).status, 303);
    assert.ok(await f.db.oAuthFlow.count() <= 41);
  } finally { await f.cleanup(); }
});
