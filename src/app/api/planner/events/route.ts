import { scheduleTask, linkTaskToEvent, rescheduleEvent, removeEvent } from "@/lib/planner/actions";
import { assertSameOrigin, OriginError } from "@/lib/planner/http";

export const runtime = "nodejs";

function failure(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : "Error inesperado" }, { status: error instanceof OriginError ? 403 : 400 });
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (typeof body.taskId !== "string") throw new Error("Tarea inválida");
    return Response.json({ id: await scheduleTask(body.taskId, body.startAt) }, { status: 201 });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (typeof body.id !== "string") throw new Error("Evento inválido");
    if (typeof body.taskId === "string") {
      await linkTaskToEvent(body.taskId, body.id);
      return Response.json({ ok: true });
    }
    await rescheduleEvent(body.id, body.startAt, body.endAt);
    return Response.json({ ok: true });
  } catch (error) { return failure(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (typeof body.id !== "string") throw new Error("Evento inválido");
    await removeEvent(body.id);
    return Response.json({ ok: true });
  } catch (error) { return failure(error); }
}
