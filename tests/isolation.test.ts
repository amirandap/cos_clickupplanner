import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configureTestEnvironment, createTestDatabase, createTestTask, createTestUser, loadModule, sessionCookieFor } from "./helpers";

const original = { ...process.env };
afterEach(() => { process.env = { ...original }; });
const ORIGIN = "https://planner.test";

type Call = { fn: string; userId: string; args: unknown[] };
type Handler = (request: Request) => Promise<Response>;
type Route = Partial<Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Handler>>;

/**
 * Two users share one database. Several ids deliberately collide (the same
 * Google event id and ClickUp task id exist for both) because that is what
 * happens in real life when two attendees share an event or a workspace.
 */
async function fixture() {
  configureTestEnvironment();
  const database = await createTestDatabase();
  const { db } = database;
  const a = await createTestUser(db, "user-a", { calendarId: "primary", listIds: ["list-a"], clickupUserId: "111" });
  const b = await createTestUser(db, "user-b", { calendarId: "primary", listIds: ["list-b"], clickupUserId: "222" });
  await createTestTask(db, "task-a", "list-a", ["user-a"]);
  await createTestTask(db, "task-b", "list-b", ["user-b"]);
  await createTestTask(db, "task-shared", "list-a", ["user-a", "user-b"]);
  // Visible to both: it is in A's list and B is one of its assignees.
  await db.clickUpTask.update({ where: { id: "task-shared" }, data: { rawJson: { assignees: [{ id: 111 }, { id: 222 }] } } });
  const event = (userId: string, id: string, title: string, taskId: string | null = null) => db.calendarEvent.create({ data: {
    userId, id, calendarId: "primary", title, clickupTaskId: taskId, startAt: new Date("2026-10-20T10:00:00Z"), endAt: new Date("2026-10-20T10:30:00Z"),
    rawJson: { id, summary: title, start: { dateTime: "2026-10-20T10:00:00Z" }, end: { dateTime: "2026-10-20T10:30:00Z" } },
  } });
  await event("user-a", "event-a", "A only");
  await event("user-b", "event-b", "B only", "task-b");
  await event("user-a", "event-shared", "A copy");
  await event("user-b", "event-shared", "B copy");
  await db.taskEventLink.create({ data: { userId: "user-b", clickupTaskId: "task-b", calendarEventId: "event-b" } });
  await db.scheduleOperation.create({ data: { userId: "user-b", id: "operation-b-0001", payloadHash: "x", calendarEventId: "plannerb0001", calendarId: "primary", clickupTaskId: "task-b", title: "t", startAt: new Date(), endAt: new Date() } });

  const calls: Call[] = [];
  const record = (fn: string) => (ctx: { userId: string }, ...args: unknown[]) => { calls.push({ fn, userId: ctx.userId, args }); };
  const remoteEvents = new Map<string, Record<string, unknown>>();
  const deps = {
    "@/lib/db/client": { db },
    "@/lib/google/calendar": {
      getRemoteEvent: async (ctx: { userId: string }, id: string) => {
        calls.push({ fn: "getRemoteEvent", userId: ctx.userId, args: [id] });
        const row = await db.calendarEvent.findUniqueOrThrow({ where: { userId_id: { userId: ctx.userId, id } } });
        return { id, etag: "v1", start: { dateTime: row.startAt.toISOString() }, end: { dateTime: row.endAt.toISOString() },
          extendedProperties: { private: row.clickupTaskId ? { plannerLinkedClickupTaskId: row.clickupTaskId } : {} } };
      },
      createRemoteEvent: async (ctx: { userId: string }, taskId: string, title: string, startAt: Date, endAt: Date, id: string) => {
        calls.push({ fn: "createRemoteEvent", userId: ctx.userId, args: [taskId, id] });
        const remote = { id, summary: title, start: { dateTime: startAt.toISOString() }, end: { dateTime: endAt.toISOString() }, extendedProperties: { private: { source: "planner", clickupTaskId: taskId } } };
        remoteEvents.set(`${ctx.userId}:${id}`, remote);
        return remote;
      },
      linkRemoteEvent: async (ctx: { userId: string }, remote: unknown) => { calls.push({ fn: "linkRemoteEvent", userId: ctx.userId, args: [] }); return remote; },
      updateRemoteEvent: async (ctx: { userId: string }) => { calls.push({ fn: "updateRemoteEvent", userId: ctx.userId, args: [] }); return { updated: new Date().toISOString() }; },
      renameRemoteEvent: async (ctx: { userId: string }, _id: string, _cal: string, title: string) => { calls.push({ fn: "renameRemoteEvent", userId: ctx.userId, args: [] }); return { summary: title, updated: new Date().toISOString() }; },
      deleteRemoteEvent: record("deleteRemoteEvent"), unlinkRemoteEvent: async (ctx: { userId: string }, remote: unknown) => { calls.push({ fn: "unlinkRemoteEvent", userId: ctx.userId, args: [] }); return remote; },
    },
    "@/lib/clickup/tasks": {
      getRemoteTask: async (ctx: { userId: string }, id: string) => {
        calls.push({ fn: "getRemoteTask", userId: ctx.userId, args: [id] });
        const task = await db.clickUpTask.findUnique({ where: { id } });
        return task ? { ...(task.rawJson as object | null ?? {}), id, name: task.title, list: { id: task.listId } } : null;
      },
      updateRemoteTaskDueDate: async (ctx: { userId: string }) => { calls.push({ fn: "updateRemoteTaskDueDate", userId: ctx.userId, args: [] }); return {}; },
      createRemoteTaskComment: async (ctx: { userId: string }) => { calls.push({ fn: "createRemoteTaskComment", userId: ctx.userId, args: [] }); return { id: "c" }; },
      completeRemoteTask: async (ctx: { userId: string }) => { calls.push({ fn: "completeRemoteTask", userId: ctx.userId, args: [] }); return { status: { status: "closed" } }; },
      getClosedStatus: async () => "closed",
      archiveRemoteTask: async (ctx: { userId: string }, id: string, archived = true) => { calls.push({ fn: "archiveRemoteTask", userId: ctx.userId, args: [id, archived] }); },
      createRemoteTask: async (ctx: { userId: string }, listId: string, name: string, assignee: string | null) => {
        calls.push({ fn: "createRemoteTask", userId: ctx.userId, args: [listId, assignee] });
        return { id: `new-${ctx.userId}`, name, list: { id: listId }, date_updated: String(Date.now()) };
      },
    },
    "@/lib/sync/run": {
      syncClickUp: async (ctx: { userId: string }) => { calls.push({ fn: "syncClickUp", userId: ctx.userId, args: [] }); return 1; },
      syncGoogle: async (ctx: { userId: string }) => { calls.push({ fn: "syncGoogle", userId: ctx.userId, args: [] }); return 1; },
    },
  };
  const load = (file: string) => loadModule<Route>(`src/app/api/${file}/route.ts`, deps);
  const routes = {
    planner: load("planner"), tasks: load("planner/tasks"), events: load("planner/events"), sync: load("sync"),
    settings: load("settings"), clickup: load("settings/clickup"), google: load("settings/google-calendar"),
  };
  const cookies = { a: await sessionCookieFor(db, "user-a"), b: await sessionCookieFor(db, "user-b") };

  async function call(route: Route, method: keyof Route, who: "a" | "b" | "anon", body?: unknown, headers: Record<string, string> = {}, path = "/api/x") {
    const init: RequestInit = { method, headers: {
      ...(who === "anon" ? {} : { cookie: cookies[who] }), ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
    const response = await route[method]!(new Request(`${ORIGIN}${path}`, init));
    return { status: response.status, body: await response.json().catch(() => null) as Record<string, unknown> | null, headers: response.headers };
  }

  /** Every row of every user-owned table, so "nothing changed" is a single comparison. */
  async function snapshot() {
    return JSON.stringify({
      tasks: await db.clickUpTask.findMany({ orderBy: { id: "asc" } }), members: await db.userTask.findMany({ orderBy: [{ userId: "asc" }, { taskId: "asc" }] }),
      events: await db.calendarEvent.findMany({ orderBy: [{ userId: "asc" }, { id: "asc" }] }), links: await db.taskEventLink.findMany({ orderBy: { id: "asc" } }),
      operations: await db.scheduleOperation.findMany({ orderBy: [{ userId: "asc" }, { id: "asc" }] }), settings: await db.userSettings.findMany({ orderBy: { userId: "asc" } }),
      credentials: await db.userCredential.findMany({ orderBy: [{ userId: "asc" }, { provider: "asc" }] }), syncStates: await db.syncState.findMany({ orderBy: [{ userId: "asc" }, { id: "asc" }] }),
    });
  }
  return { ...database, a, b, calls, routes, call, snapshot, deps, event, remoteEvents };
}

const START = "2026-10-21T10:00:00.000Z";
const END = "2026-10-21T11:00:00.000Z";

test("GET /api/planner shows each user only their own tasks and events", async () => {
  const f = await fixture();
  try {
    const query = "?start=2026-10-19T00:00:00Z&end=2026-10-26T00:00:00Z";
    const a = await f.call(f.routes.planner, "GET", "a", undefined, {}, `/api/planner${query}`);
    const b = await f.call(f.routes.planner, "GET", "b", undefined, {}, `/api/planner${query}`);
    const ids = (r: typeof a, key: "tasks" | "events") => (r.body![key] as { id: string }[]).map((item) => item.id).sort();
    assert.deepEqual(ids(a, "tasks"), ["task-a", "task-shared"]);
    assert.deepEqual(ids(b, "tasks"), ["task-b", "task-shared"]);
    assert.deepEqual(ids(a, "events"), ["event-a", "event-shared"]);
    assert.deepEqual(ids(b, "events"), ["event-b", "event-shared"]);
    assert.equal((a.body!.events as { id: string; title: string }[]).find((item) => item.id === "event-shared")!.title, "A copy");
    assert.equal((b.body!.events as { id: string; title: string }[]).find((item) => item.id === "event-shared")!.title, "B copy");
    assert.equal(a.body!.defaultAssigneeId, "111");
    assert.equal(JSON.stringify(a.body).includes("task-b"), false);
  } finally { await f.cleanup(); }
});

test("typing another user's list id into Settings does not reveal their tasks", async () => {
  const f = await fixture();
  try {
    const put = await f.call(f.routes.settings, "PUT", "b", { calendarId: "primary", listIds: "list-a,list-b", timezone: "UTC" });
    assert.equal(put.status, 200);
    const b = await f.call(f.routes.planner, "GET", "b");
    // task-a lives in list-a, but B's own token never fetched it, so it is not in B's view.
    assert.deepEqual((b.body!.tasks as { id: string }[]).map((task) => task.id).sort(), ["task-b", "task-shared"]);
  } finally { await f.cleanup(); }
});

test("task routes: a foreign task is an identical 404 to a missing one, and nothing changes", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    for (const method of ["PATCH", "DELETE", "POST"] as const) {
      const foreign = await f.call(f.routes.tasks, method, "a", { id: "task-b" });
      const missing = await f.call(f.routes.tasks, method, "a", { id: "task-does-not-exist" });
      assert.equal(foreign.status, 404, method);
      assert.deepEqual(foreign.body, missing.body, `${method}: uniform error body`);
      // And in the other direction.
      assert.equal((await f.call(f.routes.tasks, method, "b", { id: "task-a" })).status, 404, `${method} b->a`);
    }
    assert.equal(await f.snapshot(), before);
    assert.deepEqual(f.calls.filter((call) => !["getRemoteTask"].includes(call.fn)), [], "no remote mutation was attempted");
  } finally { await f.cleanup(); }
});

test("task routes: the owner's own operations work and only touch their rows", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(f.routes.tasks, "PATCH", "a", { id: "task-a" })).status, 200);
    assert.equal((await f.call(f.routes.tasks, "PUT", "a", { title: "Nueva" })).status, 201);
    assert.deepEqual(f.calls.filter((call) => call.fn === "createRemoteTask").map((call) => [call.userId, call.args]), [["user-a", ["list-a", "111"]]]);
    assert.ok(await f.db.userTask.findUnique({ where: { userId_taskId: { userId: "user-a", taskId: "new-user-a" } } }));
    assert.equal(await f.db.userTask.count({ where: { userId: "user-b", taskId: "new-user-a" } }), 0);
    assert.ok(f.calls.every((call) => call.userId === "user-a"));
  } finally { await f.cleanup(); }
});

test("archiving a shared task hides it only for the archiver, and only they can undo it", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(f.routes.tasks, "DELETE", "a", { id: "task-shared" })).status, 200);
    const ids = async (who: "a" | "b") => ((await f.call(f.routes.planner, "GET", who)).body!.tasks as { id: string }[]).map((task) => task.id);
    assert.deepEqual(await ids("a"), ["task-a"]);
    assert.deepEqual(await ids("b"), ["task-b", "task-shared"]);
    assert.equal((await f.call(f.routes.tasks, "POST", "b", { id: "task-shared" })).status, 404, "B never archived it, so B cannot restore it");
    assert.equal(f.calls.filter((call) => call.fn === "archiveRemoteTask" && call.args[1] === false).length, 0);
    assert.equal((await f.call(f.routes.tasks, "POST", "a", { id: "task-shared" })).status, 200);
    assert.deepEqual(await ids("a"), ["task-a", "task-shared"]);
  } finally { await f.cleanup(); }
});

test("event routes: a foreign event or task is an identical 404 to a missing one, and nothing changes", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const key = { "Idempotency-Key": "operation-iso-0001" };
    const attempts: [string, keyof Route, unknown, unknown, Record<string, string>][] = [
      ["reschedule", "PATCH", { id: "event-b", startAt: START, endAt: END }, { id: "event-missing", startAt: START, endAt: END }, {}],
      ["rename", "PATCH", { id: "event-b", title: "hijacked" }, { id: "event-missing", title: "hijacked" }, {}],
      ["link foreign event", "PATCH", { id: "event-b", taskId: "task-a" }, { id: "event-missing", taskId: "task-a" }, {}],
      ["link foreign task", "PATCH", { id: "event-a", taskId: "task-b" }, { id: "event-a", taskId: "task-missing" }, {}],
      ["unlink", "DELETE", { id: "event-b" }, { id: "event-missing" }, {}],
      ["hard delete", "DELETE", { id: "event-b", hard: true }, { id: "event-missing", hard: true }, {}],
      ["schedule foreign task", "POST", { taskId: "task-b", startAt: START }, { taskId: "task-missing", startAt: START }, key],
    ];
    for (const [name, method, foreignBody, missingBody, headers] of attempts) {
      const foreign = await f.call(f.routes.events, method, "a", foreignBody, headers);
      const missing = await f.call(f.routes.events, method, "a", missingBody, headers);
      assert.equal(foreign.status, 404, name);
      assert.deepEqual(foreign.body, missing.body, `${name}: uniform error body`);
    }
    assert.equal(await f.snapshot(), before);
    assert.deepEqual(f.calls.filter((call) => !["getRemoteTask", "getRemoteEvent"].includes(call.fn)), [], "no remote mutation was attempted");
    assert.equal(f.calls.some((call) => call.args.includes("event-b") && call.fn !== "getRemoteEvent"), false);
  } finally { await f.cleanup(); }
});

test("an event id that exists for both users only ever changes the caller's copy", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(f.routes.events, "PATCH", "a", { id: "event-shared", title: "Renamed by A" })).status, 200);
    assert.equal((await f.db.calendarEvent.findUniqueOrThrow({ where: { userId_id: { userId: "user-a", id: "event-shared" } } })).title, "Renamed by A");
    assert.equal((await f.db.calendarEvent.findUniqueOrThrow({ where: { userId_id: { userId: "user-b", id: "event-shared" } } })).title, "B copy");
    assert.equal((await f.call(f.routes.events, "PATCH", "a", { id: "event-shared", startAt: START, endAt: END })).status, 200);
    assert.equal((await f.db.calendarEvent.findUniqueOrThrow({ where: { userId_id: { userId: "user-b", id: "event-shared" } } })).startAt.toISOString(), "2026-10-20T10:00:00.000Z");
    assert.equal((await f.call(f.routes.events, "DELETE", "a", { id: "event-shared", hard: true })).status, 200);
    assert.equal(await f.db.calendarEvent.count({ where: { id: "event-shared" } }), 1);
    assert.equal((await f.db.calendarEvent.findFirstOrThrow({ where: { id: "event-shared" } })).userId, "user-b");
    assert.ok(f.calls.every((call) => call.userId === "user-a"));
  } finally { await f.cleanup(); }
});

test("link and unlink only touch the caller's event, task and link rows", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(f.routes.events, "PATCH", "a", { id: "event-a", taskId: "task-shared" })).status, 200);
    assert.equal((await f.db.taskEventLink.findMany({ where: { userId: "user-a" } })).length, 1);
    assert.equal(await f.db.taskEventLink.count({ where: { userId: "user-b" } }), 1, "B's link is untouched");
    assert.equal((await f.call(f.routes.events, "DELETE", "a", { id: "event-a" })).status, 200);
    assert.equal(await f.db.taskEventLink.count({ where: { userId: "user-b" } }), 1);
  } finally { await f.cleanup(); }
});

test("the same Idempotency-Key from two users creates two independent events with different Google ids", async () => {
  const f = await fixture();
  try {
    const key = { "Idempotency-Key": "shared-key-0001" };
    const a = await f.call(f.routes.events, "POST", "a", { taskId: "task-a", startAt: START }, key);
    const b = await f.call(f.routes.events, "POST", "b", { taskId: "task-b", startAt: START }, key);
    assert.equal(a.status, 201);
    assert.equal(b.status, 201, "B's key is not 'already used by someone else'");
    assert.notEqual(a.body!.id, b.body!.id, "the Google id derives from user and operation");
    assert.match(String(a.body!.id), /^planner[0-9a-f]{64}$/);
    assert.equal(await f.db.scheduleOperation.count({ where: { id: "shared-key-0001" } }), 2);
    // B replaying the key gets B's own event back, and A's key still maps to A's.
    const again = await f.call(f.routes.events, "POST", "b", { taskId: "task-b", startAt: START }, key);
    assert.deepEqual([again.status, again.body!.id], [200, b.body!.id]);
    // B cannot learn or reuse A's operation id for another task.
    assert.equal((await f.call(f.routes.events, "POST", "b", { taskId: "task-shared", startAt: START }, key)).status, 409);
    assert.equal(f.calls.filter((call) => call.fn === "createRemoteEvent").length, 2);
    // B's pre-existing operation id is invisible to A.
    const probe = await f.call(f.routes.events, "POST", "a", { taskId: "task-a", startAt: START }, { "Idempotency-Key": "operation-b-0001" });
    assert.equal(probe.status, 201);
    assert.notEqual(probe.body!.id, "plannerb0001");
  } finally { await f.cleanup(); }
});

test("every planner and settings route refuses anonymous callers without touching data", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const cases: [Route, keyof Route, unknown][] = [
      [f.routes.planner, "GET", undefined], [f.routes.tasks, "PATCH", { id: "task-a" }], [f.routes.tasks, "DELETE", { id: "task-a" }],
      [f.routes.tasks, "POST", { id: "task-a" }], [f.routes.tasks, "PUT", { title: "x" }], [f.routes.events, "POST", { taskId: "task-a", startAt: START }],
      [f.routes.events, "PATCH", { id: "event-a", title: "x" }], [f.routes.events, "DELETE", { id: "event-a" }], [f.routes.sync, "POST", {}],
      [f.routes.settings, "GET", undefined], [f.routes.settings, "PUT", { calendarId: "x", listIds: "", timezone: "UTC" }],
      [f.routes.clickup, "PUT", { token: "pk_12345678" }], [f.routes.clickup, "DELETE", {}], [f.routes.google, "DELETE", {}],
    ];
    for (const [route, method, body] of cases) {
      const response = await f.call(route, method, "anon", body, { "Idempotency-Key": "operation-anon-1" });
      assert.equal(response.status, 401, `${method}`);
    }
    assert.equal(await f.snapshot(), before);
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test("CSRF: every state-changing route rejects a missing or foreign Origin even with a valid session", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    const cases: [Route, keyof Route, unknown][] = [
      [f.routes.tasks, "PATCH", { id: "task-a" }], [f.routes.tasks, "DELETE", { id: "task-a" }], [f.routes.tasks, "POST", { id: "task-a" }],
      [f.routes.tasks, "PUT", { title: "x" }], [f.routes.events, "POST", { taskId: "task-a", startAt: START }], [f.routes.events, "PATCH", { id: "event-a", title: "x" }],
      [f.routes.events, "DELETE", { id: "event-a" }], [f.routes.sync, "POST", {}], [f.routes.settings, "PUT", { calendarId: "x", listIds: "", timezone: "UTC" }],
      [f.routes.clickup, "PUT", { token: "pk_12345678" }], [f.routes.clickup, "DELETE", {}], [f.routes.google, "DELETE", {}],
    ];
    for (const [route, method, body] of cases) {
      for (const origin of [undefined, "https://evil.test", "null"]) {
        const headers: Record<string, string> = { cookie: await sessionCookieFor(f.db, "user-a"), "content-type": "application/json", "Idempotency-Key": "operation-csrf-1", ...(origin ? { origin } : {}) };
        const response = await route[method]!(new Request(`${ORIGIN}/api/x`, { method, headers, body: JSON.stringify(body) }));
        assert.equal(response.status, 403, `${method} origin=${origin}`);
      }
    }
    assert.equal(await f.snapshot(), before);
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test("POST /api/sync runs only for the caller and never for another user", async () => {
  const f = await fixture();
  try {
    await f.db.userCredential.createMany({ data: [
      { userId: "user-a", provider: "clickup", accessTokenEnc: "x" }, { userId: "user-a", provider: "google_calendar", accessTokenEnc: "x" },
    ] });
    const response = await f.call(f.routes.sync, "POST", "a", {});
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { clickup: 1, google: 1, pending: 0 });
    assert.deepEqual(f.calls.map((call) => [call.fn, call.userId]), [["syncClickUp", "user-a"], ["syncGoogle", "user-a"]]);
    // B has nothing connected: B's sync is a warning, and A's credentials are not borrowed.
    f.calls.length = 0;
    const other = await f.call(f.routes.sync, "POST", "b", {});
    assert.equal(other.status, 200);
    assert.match(String(other.body!.warning), /ClickUp/);
    assert.match(String(other.body!.warning), /Google Calendar/);
    assert.deepEqual(f.calls, []);
  } finally { await f.cleanup(); }
});

test("sync only completes pending ClickUp work for the caller's links", async () => {
  const f = await fixture();
  try {
    await f.db.userCredential.createMany({ data: [
      { userId: "user-a", provider: "clickup", accessTokenEnc: "x" }, { userId: "user-a", provider: "google_calendar", accessTokenEnc: "x" },
    ] });
    await f.db.taskEventLink.update({ where: { userId_calendarEventId: { userId: "user-b", calendarEventId: "event-b" } }, data: { clickupSyncPending: true } });
    const before = await f.snapshot();
    assert.equal((await f.call(f.routes.sync, "POST", "a", {})).body!.pending, 0);
    assert.equal(await f.snapshot(), before);
    assert.equal(f.calls.some((call) => ["updateRemoteTaskDueDate", "createRemoteTaskComment"].includes(call.fn)), false);
  } finally { await f.cleanup(); }
});

test("Settings: reads and writes are per user", async () => {
  const f = await fixture();
  try {
    const before = JSON.parse(await f.snapshot()).settings;
    const put = await f.call(f.routes.settings, "PUT", "a", { calendarId: "work@example.test", listIds: ["l1", "l2"], timezone: "America/Santo_Domingo" });
    assert.equal(put.status, 200);
    assert.deepEqual(put.body!.settings, { calendarId: "work@example.test", listIds: ["l1", "l2"], timezone: "America/Santo_Domingo" });
    const b = await f.call(f.routes.settings, "GET", "b");
    assert.equal(b.status, 200);
    assert.equal(b.body!.email, "user-b@example.test");
    assert.deepEqual(b.body!.settings, { calendarId: "primary", listIds: ["list-b"], timezone: "UTC" });
    const after = JSON.parse(await f.snapshot()).settings;
    assert.deepEqual(after[1], before[1], "B's settings row is byte-identical");
    for (const bad of [{ calendarId: "", listIds: "", timezone: "UTC" }, { calendarId: "x", listIds: "a b", timezone: "UTC" }, { calendarId: "x", listIds: "", timezone: "Mars/Olympus" }, { calendarId: "x", listIds: new Array(60).fill("1").map((v, i) => `${v}${i}`), timezone: "UTC" }, "nope", null]) {
      assert.equal((await f.call(f.routes.settings, "PUT", "a", bad)).status, 400, JSON.stringify(bad));
    }
  } finally { await f.cleanup(); }
});

test("Settings: disconnecting removes only the caller's credentials", async () => {
  const f = await fixture();
  try {
    const store = loadModule<typeof import("../src/lib/auth/credentials")>("src/lib/auth/credentials.ts", f.deps);
    for (const user of ["user-a", "user-b"]) {
      await store.saveCredential(user, "clickup", { accessToken: `pk_${user}_token` });
      await store.saveCredential(user, "google_calendar", { accessToken: "a", refreshToken: `refresh-${user}` });
    }
    const revokes: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes("/revoke")) { revokes.push(String(new URLSearchParams(String(init?.body)).get("token"))); return Response.json({}); }
      return real(input, init);
    }) as typeof fetch;
    try {
      assert.equal((await f.call(f.routes.google, "DELETE", "a", {})).status, 200);
      assert.equal((await f.call(f.routes.clickup, "DELETE", "a", {})).status, 200);
    } finally { globalThis.fetch = real; }
    assert.deepEqual(revokes, ["refresh-user-a"]);
    assert.deepEqual((await f.db.userCredential.findMany()).map((row) => row.userId), ["user-b", "user-b"]);
    assert.equal((await store.getCredential("user-b", "clickup"))?.accessToken, "pk_user-b_token");
    assert.equal((await f.db.userSettings.findUniqueOrThrow({ where: { userId: "user-a" } })).clickupUserId, null);
    assert.equal((await f.db.userSettings.findUniqueOrThrow({ where: { userId: "user-b" } })).clickupUserId, "222");
    assert.equal(await f.db.userTask.count({ where: { userId: "user-a" } }), 0);
    assert.equal(await f.db.userTask.count({ where: { userId: "user-b" } }), 2);
  } finally { await f.cleanup(); }
});

test("a mutation lock held for one user does not block another user", async () => {
  const f = await fixture();
  try {
    await f.db.mutationLease.create({ data: { key: "planner:user-a", owner: "someone", expiresAt: new Date(Date.now() + 60_000) } });
    const started = Date.now();
    const response = await f.call(f.routes.tasks, "PATCH", "b", { id: "task-b" });
    assert.equal(response.status, 200);
    assert.ok(Date.now() - started < 2000);
    assert.deepEqual(await f.db.mutationLease.findMany().then((rows) => rows.map((row) => row.key)), ["planner:user-a"]);
  } finally { await f.cleanup(); }
});
