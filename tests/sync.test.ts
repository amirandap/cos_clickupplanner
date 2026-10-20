import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configureTestEnvironment, createTestDatabase, createTestTask, createTestUser, loadModule } from "./helpers";
import { ProviderHttpError } from "../src/lib/providers/http";

const environment = { ...process.env };
afterEach(() => { process.env = { ...environment }; });

async function fixture() {
  configureTestEnvironment();
  const database = await createTestDatabase();
  const { db } = database;
  const ctx = await createTestUser(db, "user-a");
  const state: {
    tasks: Array<{ id: string; name: string; list: { id: string }; date_updated: string; [key: string]: unknown }>;
    lookup: Array<{ id: string; name: string; list: { id: string }; date_updated: string }>;
    events: unknown[];
    expired: boolean;
    fail: boolean;
    seenCtx: unknown[];
  } = { tasks: [], lookup: [], events: [], expired: false, fail: false, seenCtx: [] };
  const sync = loadModule<typeof import("../src/lib/sync/run")>("src/lib/sync/run.ts", {
    "@/lib/db/client": { db },
    "@/lib/providers/http": { ProviderHttpError },
    "@/lib/clickup/tasks": { listRemoteTasks: async (c: unknown) => {
      state.seenCtx.push(c);
      if (state.fail) throw new Error("snapshot failed");
      return state.tasks;
    }, getRemoteTask: async (_c: unknown, id: string) => [...state.lookup, ...state.tasks].find((task) => task.id === id) ?? null },
    "@/lib/google/calendar": { listRemoteEvents: async (_c: unknown, cursor?: string) => {
      if (state.fail) throw new Error("snapshot failed");
      if (state.expired && cursor) throw new ProviderHttpError("Google Calendar", 410);
      return { items: state.events, nextSyncToken: "fresh" };
    } },
  });
  async function task(id = "task-a", listId = "list-a") {
    await createTestTask(db, id, listId, ["user-a"]);
    return db.clickUpTask.update({ where: { id }, data: { dueDate: new Date("2026-10-16T09:00:00Z") } });
  }
  async function event(id = "event-a", calendarId = "calendar-a", taskId: string | null = null) {
    return db.calendarEvent.create({ data: { userId: "user-a", id, calendarId, clickupTaskId: taskId, title: id,
      startAt: new Date("2026-10-16T09:00:00Z"), endAt: new Date("2026-10-16T10:00:00Z") } });
  }
  return { ...database, ctx, state, sync, task, event };
}

test("Google full refresh after 410 reconciles absent rows only in the selected calendar", async () => {
  const f = await fixture();
  try {
    await f.event(); await f.event("other", "calendar-b");
    await f.db.syncState.create({ data: { userId: "user-a", id: "google:calendar-a", source: "google", cursor: "expired" } });
    f.state.expired = true;
    await f.sync.syncGoogle(f.ctx);
    assert.equal(await f.db.calendarEvent.count({ where: { calendarId: "calendar-a" } }), 0);
    assert.equal(await f.db.calendarEvent.count({ where: { calendarId: "calendar-b" } }), 1);
    assert.equal((await f.db.syncState.findUnique({ where: { userId_id: { userId: "user-a", id: "google:calendar-a" } } }))?.cursor, "fresh");
  } finally { await f.cleanup(); }
});

test("failed remote snapshots do not delete cache or advance the cursor", async () => {
  const f = await fixture();
  try {
    await f.task(); await f.event(); f.state.fail = true;
    await assert.rejects(f.sync.syncGoogle(f.ctx), /snapshot failed/);
    await assert.rejects(f.sync.syncClickUp(f.ctx), /snapshot failed/);
    assert.equal(await f.db.calendarEvent.count(), 1);
    assert.equal(await f.db.clickUpTask.count(), 1);
    assert.equal(await f.db.syncState.count(), 0);
  } finally { await f.cleanup(); }
});

test("a linked event moved remotely becomes pending for ClickUp", async () => {
  const f = await fixture();
  try {
    await f.task(); await f.event("event-a", "calendar-a", "task-a");
    await f.db.taskEventLink.create({ data: { userId: "user-a", clickupTaskId: "task-a", calendarEventId: "event-a", dueSyncedStartAt: new Date("2026-10-16T09:00:00Z") } });
    f.state.events = [{ id: "event-a", start: { dateTime: "2026-10-16T15:00:00Z" }, end: { dateTime: "2026-10-16T16:00:00Z" }, extendedProperties: { private: { source: "planner", clickupTaskId: "task-a" } } }];
    await f.sync.syncGoogle(f.ctx);
    assert.equal((await f.db.taskEventLink.findUnique({ where: { userId_calendarEventId: { userId: "user-a", calendarEventId: "event-a" } } }))?.clickupSyncPending, true);
  } finally { await f.cleanup(); }
});

test("ClickUp complete snapshots remove deleted or moved tasks and their local links", async () => {
  const f = await fixture();
  try {
    await f.task();
    await createTestUser(f.db, "user-b", { listIds: ["list-b"] });
    await createTestTask(f.db, "outside", "list-b", ["user-b"]);
    await createTestTask(f.db, "shared", "list-a", ["user-a", "user-b"]);
    await f.event("event-a", "calendar-a", "task-a");
    await f.db.taskEventLink.create({ data: { userId: "user-a", clickupTaskId: "task-a", calendarEventId: "event-a" } });
    await f.sync.syncClickUp(f.ctx);
    assert.equal(await f.db.clickUpTask.count({ where: { id: "task-a" } }), 0);
    // Another user's task is untouched. A task both users hold only loses this user's membership.
    assert.equal(await f.db.clickUpTask.count({ where: { id: "outside" } }), 1);
    assert.equal(await f.db.clickUpTask.count({ where: { id: "shared" } }), 1);
    assert.deepEqual((await f.db.userTask.findMany({ where: { taskId: "shared" } })).map((row) => row.userId), ["user-b"]);
    assert.equal(await f.db.taskEventLink.count(), 0);
    assert.equal((await f.db.calendarEvent.findUnique({ where: { userId_id: { userId: "user-a", id: "event-a" } } }))?.clickupTaskId, null);
  } finally { await f.cleanup(); }
});

test("a newly configured list is populated even with an existing old cursor", async () => {
  const f = await fixture();
  try {
    f.ctx.listIds = ["list-a", "list-b"];
    await f.db.syncState.create({ data: { userId: "user-a", id: "clickup", source: "clickup", lastSyncAt: new Date() } });
    f.state.tasks = [{ id: "old-in-new-list", name: "Task", list: { id: "list-b" }, date_updated: "1000000000000" }];
    await f.sync.syncClickUp(f.ctx);
    assert.equal(await f.db.clickUpTask.count(), 1);
  } finally { await f.cleanup(); }
});

test("cancelled recurring exceptions survive as tombstones for offline expansion", async () => {
  const f = await fixture();
  try {
    f.state.events = [{ id: "cancelled-instance", status: "cancelled", recurringEventId: "weekly", originalStartTime: { dateTime: "2026-10-16T09:00:00Z" } }];
    await f.sync.syncGoogle(f.ctx);
    const exception = await f.db.calendarEvent.findUnique({ where: { userId_id: { userId: "user-a", id: "cancelled-instance" } } });
    assert.equal((exception?.rawJson as { status: string })?.status, "cancelled");
  } finally { await f.cleanup(); }
});

test("a task missed by moving offset pages is revalidated before deleting its cached links", async () => {
  const f = await fixture();
  try {
    await f.task(); await f.event("event-a", "calendar-a", "task-a");
    await f.db.taskEventLink.create({ data: { userId: "user-a", clickupTaskId: "task-a", calendarEventId: "event-a" } });
    f.state.lookup = [{ id: "task-a", name: "Still present", list: { id: "list-a" }, date_updated: "1000000000000" }];
    await f.sync.syncClickUp(f.ctx);
    assert.equal(await f.db.clickUpTask.count(), 1);
    assert.equal(await f.db.taskEventLink.count(), 1);
    assert.equal((await f.db.calendarEvent.findUnique({ where: { userId_id: { userId: "user-a", id: "event-a" } } }))?.clickupTaskId, "task-a");
  } finally { await f.cleanup(); }
});
