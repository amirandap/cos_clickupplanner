import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createTestDatabase, loadModule } from "./helpers";
import * as config from "../src/lib/planner/config";
import { ProviderHttpError } from "../src/lib/providers/http";
import * as validation from "../src/lib/google/validation";

const environment = { ...process.env };
afterEach(() => { process.env = { ...environment }; });

async function fixture() {
  process.env.USE_MOCK_DATA = "false";
  process.env.CLICKUP_LIST_IDS = "list-a";
  process.env.GOOGLE_CALENDAR_ID = "calendar-a";
  const database = await createTestDatabase();
  const { db } = database;
  const state: {
    tasks: Array<{ id: string; name: string; list: { id: string }; date_updated: string }>;
    lookup: Array<{ id: string; name: string; list: { id: string }; date_updated: string }>;
    events: unknown[];
    expired: boolean;
    fail: boolean;
  } = { tasks: [], lookup: [], events: [], expired: false, fail: false };
  const locking = loadModule<typeof import("../src/lib/planner/locking")>("src/lib/planner/locking.ts", { "@/lib/db/client": { db } });
  const sync = loadModule<typeof import("../src/lib/sync/run")>("src/lib/sync/run.ts", {
    "@/lib/db/client": { db },
    "@/lib/db/json": { toJson: (value: unknown) => JSON.parse(JSON.stringify(value)) },
    "@/lib/planner/config": config,
    "@/lib/planner/locking": locking,
    "@/lib/providers/http": { ProviderHttpError },
    "@/lib/google/validation": validation,
    "@/lib/clickup/tasks": { listRemoteTasks: async () => {
      if (state.fail) throw new Error("snapshot failed");
      return state.tasks;
    }, getRemoteTask: async (id: string) => [...state.lookup, ...state.tasks].find((task) => task.id === id) ?? null },
    "@/lib/google/calendar": { calendarId: config.getConfiguredCalendarId, listRemoteEvents: async (cursor?: string) => {
      if (state.fail) throw new Error("snapshot failed");
      if (state.expired && cursor) throw new ProviderHttpError("Google Calendar", 410);
      return { items: state.events, nextSyncToken: "fresh" };
    } },
  });
  async function task(id = "task-a", listId = "list-a") {
    return db.clickUpTask.create({ data: { id, listId, title: id, dueDate: new Date("2026-10-16T09:00:00Z") } });
  }
  async function event(id = "event-a", calendarId = "calendar-a", taskId: string | null = null) {
    return db.calendarEvent.create({ data: { id, calendarId, clickupTaskId: taskId, title: id,
      startAt: new Date("2026-10-16T09:00:00Z"), endAt: new Date("2026-10-16T10:00:00Z") } });
  }
  return { ...database, state, sync, task, event };
}

test("Google full refresh after 410 reconciles absent rows only in the selected calendar", async () => {
  const f = await fixture();
  try {
    await f.event(); await f.event("other", "calendar-b");
    await f.db.syncState.create({ data: { id: "google:calendar-a", source: "google", cursor: "expired" } });
    f.state.expired = true;
    await f.sync.syncGoogle();
    assert.equal(await f.db.calendarEvent.count({ where: { calendarId: "calendar-a" } }), 0);
    assert.equal(await f.db.calendarEvent.count({ where: { calendarId: "calendar-b" } }), 1);
    assert.equal((await f.db.syncState.findUnique({ where: { id: "google:calendar-a" } }))?.cursor, "fresh");
  } finally { await f.cleanup(); }
});

test("failed remote snapshots do not delete cache or advance the cursor", async () => {
  const f = await fixture();
  try {
    await f.task(); await f.event(); f.state.fail = true;
    await assert.rejects(f.sync.syncGoogle(), /snapshot failed/);
    await assert.rejects(f.sync.syncClickUp(), /snapshot failed/);
    assert.equal(await f.db.calendarEvent.count(), 1);
    assert.equal(await f.db.clickUpTask.count(), 1);
    assert.equal(await f.db.syncState.count(), 0);
  } finally { await f.cleanup(); }
});

test("a linked event moved remotely becomes pending for ClickUp", async () => {
  const f = await fixture();
  try {
    await f.task(); await f.event("event-a", "calendar-a", "task-a");
    await f.db.taskEventLink.create({ data: { clickupTaskId: "task-a", calendarEventId: "event-a", dueSyncedStartAt: new Date("2026-10-16T09:00:00Z") } });
    f.state.events = [{ id: "event-a", start: { dateTime: "2026-10-16T15:00:00Z" }, end: { dateTime: "2026-10-16T16:00:00Z" }, extendedProperties: { private: { source: "planner", clickupTaskId: "task-a" } } }];
    await f.sync.syncGoogle();
    assert.equal((await f.db.taskEventLink.findUnique({ where: { calendarEventId: "event-a" } }))?.clickupSyncPending, true);
  } finally { await f.cleanup(); }
});

test("ClickUp complete snapshots remove deleted or moved tasks and their local links", async () => {
  const f = await fixture();
  try {
    await f.task(); await f.task("outside", "list-b");
    await f.event("event-a", "calendar-a", "task-a");
    await f.db.taskEventLink.create({ data: { clickupTaskId: "task-a", calendarEventId: "event-a" } });
    await f.sync.syncClickUp();
    assert.equal(await f.db.clickUpTask.count({ where: { id: "task-a" } }), 0);
    assert.equal(await f.db.clickUpTask.count({ where: { id: "outside" } }), 1);
    assert.equal(await f.db.taskEventLink.count(), 0);
    assert.equal((await f.db.calendarEvent.findUnique({ where: { id: "event-a" } }))?.clickupTaskId, null);
  } finally { await f.cleanup(); }
});

test("a newly configured list is populated even with an existing old cursor", async () => {
  const f = await fixture();
  try {
    process.env.CLICKUP_LIST_IDS = "list-a,list-b";
    await f.db.syncState.create({ data: { id: "clickup", source: "clickup", lastSyncAt: new Date() } });
    f.state.tasks = [{ id: "old-in-new-list", name: "Task", list: { id: "list-b" }, date_updated: "1000000000000" }];
    await f.sync.syncClickUp();
    assert.equal(await f.db.clickUpTask.count(), 1);
  } finally { await f.cleanup(); }
});

test("cancelled recurring exceptions survive as tombstones for offline expansion", async () => {
  const f = await fixture();
  try {
    f.state.events = [{ id: "cancelled-instance", status: "cancelled", recurringEventId: "weekly", originalStartTime: { dateTime: "2026-10-16T09:00:00Z" } }];
    await f.sync.syncGoogle();
    const exception = await f.db.calendarEvent.findUnique({ where: { id: "cancelled-instance" } });
    assert.equal((exception?.rawJson as { status: string })?.status, "cancelled");
  } finally { await f.cleanup(); }
});

test("a task missed by moving offset pages is revalidated before deleting its cached links", async () => {
  const f = await fixture();
  try {
    await f.task(); await f.event("event-a", "calendar-a", "task-a");
    await f.db.taskEventLink.create({ data: { clickupTaskId: "task-a", calendarEventId: "event-a" } });
    f.state.lookup = [{ id: "task-a", name: "Still present", list: { id: "list-a" }, date_updated: "1000000000000" }];
    await f.sync.syncClickUp();
    assert.equal(await f.db.clickUpTask.count(), 1);
    assert.equal(await f.db.taskEventLink.count(), 1);
    assert.equal((await f.db.calendarEvent.findUnique({ where: { id: "event-a" } }))?.clickupTaskId, "task-a");
  } finally { await f.cleanup(); }
});

test("removing cancelled events reads the calendar cache once, not once per cancelled event", async () => {
  const f = await fixture();
  try {
    await f.event("series"); await f.event("solo-1"); await f.event("solo-2"); await f.event("keep");
    await f.db.syncState.create({ data: { id: "google:calendar-a", source: "google", cursor: "saved" } }); // sync incremental, no snapshot completo
    for (const id of ["child-1", "child-2"]) {
      await f.db.calendarEvent.create({ data: { id, calendarId: "calendar-a", title: id, startAt: new Date("2026-10-17T09:00:00Z"),
        endAt: new Date("2026-10-17T10:00:00Z"), rawJson: { recurringEventId: "series" } } });
    }
    const original = f.db.$transaction.bind(f.db) as unknown as (run: (tx: typeof f.db) => Promise<unknown>, options?: unknown) => Promise<unknown>;
    let cacheScans = 0;
    (f.db as unknown as { $transaction: unknown }).$transaction = (run: (tx: typeof f.db) => Promise<unknown>, options?: unknown) => original((tx) => run(new Proxy(tx, {
      get: (target, key) => key !== "calendarEvent" ? Reflect.get(target, key) : new Proxy(target.calendarEvent, {
        get: (model, method) => method !== "findMany" ? Reflect.get(model, method) : (...args: unknown[]) => { cacheScans++; return (model.findMany as (...a: unknown[]) => unknown)(...args); },
      }),
    })), options);
    f.state.events = ["series", "solo-1", "solo-2"].map((id) => ({ id, status: "cancelled" }));
    await f.sync.syncGoogle();
    const left = (await f.db.calendarEvent.findMany({ select: { id: true } })).map((row) => row.id).sort();
    assert.deepEqual(left, ["keep"]);
    assert.ok(cacheScans <= 1, `la caché se leyó ${cacheScans} veces`);
  } finally { await f.cleanup(); }
});
