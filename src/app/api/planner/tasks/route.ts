import { archiveTask, createTask, completeTask, unarchiveTask } from "@/lib/planner/actions";
import { apiFailure, HttpError } from "@/lib/planner/http";
import { authorize } from "@/lib/planner/request";

export const runtime = "nodejs";

async function taskId(request: Request) {
  const body = await request.json();
  if (typeof body?.id !== "string" || !body.id.trim()) throw new HttpError(400, "Tarea inválida");
  return body.id as string;
}

export async function PATCH(request: Request) {
  try {
    const { ctx } = await authorize(request, { mutation: true });
    await completeTask(ctx, await taskId(request));
    return Response.json({ ok: true });
  } catch (error) { return apiFailure(error); }
}

export async function DELETE(request: Request) {
  try {
    const { ctx } = await authorize(request, { mutation: true });
    await archiveTask(ctx, await taskId(request));
    return Response.json({ ok: true });
  } catch (error) { return apiFailure(error); }
}

export async function POST(request: Request) {
  try {
    const { ctx } = await authorize(request, { mutation: true });
    await unarchiveTask(ctx, await taskId(request));
    return Response.json({ ok: true });
  } catch (error) { return apiFailure(error); }
}

export async function PUT(request: Request) {
  try {
    const { ctx } = await authorize(request, { mutation: true });
    const body = await request.json();
    const { id } = await createTask(ctx, body?.title);
    return Response.json({ ok: true, id }, { status: 201 });
  } catch (error) { return apiFailure(error); }
}
