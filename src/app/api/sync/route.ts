import { syncClickUp, syncGoogle } from "@/lib/sync/run";
import { syncTaskSchedule } from "@/lib/planner/actions";
import { db } from "@/lib/db/client";
import { assertSameOrigin, OriginError } from "@/lib/planner/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const clickup = await syncClickUp();
    const google = await syncGoogle();
    const pending = await db.taskEventLink.findMany({ where: { clickupSyncPending: true } });
    const errors: string[] = [];
    for (const link of pending) {
      try { await syncTaskSchedule(link.clickupTaskId, link.calendarEventId); }
      catch (error) { errors.push(error instanceof Error ? error.message : "Error al actualizar ClickUp"); }
    }
    if (errors.length) return Response.json({ error: `${errors.length} vínculo(s) siguen pendientes de actualizar en ClickUp. ${errors[0]}`, clickup, google }, { status: 502 });
    return Response.json({ clickup, google, pending: 0 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Error de sincronización" }, { status: error instanceof OriginError ? 403 : 502 });
  }
}
