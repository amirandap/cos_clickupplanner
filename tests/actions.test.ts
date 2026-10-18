import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase, loadModule } from "./helpers";
import { ProviderHttpError } from "../src/lib/providers/http";
import * as validation from "../src/lib/google/validation";

async function fixture() {
  const { db, cleanup } = await createTestDatabase();
  await db.clickUpTask.createMany({ data: [
    { id: "task-a", title: "A", listId: "list", estimateMin: 30 },
    { id: "task-b", title: "B", listId: "list", estimateMin: 30 },
  ] });
  const calls = { create: 0, due: 0, comment: 0, link: 0 };
  const state = { failDue: false, failCreateAfterRemote: false, remoteRecurring: false, rejectComment: false, remoteTaskId: "" };
  const remoteEvents = new Map<string, Record<string, unknown>>();
  const locking = loadModule<typeof import("../src/lib/planner/locking")>("src/lib/planner/locking.ts", { "@/lib/db/client": { db } });
  const actions = await loadModule<typeof import("../src/lib/planner/actions")>("src/lib/planner/actions.ts", {
    "@/lib/db/client": { db },
    "@/lib/google/validation": validation,
    "@/lib/db/json": { toJson: (value: unknown) => JSON.parse(JSON.stringify(value)) },
    "@/lib/planner/locking": locking,
    "@/lib/planner/config": { appTimezone: () => "UTC", assertTaskInScope: () => undefined, assertCalendarInScope: () => undefined },
    "@/lib/google/calendar": {
      calendarId: () => "primary",
      getRemoteEvent: async (id: string) => {
        const event = await db.calendarEvent.findUniqueOrThrow({ where: { id } });
        return { id, etag: "version-1", ...(state.remoteRecurring ? { recurrence: ["RRULE:FREQ=DAILY"] } : {}),
          start: { dateTime: event.startAt.toISOString() }, end: { dateTime: event.endAt.toISOString() },
          ...(event.rawJson && typeof event.rawJson === "object" ? event.rawJson : {}),
          extendedProperties: { private: { plannerLinkedClickupTaskId: state.remoteTaskId || event.clickupTaskId || "" } } };
      },
      createRemoteEvent: async (taskId: string, title: string, startAt: Date, endAt: Date, id = `random-${calls.create}`) => {
        calls.create++;
        const existing = remoteEvents.get(id);
        if (existing) return existing; // Google POST409 -> GET recovery, provider contract.
        const remote = { id, summary: title, start: { dateTime: startAt.toISOString() }, end: { dateTime: endAt.toISOString() }, extendedProperties: { private: { source: "planner", clickupTaskId: taskId } } };
        remoteEvents.set(id, remote);
        if (state.failCreateAfterRemote) { state.failCreateAfterRemote = false; throw new Error("connection dropped after Google saved"); }
        return remote;
      },
      linkRemoteEvent: async (remote: Record<string, unknown>) => { calls.link++; await new Promise((resolve) => setTimeout(resolve, 20)); return remote; },
      updateRemoteEvent: async () => ({ updated: new Date().toISOString() }),
      deleteRemoteEvent: async () => undefined,
      unlinkRemoteEvent: async (remote: unknown) => remote,
    },
    "@/lib/clickup/tasks": {
      getRemoteTask: async (id: string) => {
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
    return db.calendarEvent.create({ data: { id, calendarId: "primary", title: "Meeting", startAt: new Date("2026-10-17T10:00:00Z"), endAt: new Date("2026-10-17T10:30:00Z"), rawJson: { id, start: { dateTime: "2026-10-17T10:00:00Z" } } } });
  }
  return { db, cleanup, actions, calls, state, remoteEvents, event };
}

test("schedule succeeds partially and retry reuses the saved Google event", async () => {
  const f = await fixture();
  try {
    f.state.failDue = true;
    const first = await f.actions.scheduleTask("task-a", "2026-10-17T10:00:00Z", "operation-0001");
    assert.equal(first.clickupSyncPending, true);
    assert.match(first.warning!, /ClickUp/);
    f.state.failDue = false;
    const second = await f.actions.scheduleTask("task-a", "2026-10-17T10:00:00Z", "operation-0001");
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
    await f.db.calendarEvent.update({ where: { id: "event" }, data: { clickupTaskId: "task-a" } });
    f.state.remoteRecurring = true;
    await assert.rejects(f.actions.removeEvent("event"), /recurrentes/);
    assert.equal(await f.db.calendarEvent.count(), 1);
  } finally { await f.cleanup(); }
});

test("a definitively rejected ClickUp comment can be retried after fixing credentials", async () => {
  const f = await fixture();
  try {
    await f.event();
    await f.db.calendarEvent.update({ where: { id: "event" }, data: { clickupTaskId: "task-a" } });
    await f.db.taskEventLink.create({ data: { clickupTaskId: "task-a", calendarEventId: "event", clickupSyncPending: true } });
    f.state.rejectComment = true;
    assert.equal((await f.actions.syncTaskSchedule("task-a", "event")).clickupSyncPending, true);
    f.state.rejectComment = false;
    assert.equal((await f.actions.syncTaskSchedule("task-a", "event")).clickupSyncPending, false);
    assert.equal(f.calls.comment, 2);
  } finally { await f.cleanup(); }
});

test("a pending stale link never writes a task after Google links the event elsewhere", async () => {
  const f = await fixture();
  try {
    await f.event();
    await f.db.calendarEvent.update({ where: { id: "event" }, data: { clickupTaskId: "task-a" } });
    await f.db.taskEventLink.create({ data: { clickupTaskId: "task-a", calendarEventId: "event", clickupSyncPending: true } });
    f.state.remoteTaskId = "task-b";
    const result = await f.actions.syncTaskSchedule("task-a", "event");
    assert.equal(result.clickupSyncPending, true);
    assert.equal(f.calls.due, 0);
    assert.equal(f.calls.comment, 0);
  } finally { await f.cleanup(); }
});

test("schedule retries a lost Google response using the same deterministic event ID", async () => {
  const f = await fixture();
  try {
    f.state.failCreateAfterRemote = true;
    await assert.rejects(f.actions.scheduleTask("task-a", "2026-10-17T10:00:00Z", "operation-0002"), /connection dropped/);
    const result = await f.actions.scheduleTask("task-a", "2026-10-17T10:00:00Z", "operation-0002");
    assert.ok(result.id);
    assert.equal(f.remoteEvents.size, 1);
    assert.equal(await f.db.calendarEvent.count(), 1);
  } finally { await f.cleanup(); }
});

test("an idempotency key cannot be reused with a different payload", async () => {
  const f = await fixture();
  try {
    await f.actions.scheduleTask("task-a", "2026-10-17T10:00:00Z", "operation-0003");
    await assert.rejects(f.actions.scheduleTask("task-a", "2026-10-17T11:00:00Z", "operation-0003"), (error: unknown) => error instanceof Error && "status" in error && error.status === 409);
    assert.equal(f.calls.create, 1);
  } finally { await f.cleanup(); }
});

test("concurrent links to different tasks cannot assign one event twice", async () => {
  const f = await fixture();
  try {
    await f.event();
    const results = await Promise.allSettled([f.actions.linkTaskToEvent("task-a", "event"), f.actions.linkTaskToEvent("task-b", "event")]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(await f.db.taskEventLink.count({ where: { calendarEventId: "event" } }), 1);
    assert.equal(f.calls.link, 1);
  } finally { await f.cleanup(); }
});

test("concurrent pending retries perform each ClickUp side effect once", async () => {
  const f = await fixture();
  try {
    await f.event();
    await f.db.calendarEvent.update({ where: { id: "event" }, data: { clickupTaskId: "task-a" } });
    await f.db.taskEventLink.create({ data: { clickupTaskId: "task-a", calendarEventId: "event", clickupSyncPending: true } });
    await Promise.all([f.actions.syncTaskSchedule("task-a", "event"), f.actions.syncTaskSchedule("task-a", "event")]);
    assert.equal(f.calls.due, 1);
    assert.equal(f.calls.comment, 1);
  } finally { await f.cleanup(); }
});
