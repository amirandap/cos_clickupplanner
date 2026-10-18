import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/db/client";

// Shared by processes, unlike an in-memory mutex. Network requests are bounded by
// provider timeouts; renewal keeps a slow but healthy worker's lease alive.
const leaseMs = 60_000;
const heartbeatMs = 5_000;
const heldLocks = new AsyncLocalStorage<Set<string>>();

export async function withMutationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const held = heldLocks.getStore();
  if (held?.has(key)) return operation();
  const owner = randomUUID();
  const deadline = Date.now() + 65_000;
  for (;;) {
    try {
      await db.mutationLease.create({ data: { key, owner, expiresAt: new Date(Date.now() + leaseMs) } });
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
      const replaced = await db.mutationLease.updateMany({ where: { key, expiresAt: { lte: new Date() } }, data: { owner, expiresAt: new Date(Date.now() + leaseMs) } });
      if (replaced.count) break;
      if (Date.now() >= deadline) throw Object.assign(new Error("Hay otra operación en curso. Reintenta en unos segundos."), { status: 423, retryAfter: 2 });
      await new Promise((resolve) => setTimeout(resolve, 40 + Math.floor(Math.random() * 40)));
    }
  }
  let renewing = Promise.resolve();
  const timer = setInterval(() => {
    renewing = renewing.then(async () => {
      await db.mutationLease.updateMany({ where: { key, owner }, data: { expiresAt: new Date(Date.now() + leaseMs) } });
    }).catch(() => {
      // A transient DB outage must not turn an already saved remote change into
      // an ambiguous failure. The persisted lease still protects bounded HTTP.
    });
  }, heartbeatMs);
  timer.unref();
  try {
    return await heldLocks.run(new Set([...(held ?? []), key]), operation);
  } finally {
    clearInterval(timer);
    await renewing;
    // Cleanup cannot hide the operation result. An abandoned lease expires.
    await db.mutationLease.deleteMany({ where: { key, owner } }).catch(() => undefined);
  }
}
