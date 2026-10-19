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
      for (const event of result.items) {
        const cancelledException = event.status === "cancelled" && Boolean(event.recurringEventId);
        if (event.status === "cancelled" && !cancelledException) {
          const cached = await tx.calendarEvent.findMany({ where: { calendarId: selectedCalendar } });
          const removedIds = cached.filter((row) => row.id === event.id || (
            row.rawJson && typeof row.rawJson === "object" && !Array.isArray(row.rawJson) && row.rawJson.recurringEventId === event.id
          )).map((row) => row.id);
          await tx.taskEventLink.deleteMany({ where: { calendarEventId: { in: removedIds } } });
          await tx.calendarEvent.deleteMany({ where: { id: { in: removedIds } } });
          continue;
        }
        const existing = await tx.calendarEvent.findUnique({ where: { id: event.id } });
        const startAt = event.start ? googleEventDate(event.start)
          : event.originalStartTime ? googleEventDate(event.originalStartTime) : existing?.startAt;
        if (!startAt) throw new Error("Evento sin fecha: no se puede reconciliar la sincronización");
        const endAt = event.end ? googleEventDate(event.end) : new Date(startAt.getTime() + 1);
        const updated = event.updated ? new Date(event.updated) : null;
        keptIds.push(event.id);
        if (updated && existing?.calendarId === selectedCalendar && existing.remoteUpdated && updated < existing.remoteUpdated) continue;
        const properties = event.extendedProperties?.private;
        const candidateId = properties?.plannerLinkedClickupTaskId ?? (properties?.source === "planner" ? properties.clickupTaskId : null);
        const task = candidateId ? await tx.clickUpTask.findUnique({ where: { id: candidateId } }) : null;
        const taskId = !cancelledException && isTaskInScope(task) ? candidateId ?? null : null;
        const data = { calendarId: selectedCalendar, title: event.summary ?? "(Sin título)", startAt, endAt,
          clickupTaskId: taskId, rawJson: toJson(event), remoteUpdated: updated, syncedAt };
        await tx.calendarEvent.upsert({ where: { id: event.id }, create: { id: event.id, ...data }, update: data });
        const previousLink = await tx.taskEventLink.findUnique({ where: { calendarEventId: event.id } });
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
    }, { timeout: 30_000 });
    return result.items.length;
  });
}
