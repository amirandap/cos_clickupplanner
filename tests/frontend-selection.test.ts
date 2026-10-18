import assert from "node:assert/strict";
import test from "node:test";
import type { PlannerEvent } from "../src/lib/planner/types";
import { linkableEvents, taskSelectionIntent } from "../src/components/planner/selection";

const event: PlannerEvent = {
  id: "event-1", calendarId: "calendar-1", title: "Reunión", startAt: "2026-10-16T09:00:00.000Z",
  endAt: "2026-10-16T10:00:00.000Z", allDay: false, startDate: null, endDate: null,
  clickupTaskId: null, plannerOwned: false, recurring: false,
};

test("keyboard scheduling converts the chosen wall time in the calendar timezone", () => {
  assert.deepEqual(taskSelectionIntent("task-1", "2026-10-16T09:00", "America/Santo_Domingo", "", []), {
    kind: "schedule", taskId: "task-1", startAt: "2026-10-16T13:00:00.000Z",
  });
  assert.throws(() => taskSelectionIntent("task-1", "2026-03-08T02:30", "America/New_York", "", []), /hora válida/);
});

test("link choices exclude recurrence, all-day events and blocks assigned to another task", () => {
  const events = [event, { ...event, id: "recurring", recurring: true }, { ...event, id: "all-day", allDay: true },
    { ...event, id: "other-task", clickupTaskId: "task-2" }, { ...event, id: "same-task", clickupTaskId: "task-1" }];
  assert.deepEqual(linkableEvents(events, "task-1").map((item) => item.id), ["event-1", "same-task"]);
});

test("keyboard linking selects an eligible event without requiring a new datetime", () => {
  assert.deepEqual(taskSelectionIntent("task-1", "", "UTC", "event-1", [event]), {
    kind: "link", taskId: "task-1", id: "event-1",
  });
});

test("a changed or removed event is rechecked before a link request is built", () => {
  assert.throws(() => taskSelectionIntent("task-1", "", "UTC", "missing", [event]), /disponible/);
  assert.throws(() => taskSelectionIntent("task-1", "", "UTC", "event-1", [{ ...event, clickupTaskId: "task-2" }]), /disponible/);
});
