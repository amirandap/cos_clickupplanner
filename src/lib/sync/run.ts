import { db } from "@/lib/db/client";
import { toJson } from "@/lib/db/json";
import { getRemoteTask, listRemoteTasks } from "@/lib/clickup/tasks";
import { listRemoteEvents } from "@/lib/google/calendar";
import { googleEventDate } from "@/lib/google/validation";
import { isTaskInScope, lockKey, type UserContext } from "@/lib/planner/config";
import { withMutationLock } from "@/lib/planner/locking";
import { ProviderHttpError } from "@/lib/providers/http";

function fromMillis(value?: string | null) {
  return value ? new Date(Number(value)) : null;
}

/**
 * The ClickUp cache rows are shared, but the user's membership (UserTask) is
 * built only from what this user's token returned. Removing a task here only
 * drops this user's membership, links and events. The shared row is deleted
 * once nobody references it.
 */
export async function syncClickUp(ctx: UserContext) {
  if (ctx.mock) return 0;
  return withMutationLock(lockKey(ctx), async () => {
    // Every page must succeed before a complete snapshot may remove cached rows.
    const started = new Date();
    const snapshot = (await listRemoteTasks(ctx)).filter((task) => isTaskInScope(ctx, { listId: task.list?.id ?? null, rawJson: task }));
    const tasksById = new Map(snapshot.map((task) => [task.id, task]));
    const cached = await db.userTask.findMany({ where: { userId: ctx.userId, archivedAt: null }, select: { taskId: true } });
    // Offset pages can shift when tasks change during pagination. Absence alone
    // is insufficient: confirm each missing task individually before removal.
    for (const { taskId } of cached) {
      if (tasksById.has(taskId)) continue;
      const current = await getRemoteTask(ctx, taskId);
      if (current && current.archived !== true && isTaskInScope(ctx, { listId: current.list?.id ?? null, rawJson: current })) tasksById.set(current.id, current);
    }
    const tasks = [...tasksById.values()];
    await db.$transaction(async (tx) => {
      for (const task of tasks) {
        const updated = fromMillis(task.date_updated);
        const existing = await tx.clickUpTask.findUnique({ where: { id: task.id } });
        if (!(updated && existing?.remoteUpdated && updated < existing.remoteUpdated)) {
          const data = {
            title: task.name, status: task.status?.status ?? null, priority: task.priority?.priority ?? null,
            dueDate: fromMillis(task.due_date), estimateMin: task.time_estimate ? Math.ceil(task.time_estimate / 60000) : null,
            url: task.url ?? null, listId: task.list?.id ?? null, rawJson: toJson(task), remoteUpdated: updated, syncedAt: started,
          };
          await tx.clickUpTask.upsert({ where: { id: task.id }, create: { id: task.id, ...data }, update: data });
        }
        await tx.userTask.upsert({ where: { userId_taskId: { userId: ctx.userId, taskId: task.id } }, create: { userId: ctx.userId, taskId: task.id }, update: { archivedAt: null } });
      }
      const keptIds = tasks.map((task) => task.id);
      const missingIds = cached.map((row) => row.taskId).filter((id) => !keptIds.includes(id));
      if (missingIds.length) {
        await tx.userTask.deleteMany({ where: { userId: ctx.userId, taskId: { in: missingIds } } });
        await tx.taskEventLink.deleteMany({ where: { userId: ctx.userId, clickupTaskId: { in: missingIds } } });
        await tx.calendarEvent.updateMany({ where: { userId: ctx.userId, clickupTaskId: { in: missingIds } }, data: { clickupTaskId: null } });
        await tx.clickUpTask.deleteMany({ where: { id: { in: missingIds }, users: { none: {} } } });
      }
      // Archived-by-me memberships older than a month can no longer be undone from the app.
      const staleArchive = await tx.userTask.findMany({ where: { userId: ctx.userId, archivedAt: { lt: new Date(started.getTime() - 30 * 86_400_000) } }, select: { taskId: true } });
      if (staleArchive.length) {
        const staleIds = staleArchive.map((row) => row.taskId);
        await tx.userTask.deleteMany({ where: { userId: ctx.userId, taskId: { in: staleIds } } });
        await tx.clickUpTask.deleteMany({ where: { id: { in: staleIds }, users: { none: {} } } });
      }
      for (const id of ["clickup", ...ctx.listIds.map((list) => `clickup:${list}`)]) {
        await tx.syncState.upsert({
          where: { userId_id: { userId: ctx.userId, id } },
          create: { userId: ctx.userId, id, source: "clickup", lastSyncAt: started }, update: { lastSyncAt: started },
        });
      }
    }, { timeout: 30_000 });
    return tasks.length;
  });
}

export async function syncGoogle(ctx: UserContext) {
  if (ctx.mock) return 0;
  return withMutationLock(lockKey(ctx), async () => {
    const userId = ctx.userId;
    const selectedCalendar = ctx.calendarId;
    const id = `google:${selectedCalendar}`;
    const [state, active] = await Promise.all([
      db.syncState.findUnique({ where: { userId_id: { userId, id } } }),
      db.syncState.findUnique({ where: { userId_id: { userId, id: "google:active" } } }),
    ]);
    // IDs are scoped by Google calendar. A switch requires a fresh snapshot even
    // if the old calendar has a saved token, so copied IDs can be attributed anew.
    const cursor = active?.cursor && active.cursor !== selectedCalendar ? undefined : state?.cursor ?? undefined;
    let fullSnapshot = !cursor;
    let result;
    try { result = await listRemoteEvents(ctx, cursor); }
    catch (error) {
      if (!(error instanceof ProviderHttpError) || error.upstreamStatus !== 410) throw error;
      result = await listRemoteEvents(ctx);
      fullSnapshot = true;
    }
    const syncedAt = new Date();
    await db.$transaction(async (tx) => {
      const keptIds: string[] = [];
      for (const event of result.items) {
        const cancelledException = event.status === "cancelled" && Boolean(event.recurringEventId);
        if (event.status === "cancelled" && !cancelledException) {
          const cached = await tx.calendarEvent.findMany({ where: { userId, calendarId: selectedCalendar } });
          const removedIds = cached.filter((row) => row.id === event.id || (
            row.rawJson && typeof row.rawJson === "object" && !Array.isArray(row.rawJson) && row.rawJson.recurringEventId === event.id
          )).map((row) => row.id);
          await tx.taskEventLink.deleteMany({ where: { userId, calendarEventId: { in: removedIds } } });
          await tx.calendarEvent.deleteMany({ where: { userId, id: { in: removedIds } } });
          continue;
        }
        const existing = await tx.calendarEvent.findUnique({ where: { userId_id: { userId, id: event.id } } });
        const startAt = event.start ? googleEventDate(event.start)
          : event.originalStartTime ? googleEventDate(event.originalStartTime) : existing?.startAt;
        if (!startAt) throw new Error("Evento sin fecha: no se puede reconciliar la sincronización");
        const endAt = event.end ? googleEventDate(event.end) : new Date(startAt.getTime() + 1);
        const updated = event.updated ? new Date(event.updated) : null;
        keptIds.push(event.id);
        if (updated && existing?.calendarId === selectedCalendar && existing.remoteUpdated && updated < existing.remoteUpdated) continue;
        const properties = event.extendedProperties?.private;
        const candidateId = properties?.plannerLinkedClickupTaskId ?? (properties?.source === "planner" ? properties.clickupTaskId : null);
        // A task may only be attached if this user's own token fetched it.
        const task = candidateId ? await tx.clickUpTask.findFirst({ where: { id: candidateId, users: { some: { userId } } } }) : null;
        const taskId = !cancelledException && isTaskInScope(ctx, task) ? candidateId ?? null : null;
        const data = { calendarId: selectedCalendar, title: event.summary ?? "(Sin título)", startAt, endAt,
          clickupTaskId: taskId, rawJson: toJson(event), remoteUpdated: updated, syncedAt };
        await tx.calendarEvent.upsert({ where: { userId_id: { userId, id: event.id } }, create: { userId, id: event.id, ...data }, update: data });
        const previousLink = await tx.taskEventLink.findUnique({ where: { userId_calendarEventId: { userId, calendarEventId: event.id } } });
        if (!taskId) {
          await tx.taskEventLink.deleteMany({ where: { userId, calendarEventId: event.id } });
          continue;
        }
        const ownerChanged = previousLink?.clickupTaskId !== taskId;
        const pending = !event.recurrence && !event.recurringEventId && (ownerChanged || Boolean(previousLink?.clickupSyncPending) || previousLink?.dueSyncedStartAt?.getTime() !== startAt.getTime());
        await tx.taskEventLink.upsert({ where: { userId_calendarEventId: { userId, calendarEventId: event.id } },
          create: { userId, clickupTaskId: taskId, calendarEventId: event.id, clickupSyncPending: pending },
          update: { clickupTaskId: taskId, clickupSyncPending: pending,
            ...(ownerChanged ? { dueSyncedStartAt: null, commentedStartAt: null, commentAttemptedStartAt: null, clickupSyncError: null } : {}) },
        });
      }
      if (fullSnapshot) {
        const missing = await tx.calendarEvent.findMany({ where: { userId, calendarId: selectedCalendar, id: { notIn: keptIds } }, select: { id: true } });
        const missingIds = missing.map((event) => event.id);
        await tx.taskEventLink.deleteMany({ where: { userId, calendarEventId: { in: missingIds } } });
        await tx.calendarEvent.deleteMany({ where: { userId, id: { in: missingIds } } });
      }
      await tx.syncState.upsert({ where: { userId_id: { userId, id } }, create: { userId, id, source: "google", cursor: result.nextSyncToken, lastSyncAt: syncedAt }, update: { cursor: result.nextSyncToken, lastSyncAt: syncedAt } });
      await tx.syncState.upsert({ where: { userId_id: { userId, id: "google:active" } }, create: { userId, id: "google:active", source: "google", cursor: selectedCalendar }, update: { cursor: selectedCalendar } });
    }, { timeout: 30_000 });
    return result.items.length;
  });
}
