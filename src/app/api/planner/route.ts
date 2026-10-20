import { readPlanner } from "@/lib/planner/read";
import { apiFailure } from "@/lib/planner/http";
import { authorize } from "@/lib/planner/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { ctx } = await authorize(request, { mutation: false });
    const url = new URL(request.url);
    const startValue = url.searchParams.get("start");
    const endValue = url.searchParams.get("end");
    let range: { startAt: Date; endAt: Date } | undefined;
    if (startValue || endValue) {
      const startAt = new Date(startValue ?? "");
      const endAt = new Date(endValue ?? "");
      if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt || endAt.getTime() - startAt.getTime() > 90 * 86400000) {
        return Response.json({ error: "Rango de fechas inválido" }, { status: 400 });
      }
      range = { startAt, endAt };
    }
    return Response.json(await readPlanner(ctx, range), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
