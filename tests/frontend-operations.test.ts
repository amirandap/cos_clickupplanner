import assert from "node:assert/strict";
import test from "node:test";
import { loadModule } from "./helpers";
import { createOperationRunner, createScheduleClient, isMutationResult, isPlannerData, isScheduleResult, persistCalendarEdit, requestJson } from "../src/components/planner/client";

test("schedule retains its idempotency key after an ambiguous network failure", async () => {
  const keys: string[] = [];
  let count = 0;
  const client = createScheduleClient(async (_url, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    if (count++ === 0) throw new TypeError("Failed to fetch");
    return Response.json({ id: "event-1", clickupSyncPending: true, warning: "Pendiente de actualizar en ClickUp" });
  }, () => `attempt-${count}`);

  await assert.rejects(client.schedule("task-1", "2026-10-16T09:00:00.000Z"));
  const result = await client.schedule("task-1", "2026-10-16T09:00:00.000Z");
  assert.equal(keys[0], keys[1]);
  assert.equal(result.clickupSyncPending, true);
  assert.equal(result.warning, "Pendiente de actualizar en ClickUp");

  await client.schedule("task-1", "2026-10-16T09:00:00.000Z");
  assert.notEqual(keys[1], keys[2]);
});

test("a changed schedule intent receives a different key", async () => {
  const keys: string[] = [];
  let serial = 0;
  const client = createScheduleClient(async (_url, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    throw new TypeError("Network unavailable");
  }, () => `attempt-${++serial}`);
  await assert.rejects(client.schedule("task-1", "2026-10-16T09:00:00.000Z"));
  await assert.rejects(client.schedule("task-1", "2026-10-16T10:00:00.000Z"));
  assert.notEqual(keys[0], keys[1]);
});

test("pending schedule keys survive a new client in the same browser session", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const keys: string[] = [];
  const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    if (keys.length === 1) throw new TypeError("Connection lost");
    return Response.json({ id: "event-1", clickupSyncPending: false });
  };
  const first = createScheduleClient(fetcher, () => "first-key", storage);
  await assert.rejects(first.schedule("task-1", "2026-10-16T09:00:00.000Z"));
  assert.equal(values.size, 1);

  const afterReload = createScheduleClient(fetcher, () => "second-key", storage);
  await afterReload.schedule("task-1", "2026-10-16T09:00:00.000Z");
  assert.equal(keys[1], keys[0]);
  assert.equal(values.size, 0);

  await afterReload.schedule("task-1", "2026-10-16T09:00:00.000Z");
  assert.equal(keys[2], "second-key");
});

test("definitive schedule rejections retire the old key for the next explicit attempt", async () => {
  for (const status of [410, 409]) {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const keys: string[] = [];
    let serial = 0;
    const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
      if (keys.length === 1) throw new TypeError("Saved remotely but response lost");
      if (keys.length === 2) return Response.json({ error: "Usa una nueva clave" }, { status });
      return Response.json({ id: "event-2", clickupSyncPending: false });
    };
    const makeKey = () => `key-${++serial}`;
    const client = createScheduleClient(fetcher, makeKey, storage);
    await assert.rejects(client.schedule("task-1", "2026-10-16T09:00:00.000Z"));
    await assert.rejects(client.schedule("task-1", "2026-10-16T09:00:00.000Z"));
    assert.equal(keys.length, 2, "a definitive failure must not retry automatically");
    assert.equal(values.size, 0, "the rejected key must also leave session storage");
    const afterReload = createScheduleClient(fetcher, makeKey, storage);
    await afterReload.schedule("task-1", "2026-10-16T09:00:00.000Z");
    assert.deepEqual(keys, ["key-1", "key-1", "key-2"]);
  }
});

test("server errors retain the key because the remote outcome may be ambiguous", async () => {
  const keys: string[] = [];
  let serial = 0;
  const client = createScheduleClient(async (_url, init) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    return keys.length === 1 ? Response.json({ error: "Unavailable" }, { status: 503 })
      : Response.json({ id: "event-1", clickupSyncPending: false });
  }, () => `key-${++serial}`);
  await assert.rejects(client.schedule("task-1", "2026-10-16T09:00:00.000Z"));
  await client.schedule("task-1", "2026-10-16T09:00:00.000Z");
  assert.deepEqual(keys, ["key-1", "key-1"]);
});

test("requestJson handles non-JSON responses with a useful error", async () => {
  const fetcher = async () => new Response("<html>Unavailable</html>", { status: 502 });
  await assert.rejects(requestJson("/api/planner/events", {}, isMutationResult, fetcher), /No se pudo completar/);
});

test("network failure presents an actionable message", async () => {
  await assert.rejects(requestJson("/api/planner/events", {}, isMutationResult, async () => { throw new TypeError("Failed to fetch"); }), /No se pudo conectar/);
});

test("planner data requires recurrence metadata and valid event dates", () => {
  const event = { id: "event-1", calendarId: "calendar-1", title: "Reunión", startAt: "2026-10-16T09:00:00.000Z", endAt: "2026-10-16T10:00:00.000Z", allDay: false, startDate: null, endDate: null, clickupTaskId: null, plannerOwned: false };
  const data = { tasks: [], events: [{ ...event, recurring: false }], timezone: "UTC", mockMode: true, defaultAssigneeId: null, lastSyncAt: null };
  assert.equal(isPlannerData(data), true);
  assert.equal(isPlannerData({ ...data, events: [event] }), false);
  assert.equal(isPlannerData({ ...data, events: [{ ...event, recurring: true, startAt: "invalid" }] }), false);
  assert.equal(isPlannerData({ ...data, timezone: "Invalid/Timezone" }), false);
});

test("requestJson rejects malformed successful payloads", async () => {
  const fetcher = async () => Response.json({ id: 25 });
  await assert.rejects(requestJson("/api/planner/events", {}, isScheduleResult, fetcher), /respuesta/);
});

test("requestJson preserves API errors and confirmed partial-success warnings", async () => {
  await assert.rejects(requestJson("/api/planner/events", {}, isMutationResult, async () => Response.json({ error: "Horario inválido" }, { status: 400 })), /Horario inválido/);
  const result = await requestJson("/api/planner/events", {}, isMutationResult, async () => Response.json({ ok: true, warning: "Pendiente de actualizar en ClickUp" }));
  assert.equal(result.warning, "Pendiente de actualizar en ClickUp");
});

test("operation runner catches refresh failure after a successful save", async () => {
  const runner = createOperationRunner();
  const result = await runner.run(async () => ({ ok: true as const }), async () => { throw new Error("Recarga fallida"); });
  assert.equal(result?.saved, true);
  assert.equal(result?.error, "Se guardó el cambio, pero no se pudo actualizar el calendario. Vuelve a sincronizar.");
});

test("operation runner preserves mutation failure even when refresh also fails", async () => {
  const runner = createOperationRunner();
  const result = await runner.run(async () => { throw new Error("No se pudo guardar"); }, async () => { throw new Error("No se pudo cargar"); });
  assert.equal(result?.saved, false);
  assert.equal(result?.error, "No se pudo guardar");
});

test("operation runner blocks concurrent mutations until refresh finishes", async () => {
  const runner = createOperationRunner();
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const first = runner.run(async () => ({ ok: true as const }), () => waiting);
  const duplicate = await runner.run(async () => { throw new Error("Must not run"); }, async () => {});
  assert.equal(duplicate, null);
  release();
  assert.equal((await first)?.saved, true);
});

test("an ambiguous calendar edit keeps the authoritative refreshed schedule", async () => {
  const previous = "2026-10-16T09:00:00.000Z";
  const next = "2026-10-16T10:00:00.000Z";
  let displayed = next;
  let remote = previous;
  const order: string[] = [];
  const runner = createOperationRunner();
  const result = await persistCalendarEdit({ id: "event-1", startAt: next, endAt: "2026-10-16T11:00:00.000Z" },
    () => { order.push("revert"); displayed = previous; },
    async (operation) => {
      const outcome = await runner.run(operation, async () => { order.push("refresh"); displayed = remote; });
      return outcome?.saved ?? false;
    },
    async (_input, init) => {
      order.push("request");
      const payload = JSON.parse(String(init?.body)) as { startAt: string };
      remote = payload.startAt;
      throw new TypeError("Saved remotely but response lost");
    });
  assert.equal(result, false);
  assert.equal(displayed, next);
  assert.deepEqual(order, ["revert", "request", "refresh"]);
});


test("a lost response followed by lock contention preserves the schedule key across reloads", async (t) => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const locking = loadModule<typeof import("../src/lib/planner/locking")>("src/lib/planner/locking.ts", {
    "@/lib/db/client": { db: { mutationLease: {
      create: async () => { throw Object.assign(new Error("Already held"), { code: "P2002" }); },
      updateMany: async () => ({ count: 0 }),
    } } },
  });
  const http = loadModule<typeof import("../src/lib/planner/http")>("src/lib/planner/http.ts");
  const keys: string[] = [];
  let serial = 0;
  const fetcher = async (_url: RequestInfo | URL, init?: RequestInit) => {
    keys.push(new Headers(init?.headers).get("Idempotency-Key") ?? "");
    if (keys.length === 1) throw new TypeError("Saved remotely but response lost");
    if (keys.length === 2) {
      let now = 0;
      const clock = t.mock.method(Date, "now", () => (now += 70_000));
      try {
        await locking.withMutationLock("planner:user-a", async () => { throw new Error("Must not run while held"); });
      } catch (error) {
        const response = http.apiFailure(error);
        assert.equal(response.status, 423);
        assert.equal(response.headers.get("Retry-After"), "2");
        return response;
      } finally { clock.mock.restore(); }
    }
    return Response.json({ id: "original-event", clickupSyncPending: false });
  };
  const makeKey = () => `key-${++serial}`;
  const client = createScheduleClient(fetcher, makeKey, storage);
  await assert.rejects(client.schedule("task-1", "2026-10-16T09:00:00.000Z"));
  await assert.rejects(client.schedule("task-1", "2026-10-16T09:00:00.000Z"));
  assert.equal(values.size, 1);
  const afterReload = createScheduleClient(fetcher, makeKey, storage);
  const result = await afterReload.schedule("task-1", "2026-10-16T09:00:00.000Z");
  assert.equal(result.id, "original-event");
  assert.deepEqual(keys, ["key-1", "key-1", "key-1"]);
  assert.equal(values.size, 0);
});
