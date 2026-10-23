import { db } from "@/lib/db/client";
import { RateLimitError } from "@/lib/planner/http";

function isUniqueViolation(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && error.code === "P2002";
}

/** Fixed-window counter in SQLite, so it holds across processes and restarts. */
export async function enforceRateLimit(key: string, limit: number, windowMs: number, now = new Date()) {
  const windowFloor = new Date(now.getTime() - windowMs);
  for (let attempt = 0; attempt < 2; attempt++) {
    const incremented = await db.rateLimit.updateMany({
      where: { key, windowStart: { gt: windowFloor }, count: { lt: limit } }, data: { count: { increment: 1 } },
    });
    if (incremented.count) return;
    const reset = await db.rateLimit.updateMany({ where: { key, windowStart: { lte: windowFloor } }, data: { windowStart: now, count: 1 } });
    if (reset.count) return;
    try { await db.rateLimit.create({ data: { key, windowStart: now, count: 1 } }); return; }
    catch (error) { if (!isUniqueViolation(error)) throw error; }
  }
  const row = await db.rateLimit.findUnique({ where: { key } });
  const retryAfter = row ? Math.max(1, Math.ceil((row.windowStart.getTime() + windowMs - now.getTime()) / 1000)) : 1;
  throw new RateLimitError(retryAfter);
}
