import { scheduleTask, linkTaskToEvent, rescheduleEvent, renameEvent, removeEvent, deleteEvent, validateOperationId } from "@/lib/planner/actions";
import { apiFailure, HttpError } from "@/lib/planner/http";
import { authorize } from "@/lib/planner/request";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const { ctx } = await authorize(request, { mutation: true });
    const operationId = request.headers.get("Idempotency-Key");
    validateOperationId(operationId);
    const body = await request.json();
    if (typeof body?.taskId !== "string" || !body.taskId.trim()) throw new HttpError(400, "Tarea inválida");
    const result = await scheduleTask(ctx, body.taskId, body.startAt, operationId);
    return Response.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) { return apiFailure(error); }
}

export async function PATCH(request: Request) {
  try {
    const { ctx } = await authorize(request, { mutation: true });
    const body = await request.json();
    if (typeof body?.id !== "string" || !body.id.trim()) throw new HttpError(400, "Evento inválido");
    const result = typeof body.taskId === "string"
      ? await linkTaskToEvent(ctx, body.taskId, body.id)
      : typeof body.title === "string" ? await renameEvent(ctx, body.id, body.title)
      : await rescheduleEvent(ctx, body.id, body.startAt, body.endAt);
    return Response.json({ ok: true, ...result });
  } catch (error) { return apiFailure(error); }
}

export async function DELETE(request: Request) {
  try {
    const { ctx } = await authorize(request, { mutation: true });
    const body = await request.json();
    if (typeof body?.id !== "string" || !body.id.trim()) throw new HttpError(400, "Evento inválido");
    if (body.hard === true) await deleteEvent(ctx, body.id); else await removeEvent(ctx, body.id);
    return Response.json({ ok: true });
  } catch (error) { return apiFailure(error); }
}
