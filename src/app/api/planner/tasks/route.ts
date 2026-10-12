import { completeTask } from "@/lib/planner/actions";
import { assertSameOrigin, OriginError } from "@/lib/planner/http";

export const runtime = "nodejs";

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const body = await request.json();
    if (typeof body.id !== "string") throw new Error("Tarea inválida");
    await completeTask(body.id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Error inesperado" }, { status: error instanceof OriginError ? 403 : 400 });
  }
}
