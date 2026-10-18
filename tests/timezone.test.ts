import assert from "node:assert/strict";
import test from "node:test";
import { allDayStart, formatDateTimeInput, parseDateTimeInput } from "../src/components/planner/dates";

test("a UTC calendar keeps 09:00 at 09:00 UTC", () => {
  assert.equal(parseDateTimeInput("2026-10-16T09:00", "UTC")?.toISOString(), "2026-10-16T09:00:00.000Z");
});

test("datetime-local round trips through the configured IANA timezone", () => {
  const instant = new Date("2026-10-16T13:00:00.000Z");
  assert.equal(formatDateTimeInput(instant, "America/Santo_Domingo"), "2026-10-16T09:00");
  assert.equal(parseDateTimeInput("2026-10-16T09:00", "America/Santo_Domingo")?.toISOString(), instant.toISOString());
});

test("all-day scheduling uses 09:00 in the calendar timezone", () => {
  assert.equal(allDayStart("2026-01-16", "Asia/Tokyo")?.toISOString(), "2026-01-16T00:00:00.000Z");
  assert.equal(allDayStart("2026-10-16", "UTC")?.toISOString(), "2026-10-16T09:00:00.000Z");
});

test("invalid dates and unknown timezones are rejected without throwing", () => {
  for (const value of ["", "2026-02-30T09:00", "not-a-date", "2026-10-16T25:00"]) {
    assert.equal(parseDateTimeInput(value, "UTC"), null);
  }
  assert.equal(parseDateTimeInput("2026-10-16T09:00", "Invalid/Timezone"), null);
  assert.equal(allDayStart("2026-02-30", "UTC"), null);
});

test("nonexistent wall-clock times at the DST jump are rejected", () => {
  assert.equal(parseDateTimeInput("2026-03-08T02:30", "America/New_York"), null);
  assert.equal(parseDateTimeInput("2026-03-08T03:30", "America/New_York")?.toISOString(), "2026-03-08T07:30:00.000Z");
});

test("both offsets of a repeated DST hour preserve an unchanged event instant", () => {
  for (const instant of ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]) {
    const original = new Date(instant);
    const input = formatDateTimeInput(original, "America/New_York");
    assert.equal(input, "2026-11-01T01:30");
    assert.equal(parseDateTimeInput(input, "America/New_York", original)?.toISOString(), instant);
  }
});

test("a changed input with two possible DST offsets is rejected", () => {
  assert.equal(parseDateTimeInput("2026-11-01T01:30", "America/New_York"), null);
  assert.equal(parseDateTimeInput("2026-11-01T01:30", "America/New_York", new Date("2026-11-01T07:30:00.000Z")), null);
});
