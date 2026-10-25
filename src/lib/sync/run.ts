import { db } from "@/lib/db/client";
import { toJson } from "@/lib/db/json";
import { getRemoteTask, listRemoteTasks } from "@/lib/clickup/tasks";
import { calendarId, listRemoteEvents } from "@/lib/google/calendar";
import { googleEventDate } from "@/lib/google/validation";
import { getConfiguredListIds, isAssignedToDefault, isTaskInScope, taskScopeWhere } from "@/lib/planner/config";
import { withMutationLock } from "@/lib/planner/locking";
import { ProviderHttpError } from "@/lib/providers/http";

function fromMillis(value?: string | null) {
  return value ? new Date(Number(value)) : null;
}

export async function syncClickUp() {
  if (process.env.USE_MOCK_DATA === "true") return 0;
  return withMutationLock("planner", async () => {
    // Every page must succeed before a complete snapshot may remove cached rows.
    const started = new Date();
    const snapshot = (await listRemoteTasks()).filter((task) => isTaskInScope({ listId: task.list?.id ?? null, rawJson: task }));
    const listIds = getConfiguredListIds();
    const tasksById = new Map(snapshot.map((task) => [task.id, task]));
    const cachedTasks = await db.clickUpTask.findMany({ where: taskScopeWhere(), select: { id: true } });
    // Offset pages can shift when tasks change during pagination. Absence alone
    // is insufficient: confirm each missing task individually before removal.
    for (const cached of cachedTasks) {
      if (tasksById.has(cached.id)) continue;
      const current = await getRemoteTask(cached.id);
      if (current && isTaskInScope({ listId: current.list?.id ?? null, rawJson: current })) tasksById.set(current.id, current);
    }
    const tasks = [...tasksById.values()];
    await db.$transaction(async (tx) => {
      for (const task of tasks) {
        const updated = fromMillis(task.date_updated);
        const existing = await tx.clickUpTask.findUnique({ where: { id: task.id } });
        if (updated && existing?.remoteUpdated && updated < existing.remoteUpdated) continue;
        const data = {
          title: task.name, status: task.status?.status ?? null, priority: task.priority?.priority ?? null,
          dueDate: fromMillis(task.due_date), estimateMin: task.time_estimate ? Math.ceil(task.time_estimate / 60000) : null,
          url: task.url ?? null, listId: task.list?.id ?? null, rawJson: toJson(task), assignedToMe: isAssignedToDefault(task), remoteUpdated: updated, syncedAt: started,
        };
        await tx.clickUpTask.upsert({ where: { id: task.id }, create: { id: task.id, ...data }, update: data });
      }
      const missing = await tx.clickUpTask.findMany({
        where: { AND: [taskScopeWhere(), { id: { notIn: tasks.map((task) => task.id) } }] }, select: { id: true },
      });
      const missingIds = missing.map((task) => task.id);
      if (missingIds.length) {
        await tx.taskEventLink.deleteMany({ where: { clickupTaskId: { in: missingIds } } });
        await tx.calendarEvent.updateMany({ where: { clickupTaskId: { in: missingIds } }, data: { clickupTaskId: null } });
        await tx.clickUpTask.deleteMany({ where: { id: { in: missingIds } } });
      }
      for (const id of ["clickup", ...listIds.map((list) => `clickup:${list}`)]) {
        await tx.syncState.upsert({ where: { id }, create: { id, source: "clickup", lastSyncAt: started }, update: { lastSyncAt: started } });
      }
    }, { timeout: 30_000 });
    return tasks.length;
  });
}

const TX_TIMEOUT_MS = 30_000;
// Un snapshot completo del calendario escribe miles de filas (7 671 eventos hoy).
const FULL_SNAPSHOT_TX_TIMEOUT_MS = 180_000;

type CacheIndex = {
  removalsFor(eventId: string): string[];
  remember(eventId: string, recurringEventId?: string): void;
  forget(ids: string[]): void;
};

/** Ids cacheados y sus excepciones por serie, para borrar una serie cancelada junto con sus instancias. */
function buildCacheIndex(rows: { id: string; rawJson: unknown }[]): CacheIndex {
  const ids = new Set<string>();
  const parentOf = new Map<string, string>();
  const children = new Map<string, Set<string>>();
  const index: CacheIndex = {
    remember(eventId, recurringEventId) {
      ids.add(eventId);
      const previous = parentOf.get(eventId);
      if (previous && previous !== recurringEventId) children.get(previous)?.delete(eventId);
      if (!recurringEventId) { parentOf.delete(eventId); return; }
      parentOf.set(eventId, recurringEventId);
      children.set(recurringEventId, (children.get(recurringEventId) ?? new Set()).add(eventId));
    },
    removalsFor(eventId) { return [...(ids.has(eventId) ? [eventId] : []), ...(children.get(eventId) ?? [])]; },
    forget(removed) {
      for (const id of removed) {
        ids.delete(id);
        const parent = parentOf.get(id);
        if (parent) children.get(parent)?.delete(id);
        parentOf.delete(id);
      }
    },
  };
  for (const row of rows) {
    const raw = row.rawJson && typeof row.rawJson === "object" && !Array.isArray(row.rawJson) ? row.rawJson as { recurringEventId?: unknown } : null;
    index.remember(row.id, typeof raw?.recurringEventId === "string" ? raw.recurringEventId : undefined);
  }
  return index;
}

export async function syncGoogle() {
  if (process.env.USE_MOCK_DATA === "true") return 0;
  return withMutationLock("planner", async () => {
    const selectedCalendar = calendarId();
    const id = `google:${selectedCalendar}`;
    const [state, active] = await Promise.all([
      db.syncState.findUnique({ where: { id } }), db.syncState.findUnique({ where: { id: "google:active" } }),
    ]);
    // IDs are scoped by Google calendar. A switch requires a fresh snapshot even
    // if the old calendar has a saved token, so copied IDs can be attributed anew.
    const cursor = active?.cursor && active.cursor !== selectedCalendar ? undefined : state?.cursor ?? undefined;
    let fullSnapshot = !cursor;
    let result;
    try { result = await listRemoteEvents(cursor); }
    catch (error) {
      if (!(error instanceof ProviderHttpError) || error.upstreamStatus !== 410) throw error;
      result = await listRemoteEvents();
      fullSnapshot = true;
    }
    const syncedAt = new Date();
    await db.$transaction(async (tx) => {
      const keptIds: string[] = [];
      // Índice de la caché del calendario: se lee una sola vez (y solo si hay cancelaciones) en lugar de una por evento.
      const cache = {
        index: null as CacheIndex | null,
        async get() { return this.index ??= buildCacheIndex(await tx.calendarEvent.findMany({ where: { calendarId: selectedCalendar }, select: { id: true, rawJson: true } })); },
      };
      // Lecturas en bloque: un snapshot completo trae miles de eventos y una consulta por evento no cabe en la transacción.
      const eventIds = result.items.map((event) => event.id);
      const existingById = new Map((await tx.calendarEvent.findMany({ where: { id: { in: eventIds } } })).map((row) => [row.id, row]));
      const linkById = new Map((await tx.taskEventLink.findMany({ where: { calendarEventId: { in: eventIds } } })).map((link) => [link.calendarEventId, link]));
      const taskById = new Map<string, Awaited<ReturnType<typeof tx.clickUpTask.findUnique>>>();
      for (const event of result.items) {
        const cancelledException = event.status === "cancelled" && Boolean(event.recurringEventId);
        if (event.status === "cancelled" && !cancelledException) {
          const removedIds = (await cache.get()).removalsFor(event.id);
          await tx.taskEventLink.deleteMany({ where: { calendarEventId: { in: removedIds } } });
          await tx.calendarEvent.deleteMany({ where: { id: { in: removedIds } } });
          cache.index?.forget(removedIds);
          continue;
        }
        const existing = existingById.get(event.id) ?? null;
        const startAt = event.start ? googleEventDate(event.start)
          : event.originalStartTime ? googleEventDate(event.originalStartTime) : existing?.startAt;
        if (!startAt) throw new Error("Evento sin fecha: no se puede reconciliar la sincronización");
        const endAt = event.end ? googleEventDate(event.end) : new Date(startAt.getTime() + 1);
        const updated = event.updated ? new Date(event.updated) : null;
        keptIds.push(event.id);
        if (updated && existing?.calendarId === selectedCalendar && existing.remoteUpdated && updated < existing.remoteUpdated) continue;
        const properties = event.extendedProperties?.private;
        const candidateId = properties?.plannerLinkedClickupTaskId ?? (properties?.source === "planner" ? properties.clickupTaskId : null);
        if (candidateId && !taskById.has(candidateId)) taskById.set(candidateId, await tx.clickUpTask.findUnique({ where: { id: candidateId } }));
        const task = candidateId ? taskById.get(candidateId) ?? null : null;
        const taskId = !cancelledException && isTaskInScope(task) ? candidateId ?? null : null;
        const data = { calendarId: selectedCalendar, title: event.summary ?? "(Sin título)", startAt, endAt,
          clickupTaskId: taskId, rawJson: toJson(event), remoteUpdated: updated, syncedAt };
        await tx.calendarEvent.upsert({ where: { id: event.id }, create: { id: event.id, ...data }, update: data });
        cache.index?.remember(event.id, event.recurringEventId);
        const previousLink = linkById.get(event.id) ?? null;
        if (!taskId) {
          await tx.taskEventLink.deleteMany({ where: { calendarEventId: event.id } });
          continue;
        }
        const ownerChanged = previousLink?.clickupTaskId !== taskId;
        const pending = !event.recurrence && !event.recurringEventId && (ownerChanged || Boolean(previousLink?.clickupSyncPending) || previousLink?.dueSyncedStartAt?.getTime() !== startAt.getTime());
        await tx.taskEventLink.upsert({ where: { calendarEventId: event.id },
          create: { clickupTaskId: taskId, calendarEventId: event.id, clickupSyncPending: pending },
          update: { clickupTaskId: taskId, clickupSyncPending: pending,
            ...(ownerChanged ? { dueSyncedStartAt: null, commentedStartAt: null, commentAttemptedStartAt: null, clickupSyncError: null } : {}) },
        });
      }
      if (fullSnapshot) {
        const missing = await tx.calendarEvent.findMany({ where: { calendarId: selectedCalendar, id: { notIn: keptIds } }, select: { id: true } });
        const missingIds = missing.map((event) => event.id);
        await tx.taskEventLink.deleteMany({ where: { calendarEventId: { in: missingIds } } });
        await tx.calendarEvent.deleteMany({ where: { id: { in: missingIds } } });
      }
      await tx.syncState.upsert({ where: { id }, create: { id, source: "google", cursor: result.nextSyncToken, lastSyncAt: syncedAt }, update: { cursor: result.nextSyncToken, lastSyncAt: syncedAt } });
      await tx.syncState.upsert({ where: { id: "google:active" }, create: { id: "google:active", source: "google", cursor: selectedCalendar }, update: { cursor: selectedCalendar } });
    }, { timeout: fullSnapshot ? FULL_SNAPSHOT_TX_TIMEOUT_MS : TX_TIMEOUT_MS });
    return result.items.length;
  });
}
