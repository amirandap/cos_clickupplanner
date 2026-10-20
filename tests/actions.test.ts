import assert from "node:assert/strict";
import test from "node:test";
import { configureTestEnvironment, createTestDatabase, createTestTask, createTestUser, loadModule } from "./helpers";
import { ProviderHttpError } from "../src/lib/providers/http";

async function fixture() {
  configureTestEnvironment();
  const { db, cleanup } = await createTestDatabase();
  const ctx = await createTestUser(db, "user-a", { calendarId: "primary", listIds: ["list"] });
  await createTestTask(db, "task-a", "list", ["user-a"]);
  await createTestTask(db, "task-b", "list", ["user-a"]);
  await db.clickUpTask.updateMany({ data: { estimateMin: 30 } });
  const calls = { create: 0, due: 0, comment: 0, link: 0 };
  const state = { failDue: false, failCreateAfterRemote: false, remoteRecurring: false, rejectComment: false, remoteTaskId: "" };
  const remoteEvents = new Map<string, Record<string, unknown>>();
  const actions = loadModule<typeof import("../src/lib/planner/actions")>("src/lib/planner/actions.ts", {
    "@/lib/db/client": { db },
    "@/lib/sync/run": { syncClickUp: async () => undefined },
    "@/lib/google/calendar": {
      getRemoteEvent: async (_c: unknown, id: string) => {
        const event = await db.calendarEvent.findUniqueOrThrow({ where: { userId_id: { userId: "user-a", id } } });
        return { id, etag: "version-1", ...(state.remoteRecurring ? { recurrence: ["RRULE:FREQ=DAILY"] } : {}),
          start: { dateTime: event.startAt.toISOString() }, end: { dateTime: event.endAt.toISOString() },
          ...(event.rawJson && typeof event.rawJson === "object" ? event.rawJson : {}),
          extendedProperties: { private: { plannerLinkedClickupTaskId: state.remoteTaskId || event.clickupTaskId || "" } } };
      },
      createRemoteEvent: async (_c: unknown, taskId: string, title: string, startAt: Date, endAt: Date, id = `random-${calls.create}`) => {
        calls.create++;
        const existing = remoteEvents.get(id);
        if (existing) return existing; // Google POST409 -> GET recovery, provider contract.
        const remote = { id, summary: title, start: { dateTime: startAt.toISOString() }, end: { dateTime: endAt.toISOString() }, extendedProperties: { private: { source: "planner", clickupTaskId: taskId } } };
        remoteEvents.set(id, remote);
        if (state.failCreateAfterRemote) { state.failCreateAfterRemote = false; throw new Error("connection dropped after Google saved"); }
        return remote;
      },
      linkRemoteEvent: async (_c: unknown, remote: Record<string, unknown>) => { calls.link++; await new Promise((resolve) => setTimeout(resolve, 20)); return remote; },
      updateRemoteEvent: async () => ({ updated: new Date().toISOString() }),
      renameRemoteEvent: async (_c: unknown, _id: string, _calendar: string, title: string) => ({ summary: title, updated: new Date().toISOString() }),
      deleteRemoteEvent: async () => undefined,
      unlinkRemoteEvent: async (_c: unknown, remote: unknown) => remote,
    },
    "@/lib/clickup/tasks": {
      getRemoteTask: async (_c: unknown, id: string) => {
        const task = await db.clickUpTask.findUnique({ where: { id } });
        return task ? { id, name: task.title, list: { id: task.listId } } : null;
      },
      updateRemoteTaskDueDate: async () => { calls.due++; await new Promise((resolve) => setTimeout(resolve, 10)); if (state.failDue) throw new Error("ClickUp unavailable"); return {}; },
      createRemoteTaskComment: async () => {
        calls.comment++;
        if (state.rejectComment) throw new ProviderHttpError("ClickUp", 401);
        return { id: "comment" };
      },
      completeRemoteTask: async () => ({ status: { status: "closed" } }),
      getClosedStatus: async () => "closed",
    },
  });
  async function event(id = "event") {
    return db.calendarEvent.create({ data: { userId: "user-a", id, calendarId: "primary", title: "Meeting", startAt: new Date("2026-10-17T10:00:00Z"), endAt: new Date("2026-10-17T10:30:00Z"), rawJson: { id, start: { dateTime: "2026-10-17T10:00:00Z" } } } });
  }
  return { db, ctx, cleanup, actions, calls, state, remoteEvents, event };
}

test("schedule succeeds partially and retry reuses the saved Google event", async () => {
  const f = await fixture();
  try {
    f.state.failDue = true;
    const first = await f.actions.scheduleTask(f.ctx, "task-a", "2026-10-17T10:00:00Z", "operation-0001");
    assert.equal(first.clickupSyncPending, true);
    assert.match(first.warning!, /ClickUp/);
    f.state.failDue = false;
    const second = await f.actions.scheduleTask(f.ctx, "task-a", "2026-10-17T10:00:00Z", "operation-0001");
    assert.equal(first.id, second.id);
    assert.equal(second.clickupSyncPending, false);
    assert.equal(second.reused, true);
    assert.equal(f.calls.create, 1);
    assert.equal(await f.db.calendarEvent.count(), 1);
  } finally { await f.cleanup(); }
});

test("an event converted remotely to a recurring series cannot be deleted from stale cache", async () => {
  const f = await fixture();
  try {
    await f.event();
    await f.db.calendarEvent.update({ where: { userId_id: { userId: "user-a", id: "event" } }, data: { clickupTaskId: "task-a" } });
    f.state.remoteRecurring = true;
    await assert.rejects(f.actions.removeEvent(f.ctx, "event"), /recurrentes/);
    assert.equal(await f.db.calendarEvent.count(), 1);
  } finally { await f.cleanup(); }
});

test("a definitively rejected ClickUp comment can be retried after fixing credentials", async () => {
  const f = await fixture();
  try {
    await f.event();
    await f.db.calendarEvent.update({ where: { userId_id: { userId: "user-a", id: "event" } }, data: { clickupTaskId: "task-a" } });
    await f.db.taskEventLink.create({ data: { userId: "user-a", clickupTaskId: "task-a", calendarEventId: "event", clickupSyncPending: true } });
    f.state.rejectComment = true;
    assert.equal((await f.actions.syncTaskSchedule(f.ctx, "task-a", "event")).clickupSyncPending, true);
    f.state.rejectComment = false;
    assert.equal((await f.actions.syncTaskSchedule(f.ctx, "task-a", "event")).clickupSyncPending, false);
    assert.equal(f.calls.comment, 2);
  } finally { await f.cleanup(); }
});

test("a pending stale link never writes a task after Google links the event elsewhere", async () => {
  const f = await fixture();
  try {
    await f.event();
    await f.db.calendarEvent.update({ where: { userId_id: { userId: "user-a", id: "event" } }, data: { clickupTaskId: "task-a" } });
    await f.db.taskEventLink.create({ data: { userId: "user-a", clickupTaskId: "task-a", calendarEventId: "event", clickupSyncPending: true } });
    f.state.remoteTaskId = "task-b";
    const result = await f.actions.syncTaskSchedule(f.ctx, "task-a", "event");
    assert.equal(result.clickupSyncPending, true);
    assert.equal(f.calls.due, 0);
    assert.equal(f.calls.comment, 0);
  } finally { await f.cleanup(); }
});

test("schedule retries a lost Google response using the same deterministic event ID", async () => {
  const f = await fixture();
  try {
    f.state.failCreateAfterRemote = true;
    await assert.rejects(f.actions.scheduleTask(f.ctx, "task-a", "2026-10-17T10:00:00Z", "operation-0002"), /connection dropped/);
    const result = await f.actions.scheduleTask(f.ctx, "task-a", "2026-10-17T10:00:00Z", "operation-0002");
    assert.ok(result.id);
    assert.equal(f.remoteEvents.size, 1);
    assert.equal(await f.db.calendarEvent.count(), 1);
  } finally { await f.cleanup(); }
});

test("an idempotency key cannot be reused with a different payload", async () => {
  const f = await fixture();
  try {
    await f.actions.scheduleTask(f.ctx, "task-a", "2026-10-17T10:00:00Z", "operation-0003");
    await assert.rejects(f.actions.scheduleTask(f.ctx, "task-a", "2026-10-17T11:00:00Z", "operation-0003"), (error: unknown) => error instanceof Error && "status" in error && error.status === 409);
    assert.equal(f.calls.create, 1);
  } finally { await f.cleanup(); }
});

test("linking a task to an already assigned event replaces the previous task", async () => {
  const f = await fixture();
  try {
    await f.event();
    await f.actions.linkTaskToEvent(f.ctx, "task-a", "event");
    await f.actions.linkTaskToEvent(f.ctx, "task-b", "event");
    assert.equal(await f.db.taskEventLink.count({ where: { calendarEventId: "event" } }), 1);
    assert.equal((await f.db.taskEventLink.findFirst({ where: { calendarEventId: "event" } }))?.clickupTaskId, "task-b");
    assert.equal((await f.db.calendarEvent.findUnique({ where: { userId_id: { userId: "user-a", id: "event" } } }))?.clickupTaskId, "task-b");
  } finally { await f.cleanup(); }
});

test("concurrent pending retries perform each ClickUp side effect once", async () => {
  const f = await fixture();
  try {
    await f.event();
    await f.db.calendarEvent.update({ where: { userId_id: { userId: "user-a", id: "event" } }, data: { clickupTaskId: "task-a" } });
    await f.db.taskEventLink.create({ data: { userId: "user-a", clickupTaskId: "task-a", calendarEventId: "event", clickupSyncPending: true } });
    await Promise.all([f.actions.syncTaskSchedule(f.ctx, "task-a", "event"), f.actions.syncTaskSchedule(f.ctx, "task-a", "event")]);
    assert.equal(f.calls.due, 1);
    assert.equal(f.calls.comment, 1);
  } finally { await f.cleanup(); }
});

test("renaming an event updates the stored title", async () => {
  const f = await fixture();
  try {
    await f.event();
    await f.actions.linkTaskToEvent(f.ctx, "task-a", "event");
    await f.actions.renameEvent(f.ctx, "event", "  Nuevo título ");
    assert.equal((await f.db.calendarEvent.findUnique({ where: { userId_id: { userId: "user-a", id: "event" } } }))?.title, "Nuevo título");
    await assert.rejects(() => f.actions.renameEvent(f.ctx, "event", "   "));
  } finally { await f.cleanup(); }
});

test("deleting an event removes it and its link", async () => {
  const f = await fixture();
  try {
    await f.event();
    await f.actions.linkTaskToEvent(f.ctx, "task-a", "event");
    await f.actions.deleteEvent(f.ctx, "event");
    assert.equal(await f.db.calendarEvent.count({ where: { userId: "user-a", id: "event" } }), 0);
  } finally { await f.cleanup(); }
});
