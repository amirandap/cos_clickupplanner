import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { configureTestEnvironment, createTestDatabase, createTestTask, createTestUser, loadModule } from "./helpers";

const environment = { ...process.env };
afterEach(() => { process.env = { ...environment }; });
async function fixture() {
  configureTestEnvironment();
  const database = await createTestDatabase();
  const ctx = await createTestUser(database.db, "user-a");
  const reader = loadModule<typeof import("../src/lib/planner/read")>("src/lib/planner/read.ts", { "@/lib/db/client": { db: database.db } });
  return { ...database, ctx, reader };
}
const range = { startAt: new Date("2026-10-25T00:00:00Z"), endAt: new Date("2026-11-10T00:00:00Z") };

test("planner reads only tasks and events from the configured lists and calendar", async () => {
  const f = await fixture();
  try {
    await createTestTask(f.db, "a", "list-a", ["user-a"]);
    await createTestTask(f.db, "b", "list-b", ["user-a"]);
    for (const calendarId of ["calendar-a", "calendar-b"]) await f.db.calendarEvent.create({ data: {
      userId: "user-a", id: calendarId, calendarId, title: "Event", startAt: range.startAt, endAt: new Date(range.startAt.getTime() + 3600000),
    } });
    const data = await f.reader.readPlanner(f.ctx, range);
    assert.deepEqual(data.tasks.map((task) => task.id), ["a"]);
    assert.deepEqual(data.events.map((event) => event.calendarId), ["calendar-a"]);
    assert.equal(data.events[0].recurring, false);
  } finally { await f.cleanup(); }
});

test("offline recurring events preserve local time across DST regardless of host timezone", async () => {
  const f = await fixture();
  try {
    await f.db.calendarEvent.create({ data: { userId: "user-a", id: "weekly", calendarId: "calendar-a", title: "Weekly",
      startAt: new Date("2026-09-06T13:00:00Z"), endAt: new Date("2026-09-06T14:00:00Z"),
      rawJson: { recurrence: ["RRULE:FREQ=WEEKLY"], start: { dateTime: "2026-09-06T09:00:00-04:00", timeZone: "America/New_York" }, end: { dateTime: "2026-09-06T10:00:00-04:00", timeZone: "America/New_York" } },
    } });
    for (const host of ["UTC", "America/Santo_Domingo", "America/Los_Angeles"]) {
      process.env.TZ = host;
      const data = await f.reader.readPlanner(f.ctx, range);
      assert.deepEqual(data.events.map((event) => event.startAt), ["2026-10-25T13:00:00.000Z", "2026-11-01T14:00:00.000Z", "2026-11-08T14:00:00.000Z"]);
      assert.ok(data.events.every((event) => event.recurring));
    }
  } finally { await f.cleanup(); }
});

test("cancelled and moved instances replace their original occurrence offline", async () => {
  const f = await fixture();
  try {
    const rows = [
      { id: "daily", startAt: "2026-10-25T09:00:00Z", endAt: "2026-10-25T10:00:00Z", rawJson: { recurrence: ["RRULE:FREQ=DAILY;COUNT=3"], start: { dateTime: "2026-10-25T09:00:00Z", timeZone: "UTC" }, end: { dateTime: "2026-10-25T10:00:00Z" } } },
      { id: "cancelled", startAt: "2026-10-26T09:00:00Z", endAt: "2026-10-26T10:00:00Z", rawJson: { recurringEventId: "daily", originalStartTime: { dateTime: "2026-10-26T09:00:00Z" }, status: "cancelled" } },
      { id: "moved", startAt: "2026-10-27T15:00:00Z", endAt: "2026-10-27T16:00:00Z", rawJson: { recurringEventId: "daily", originalStartTime: { dateTime: "2026-10-27T09:00:00Z" } } },
    ];
    for (const row of rows) await f.db.calendarEvent.create({ data: { userId: "user-a", ...row, startAt: new Date(row.startAt), endAt: new Date(row.endAt), calendarId: "calendar-a", title: row.id } });
    const data = await f.reader.readPlanner(f.ctx, range);
    assert.deepEqual(data.events.map((event) => event.startAt), ["2026-10-25T09:00:00.000Z", "2026-10-27T15:00:00.000Z"]);
    assert.ok(data.events.every((event) => event.recurring));
  } finally { await f.cleanup(); }
});

test("all-day recurrence expands date-only ranges and EXDATE correctly", async () => {
  const f = await fixture();
  try {
    await f.db.calendarEvent.create({ data: { userId: "user-a", id: "daily-date", calendarId: "calendar-a", title: "All day",
      startAt: new Date("2026-10-25T00:00:00Z"), endAt: new Date("2026-10-26T00:00:00Z"),
      rawJson: { recurrence: ["RRULE:FREQ=DAILY;COUNT=3", "EXDATE;VALUE=DATE:20261026"], start: { date: "2026-10-25" }, end: { date: "2026-10-26" } },
    } });
    const data = await f.reader.readPlanner(f.ctx, range);
    assert.deepEqual(data.events.map((event) => event.startDate), ["2026-10-25", "2026-10-27"]);
    assert.ok(data.events.every((event) => event.allDay && event.recurring));
  } finally { await f.cleanup(); }
});

test("a series beginning at the second DST offset preserves its explicit first instant", async () => {
  const f = await fixture();
  try {
    await f.db.calendarEvent.create({ data: { userId: "user-a", id: "second-offset", calendarId: "calendar-a", title: "Repeated hour",
      startAt: new Date("2026-11-01T06:30:00Z"), endAt: new Date("2026-11-01T07:30:00Z"),
      rawJson: { recurrence: ["RRULE:FREQ=WEEKLY;COUNT=1"], start: { dateTime: "2026-11-01T01:30:00-05:00", timeZone: "America/New_York" } },
    } });
    assert.equal((await f.reader.readPlanner(f.ctx, range)).events[0].startAt, "2026-11-01T06:30:00.000Z");
  } finally { await f.cleanup(); }
});

test("dense subhourly expansion is rejected before scanning years of occurrences", async () => {
  const f = await fixture();
  try {
    await f.db.calendarEvent.create({ data: { userId: "user-a", id: "dense", calendarId: "calendar-a", title: "Dense recurrence",
      startAt: new Date("2020-01-01T00:00:00Z"), endAt: new Date("2020-01-01T01:00:00Z"),
      rawJson: { recurrence: ["RRULE:FREQ=HOURLY;BYMINUTE=0,1;BYSECOND=0,1"], start: { dateTime: "2020-01-01T00:00:00Z", timeZone: "UTC" } },
    } });
    await assert.rejects(f.reader.readPlanner(f.ctx, range), (error: unknown) => error instanceof Error && "status" in error && error.status === 422);
  } finally { await f.cleanup(); }
});

test("nonexistent spring-gap occurrences do not consume COUNT", async () => {
  const f = await fixture();
  try {
    await f.db.calendarEvent.create({ data: { userId: "user-a", id: "spring-gap", calendarId: "calendar-a", title: "Early meeting",
      startAt: new Date("2026-03-07T07:30:00Z"), endAt: new Date("2026-03-07T08:30:00Z"),
      rawJson: { recurrence: ["RRULE:FREQ=DAILY;COUNT=3"], start: { dateTime: "2026-03-07T02:30:00-05:00", timeZone: "America/New_York" } },
    } });
    const data = await f.reader.readPlanner(f.ctx, { startAt: new Date("2026-03-07T00:00:00Z"), endAt: new Date("2026-03-12T00:00:00Z") });
    assert.deepEqual(data.events.map((event) => event.startAt), ["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z", "2026-03-10T06:30:00.000Z"]);
  } finally { await f.cleanup(); }
});
