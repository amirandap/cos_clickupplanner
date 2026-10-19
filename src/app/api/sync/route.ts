import { syncClickUp, syncGoogle } from "@/lib/sync/run";
import { syncTaskSchedule } from "@/lib/planner/actions";
import { db } from "@/lib/db/client";
import { assertSameOrigin, apiFailure } from "@/lib/planner/http";
import { getConfiguredCalendarId, taskScopeWhere } from "@/lib/planner/config";
import { withMutationLock } from "@/lib/planner/locking";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    return await withMutationLock("planner", async () => {
      const clickup = await syncClickUp();
      const google = await syncGoogle();
      const [tasks, events] = await Promise.all([
        db.clickUpTask.findMany({
          where: taskScopeWhere(),
          select: { id: true },
        }),
        db.calendarEvent.findMany({ where: { calendarId: getConfiguredCalendarId() }, select: { id: true } }),
      ]);
      const pending = await db.taskEventLink.findMany({ where: {
        clickupSyncPending: true,
        clickupTaskId: { in: tasks.map((task) => task.id) },
        calendarEventId: { in: events.map((event) => event.id) },
      } });
      const errors: string[] = [];
      for (const link of pending) {
        try {
          const result = await syncTaskSchedule(link.clickupTaskId, link.calendarEventId);
          if (result.clickupSyncPending) errors.push(result.warning ?? "ClickUp sigue pendiente de actualizar.");
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "Error al actualizar ClickUp");
        }
      }
      if (errors.length) {
        return Response.json({
          warning: `${errors.length} vínculo(s) siguen pendientes de actualizar en ClickUp. ${errors[0]}`,
          clickup, google, pending: errors.length,
        });
      }
      return Response.json({ clickup, google, pending: 0 });
    });
  } catch (error) { return apiFailure(error); }
}
