import { syncClickUp, syncGoogle } from "@/lib/sync/run";
import { syncTaskSchedule } from "@/lib/planner/actions";
import { db } from "@/lib/db/client";
import { apiFailure } from "@/lib/planner/http";
import { authorize } from "@/lib/planner/request";
import { lockKey, userTaskWhere } from "@/lib/planner/config";
import { withMutationLock } from "@/lib/planner/locking";
import { enforceRateLimit } from "@/lib/ratelimit";
import { connectionStates } from "@/lib/auth/credentials";

export const runtime = "nodejs";

const SYNC_LIMIT = 10;
const SYNC_WINDOW_MS = 60_000;

export async function POST(request: Request) {
  try {
    const { ctx } = await authorize(request, { mutation: true });
    await enforceRateLimit(`sync:${ctx.userId}`, SYNC_LIMIT, SYNC_WINDOW_MS);
    return await withMutationLock(lockKey(ctx), async () => {
      const connections = ctx.mock ? { clickup: "connected", googleCalendar: "connected" } : await connectionStates(ctx.userId);
      const skipped: string[] = [];
      let clickup = 0;
      let google = 0;
      if (connections.clickup === "connected") clickup = await syncClickUp(ctx);
      else skipped.push(connections.clickup === "revoked" ? "El token de ClickUp ya no es válido: pégalo de nuevo en Ajustes." : "Pega tu token de ClickUp en Ajustes para sincronizar tareas.");
      if (connections.googleCalendar === "connected") google = await syncGoogle(ctx);
      else skipped.push(connections.googleCalendar === "revoked" ? "Google Calendar se desconectó: vuelve a conectarlo en Ajustes." : "Conecta Google Calendar en Ajustes para sincronizar tu calendario.");
      const [tasks, events] = await Promise.all([
        db.clickUpTask.findMany({ where: userTaskWhere(ctx), select: { id: true } }),
        db.calendarEvent.findMany({ where: { userId: ctx.userId, calendarId: ctx.calendarId }, select: { id: true } }),
      ]);
      const pending = await db.taskEventLink.findMany({ where: {
        userId: ctx.userId,
        clickupSyncPending: true,
        clickupTaskId: { in: tasks.map((task) => task.id) },
        calendarEventId: { in: events.map((event) => event.id) },
      } });
      const errors: string[] = [];
      for (const link of pending) {
        try {
          const result = await syncTaskSchedule(ctx, link.clickupTaskId, link.calendarEventId);
          if (result.clickupSyncPending) errors.push(result.warning ?? "ClickUp sigue pendiente de actualizar.");
        } catch (error) {
          errors.push(error instanceof Error ? error.message : "Error al actualizar ClickUp");
        }
      }
      const warnings = [...skipped];
      if (errors.length) warnings.push(`${errors.length} vínculo(s) siguen pendientes de actualizar en ClickUp. ${errors[0]}`);
      return Response.json({ clickup, google, pending: errors.length, ...(warnings.length ? { warning: warnings.join(" ") } : {}) });
    });
  } catch (error) { return apiFailure(error); }
}
