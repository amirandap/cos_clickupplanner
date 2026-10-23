import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configureTestEnvironment, createTestDatabase, createTestUser, loadModule } from "./helpers";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });

async function fixture() {
  configureTestEnvironment();
  const database = await createTestDatabase();
  await createTestUser(database.db, "user-a", { clickupUserId: null });
  await createTestUser(database.db, "user-b", { clickupUserId: null });
  const deps = { "@/lib/db/client": { db: database.db } };
  return {
    ...database,
    settings: loadModule<typeof import("../src/lib/settings/settings")>("src/lib/settings/settings.ts", deps),
    tasks: loadModule<typeof import("../src/lib/clickup/tasks")>("src/lib/clickup/tasks.ts", deps),
    credentials: loadModule<typeof import("../src/lib/auth/credentials")>("src/lib/auth/credentials.ts", deps),
  };
}
const ctx = (userId: string) => ({ userId, calendarId: "primary", listIds: ["list-a"], timezone: "UTC", clickupUserId: null, mock: false });

test("a personal token is validated against GET /user and its user id is stored automatically", async (t) => {
  const f = await fixture();
  try {
    const requests: { url: string; authorization: string | null }[] = [];
    t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") });
      return Response.json({ user: { id: 183, username: "Ana", email: "ana@example.test" } });
    });
    const identity = await f.settings.connectClickUp("user-a", "  pk_183_ABCDEFGH  ");
    assert.deepEqual(requests, [{ url: "https://api.clickup.com/api/v2/user", authorization: "pk_183_ABCDEFGH" }]);
    assert.deepEqual(identity, { clickupUserId: "183", username: "Ana" });
    const settings = await f.db.userSettings.findUniqueOrThrow({ where: { userId: "user-a" } });
    assert.deepEqual([settings.clickupUserId, settings.clickupUsername], ["183", "Ana"]);
    assert.equal((await f.credentials.getCredential("user-a", "clickup"))?.accessToken, "pk_183_ABCDEFGH");
    const row = await f.db.userCredential.findUniqueOrThrow({ where: { userId_provider: { userId: "user-a", provider: "clickup" } } });
    assert.equal(JSON.stringify(row).includes("ABCDEFGH"), false, "stored encrypted");
  } finally { await f.cleanup(); }
});

test("a rejected or malformed token stores nothing", async (t) => {
  const f = await fixture();
  try {
    t.mock.method(globalThis, "fetch", async () => Response.json({ err: "Token invalid", ECODE: "OAUTH_019" }, { status: 401 }));
    await assert.rejects(f.settings.connectClickUp("user-a", "pk_000_REJECTED1"), (error: unknown) => (error as { status?: number }).status === 400);
    for (const bad of ["", "   ", "short", "has space in it", "a".repeat(300), "pk_1\r\nX-Injected: yes", 42, null, undefined]) {
      await assert.rejects(f.settings.connectClickUp("user-a", bad), (error: unknown) => (error as { status?: number }).status === 400, String(bad));
    }
    t.mock.restoreAll();
    t.mock.method(globalThis, "fetch", async () => Response.json({ user: { id: "not-numeric" } }));
    await assert.rejects(f.settings.connectClickUp("user-a", "pk_000_WEIRDBODY"));
    assert.equal(await f.db.userCredential.count(), 0);
    assert.equal((await f.db.userSettings.findUniqueOrThrow({ where: { userId: "user-a" } })).clickupUserId, null);
  } finally { await f.cleanup(); }
});

test("each user's ClickUp calls carry only that user's token", async (t) => {
  const f = await fixture();
  try {
    await f.credentials.saveCredential("user-a", "clickup", { accessToken: "pk_token_of_A" });
    await f.credentials.saveCredential("user-b", "clickup", { accessToken: "oauth_token_of_B", scheme: "bearer" });
    const seen: string[] = [];
    t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get("Authorization") ?? "");
      return Response.json({ tasks: [], last_page: true });
    });
    await f.tasks.listRemoteTasks(ctx("user-a"));
    await f.tasks.listRemoteTasks(ctx("user-b"));
    await f.tasks.listRemoteTasks(ctx("user-a"));
    assert.deepEqual(seen, ["pk_token_of_A", "Bearer oauth_token_of_B", "pk_token_of_A"]);
  } finally { await f.cleanup(); }
});

test("a user without a token never falls back to someone else's", async (t) => {
  const f = await fixture();
  try {
    await f.credentials.saveCredential("user-a", "clickup", { accessToken: "pk_token_of_A" });
    process.env.CLICKUP_TOKEN = "pk_global_from_env"; // the old global setting is ignored
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; return Response.json({ tasks: [] }); });
    await assert.rejects(f.tasks.listRemoteTasks(ctx("user-b")), (error: unknown) => (error as { code?: string }).code === "reconnect_required");
    assert.equal(requests, 0);
  } finally { await f.cleanup(); }
});

test("a 401 from ClickUp marks only that user's token as needing reconnection", async (t) => {
  const f = await fixture();
  try {
    await f.credentials.saveCredential("user-a", "clickup", { accessToken: "pk_token_of_A" });
    await f.credentials.saveCredential("user-b", "clickup", { accessToken: "pk_token_of_B" });
    t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Headers(init?.headers).get("Authorization") === "pk_token_of_A" ? new Response("{}", { status: 401 }) : Response.json({ tasks: [], last_page: true }));
    await assert.rejects(f.tasks.listRemoteTasks(ctx("user-a")), (error: unknown) => (error as { code?: string }).code === "reconnect_required");
    assert.deepEqual(await f.credentials.connectionStates("user-a"), { googleCalendar: "none", clickup: "revoked" });
    assert.equal((await f.credentials.connectionStates("user-b")).clickup, "connected");
    assert.deepEqual(await f.tasks.listRemoteTasks(ctx("user-b")), []);
    assert.equal((await f.credentials.getCredential("user-a", "clickup"))?.accessToken, null, "the dead token is wiped");
  } finally { await f.cleanup(); }
});

test("changing to a different ClickUp account drops the previous account's tasks", async (t) => {
  const f = await fixture();
  try {
    t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      Response.json({ user: { id: new Headers(init?.headers).get("Authorization") === "pk_first_account" ? 1 : 2, username: "x" } }));
    await f.settings.connectClickUp("user-a", "pk_first_account");
    await f.db.clickUpTask.create({ data: { id: "t1", title: "T", listId: "l" } });
    await f.db.userTask.create({ data: { userId: "user-a", taskId: "t1" } });
    await f.settings.connectClickUp("user-a", "pk_first_account");
    assert.equal(await f.db.userTask.count(), 1, "same account keeps its tasks");
    await f.settings.connectClickUp("user-a", "pk_second_account");
    assert.equal(await f.db.userTask.count(), 0);
  } finally { await f.cleanup(); }
});

test("token validation attempts are rate limited per user", async (t) => {
  const f = await fixture();
  try {
    t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 401 }));
    for (let attempt = 0; attempt < 10; attempt++) {
      await assert.rejects(f.settings.connectClickUp("user-a", "pk_000_GUESSING"), (error: unknown) => (error as { status?: number }).status === 400);
    }
    await assert.rejects(f.settings.connectClickUp("user-a", "pk_000_GUESSING"), (error: unknown) => (error as { status?: number }).status === 429);
    await assert.rejects(f.settings.connectClickUp("user-b", "pk_000_GUESSING"), (error: unknown) => (error as { status?: number }).status === 400, "another user has their own budget");
  } finally { await f.cleanup(); }
});
