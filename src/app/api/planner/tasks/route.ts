import { completeTask } from "@/lib/planner/actions";
import { assertSameOrigin, apiFailure, HttpError } from "@/lib/planner/http";

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (typeof body?.id !== "string" || !body.id.trim()) throw new HttpError(400, "Tarea inválida");
    await completeTask(body.id);
    return Response.json({ ok: true });
  } catch (error) { return apiFailure(error); }
}
