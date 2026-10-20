import { apiFailure } from "@/lib/planner/http";
import { authorize } from "@/lib/planner/request";
import { disconnectGoogleCalendar, settingsView } from "@/lib/settings/settings";

export const runtime = "nodejs";

export async function DELETE(request: Request) {
  try {
    const { user } = await authorize(request, { mutation: true });
    await disconnectGoogleCalendar(user.id);
    return Response.json(await settingsView(user), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
