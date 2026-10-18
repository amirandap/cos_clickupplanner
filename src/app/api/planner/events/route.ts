import { scheduleTask, linkTaskToEvent, rescheduleEvent, removeEvent, validateOperationId } from "@/lib/planner/actions";
import { assertSameOrigin, apiFailure, HttpError } from "@/lib/planner/http";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const operationId = request.headers.get("Idempotency-Key");
    validateOperationId(operationId);
    const body = await request.json();
    if (typeof body?.taskId !== "string" || !body.taskId.trim()) throw new HttpError(400, "Tarea inválida");
    const result = await scheduleTask(body.taskId, body.startAt, operationId);
    return Response.json(result, { status: result.reused ? 200 : 201 });
  } catch (error) { return apiFailure(error); }
}

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (typeof body?.id !== "string" || !body.id.trim()) throw new HttpError(400, "Evento inválido");
    const result = typeof body.taskId === "string"
      ? await linkTaskToEvent(body.taskId, body.id)
      : await rescheduleEvent(body.id, body.startAt, body.endAt);
    return Response.json({ ok: true, ...result });
  } catch (error) { return apiFailure(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (typeof body?.id !== "string" || !body.id.trim()) throw new HttpError(400, "Evento inválido");
    await removeEvent(body.id);
    return Response.json({ ok: true });
  } catch (error) { return apiFailure(error); }
}
