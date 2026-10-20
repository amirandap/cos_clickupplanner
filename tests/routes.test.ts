import assert from "node:assert/strict";
import test from "node:test";
import { createTestDatabase, loadModule } from "./helpers";
import * as http from "../src/lib/planner/http";

test("sync reports pending ClickUp results as partial success instead of pending zero", async () => {
  const f = await createTestDatabase();
  try {
    await f.db.clickUpTask.create({ data: { id: "task", listId: "configured-list", title: "Task" } });
    await f.db.calendarEvent.create({ data: { id: "event", calendarId: "configured-calendar", title: "Event", startAt: new Date(), endAt: new Date(Date.now() + 3600000) } });
    await f.db.taskEventLink.create({ data: { clickupTaskId: "task", calendarEventId: "event", clickupSyncPending: true } });
    const locking = loadModule<typeof import("../src/lib/planner/locking")>("src/lib/planner/locking.ts", { "@/lib/db/client": { db: f.db } });
    const route = loadModule<typeof import("../src/app/api/sync/route")>("src/app/api/sync/route.ts", {
      "@/lib/db/client": { db: f.db }, "@/lib/planner/http": http,
      "@/lib/sync/run": { syncClickUp: async () => 2, syncGoogle: async () => 3 },
      "@/lib/planner/actions": { syncTaskSchedule: async () => ({ clickupSyncPending: true, warning: "ClickUp pendiente" }) },
      "@/lib/planner/config": { getConfiguredListIds: () => ["configured-list"], getConfiguredCalendarId: () => "configured-calendar", taskScopeWhere: () => ({ listId: { in: ["configured-list"] } }) },
      "@/lib/planner/locking": locking,
    });
    const response = await route.POST(new Request("https://planner.test/api/sync", { method: "POST" }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.pending, 1);
    assert.match(result.warning, /ClickUp pendiente/);
  } finally { await f.cleanup(); }
});
