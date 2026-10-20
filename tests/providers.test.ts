import assert from "node:assert/strict";
import { test } from "node:test";
import { loadModule } from "./helpers";
import * as credentials from "../src/lib/sync/credentials";

const ctx = { userId: "user-a", calendarId: "primary", listIds: ["list-a"], timezone: "UTC", clickupUserId: null, mock: false };
const credentialsStore = {
  getCredential: async () => ({ accessToken: "test-token", refreshToken: null, expiresAt: new Date(Date.now() + 3600000), scheme: "raw", scopes: null, revokedAt: null }),
  markRevoked: async () => undefined, saveCredential: async () => undefined,
};
function google() {
  return loadModule<typeof import("../src/lib/google/calendar")>("src/lib/google/calendar.ts", {
    "@/lib/auth/credentials": credentialsStore, "@/lib/sync/credentials": credentials,
  });
}
function clickup() {
  return loadModule<typeof import("../src/lib/clickup/tasks")>("src/lib/clickup/tasks.ts", { "@/lib/auth/credentials": credentialsStore });
}
const validEvent = { id: "abcde", start: { dateTime: "2026-10-16T10:00:00Z" }, end: { dateTime: "2026-10-16T11:00:00Z" } };

test("Google rejects malformed events instead of returning a cursor that skips them", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ items: [{ id: "broken", start: { date: "2026-02-30" }, end: { date: "2026-03-01" } }], nextSyncToken: "skip" }));
  await assert.rejects(google().listRemoteEvents(ctx), /Google.*(fecha|inválid|invalid)/i);
});

test("Google incremental listing leaves recurrence masters unexpanded and keeps paging parameters", async (t) => {
  const urls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    urls.push(new URL(String(input)));
    return Response.json(urls.length === 1 ? { items: [validEvent], nextPageToken: "page-two" } : { items: [], nextSyncToken: "new-token" });
  });
  const result = await google().listRemoteEvents(ctx, "old-token");
  assert.equal(result.nextSyncToken, "new-token");
  assert.equal(urls[0].searchParams.get("singleEvents"), "false");
  assert.equal(urls[1].searchParams.get("syncToken"), "old-token");
  assert.equal(urls[1].searchParams.get("pageToken"), "page-two");
});

test("Google create resolves an existing deterministic ID only when task and schedule match", async (t) => {
  const calls: string[] = [];
  const event = { ...validEvent, extendedProperties: { private: { source: "planner", clickupTaskId: "task-a" } } };
  t.mock.method(globalThis, "fetch", async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push(init?.method ?? "GET");
    return calls.length === 1 ? new Response(null, { status: 409 }) : Response.json(event);
  });
  const result = await google().createRemoteEvent(ctx, "task-a", "Task", new Date("2026-10-16T10:00:00Z"), new Date("2026-10-16T11:00:00Z"), "abcde");
  assert.equal(result.id, "abcde");
  assert.deepEqual(calls, ["POST", "GET"]);
});

test("Google deterministic ID conflict rejects another task", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1 ? new Response(null, { status: 409 }) : Response.json({ ...validEvent, extendedProperties: { private: { source: "planner", clickupTaskId: "other" } } }));
  await assert.rejects(google().createRemoteEvent(ctx, "task-a", "Task", new Date("2026-10-16T10:00:00Z"), new Date("2026-10-16T11:00:00Z"), "abcde"), /conflict|coincid/i);
});

test("ClickUp refuses malformed task pages before advancing to another page", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ tasks: [{ id: "task-a", name: "Task", due_date: "not-a-date", list: { id: "list-a" } }] }));
  await assert.rejects(clickup().listRemoteTasks(ctx), /ClickUp.*(fecha|inválid|invalid)/i);
});

test("ClickUp full snapshot does not use a global delta cursor for newly configured lists", async (t) => {
  const urls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => { urls.push(new URL(String(input))); return Response.json({ tasks: [] }); });
  await clickup().listRemoteTasks(ctx);
  assert.equal(urls[0].searchParams.has("date_updated_gt"), false);
  assert.equal(urls[0].searchParams.get("subtasks"), "true");
});

test("unsafe ClickUp comment POST is not retried after an ambiguous network failure", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; throw new TypeError("connection lost"); });
  await assert.rejects(clickup().createRemoteTaskComment(ctx, "task-a", "Comment"));
  assert.equal(calls, 1);
});
