import { apiFailure } from "@/lib/planner/http";
import { authorize } from "@/lib/planner/request";
import { connectClickUp, disconnectClickUp, settingsView } from "@/lib/settings/settings";

export const runtime = "nodejs";

export async function PUT(request: Request) {
  try {
    const { user } = await authorize(request, { mutation: true });
    const body = await request.json();
    await connectClickUp(user.id, body?.token);
    return Response.json(await settingsView(user), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}

export async function DELETE(request: Request) {
  try {
    const { user } = await authorize(request, { mutation: true });
    await disconnectClickUp(user.id);
    return Response.json(await settingsView(user), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
