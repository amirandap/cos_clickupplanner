import { apiFailure } from "@/lib/planner/http";
import { authorize } from "@/lib/planner/request";
import { settingsView, updateSettings, validateSettingsInput } from "@/lib/settings/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { user } = await authorize(request, { mutation: false });
    return Response.json(await settingsView(user), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}

export async function PUT(request: Request) {
  try {
    const { user } = await authorize(request, { mutation: true });
    await updateSettings(user.id, validateSettingsInput(await request.json()));
    return Response.json(await settingsView(user), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
