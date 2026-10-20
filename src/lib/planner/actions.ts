import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import { assertCalendarInScope, assertTaskInScope, lockKey, userTaskWhere, type UserContext } from "@/lib/planner/config";
import { NotFoundError } from "@/lib/planner/http";
import { withMutationLock } from "@/lib/planner/locking";
import { syncClickUp } from "@/lib/sync/run";
import { toJson } from "@/lib/db/json";
import { googleEventDate } from "@/lib/google/validation";
import { createRemoteEvent, deleteRemoteEvent, getRemoteEvent, linkRemoteEvent, renameRemoteEvent, unlinkRemoteEvent, updateRemoteEvent } from "@/lib/google/calendar";
import type { RemoteCalendarEvent } from "@/lib/google/calendar";
import { archiveRemoteTask, completeRemoteTask, createRemoteTask, createRemoteTaskComment, getClosedStatus, getRemoteTask, updateRemoteTaskDueDate } from "@/lib/clickup/tasks";

function invalid(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

function validDate(value: unknown) {
  if (typeof value !== "string") invalid("Fecha inválida");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) invalid("Fecha inválida");
  return date;
}

export function validateOperationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    invalid("Se requiere un header Idempotency-Key válido de 8 a 128 caracteres");
  }
}

function rawEvent(value: unknown, id: string): RemoteCalendarEvent {
  return { ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}), id };
}

function remoteLinkedTask(event: RemoteCalendarEvent) {
  const properties = event.extendedProperties?.private;
  return properties?.plannerLinkedClickupTaskId ?? (properties?.source === "planner" ? properties.clickupTaskId : null);
}

/** Tasks and events are always looked up by (user, id): somebody else's row is simply not found. */
async function findTask(ctx: UserContext, id: string) {
  const task = await db.clickUpTask.findFirst({ where: { id, ...userTaskWhere(ctx) } });
  if (!task) throw new NotFoundError("Tarea no encontrada");
  return task;
}

async function findEvent(ctx: UserContext, id: string) {
  const event = await db.calendarEvent.findUnique({ where: { userId_id: { userId: ctx.userId, id } } });
  if (!event) throw new NotFoundError("Evento no encontrado");
  return event;
}

function assertCurrentLink(ctx: UserContext, event: { clickupTaskId: string | null }, current: RemoteCalendarEvent) {
  if (!ctx.mock && remoteLinkedTask(current) !== event.clickupTaskId) {
    invalid("El vínculo del evento cambió en Google Calendar. Sincroniza antes de reintentar.", 409);
  }
}

async function assertCurrentTask(ctx: UserContext, task: { id: string; listId: string | null; rawJson?: unknown }) {
  assertTaskInScope(ctx, task);
  if (ctx.mock) return task.listId;
  const current = await getRemoteTask(ctx, task.id);
  if (!current) invalid("La tarea ya no existe en ClickUp. Sincroniza el calendario.", 404);
  assertTaskInScope(ctx, { listId: current.list?.id ?? null, rawJson: current });
  return current.list?.id ?? null;
}

async function assertEditable(ctx: UserContext, event: { id: string; calendarId: string; rawJson: unknown }) {
  assertCalendarInScope(ctx, event.calendarId);
  const raw = ctx.mock ? rawEvent(event.rawJson, event.id) : await getRemoteEvent(ctx, event.id, event.calendarId);
  if (raw.recurrence || raw.recurringEventId || event.id.startsWith("recurring:")) invalid("Los eventos recurrentes son de solo lectura en el planner");
  if (raw.status === "cancelled") invalid("El evento fue eliminado en Google Calendar", 410);
  if (!ctx.mock && typeof raw.etag !== "string") invalid("Google no devolvió la versión del evento", 502);
  return raw;
}

type ScheduleSyncResult = { clickupSyncPending: boolean; warning?: string };
export type ScheduleResult = ScheduleSyncResult & { id: string; reused: boolean };

export async function scheduleTask(ctx: UserContext, taskId: string, startInput: unknown, operationId: string): Promise<ScheduleResult> {
  validateOperationId(operationId);
  const startAt = validDate(startInput);
  return withMutationLock(lockKey(ctx), async () => {
    const task = await findTask(ctx, taskId);
    await assertCurrentTask(ctx, task);
    const configuredCalendar = ctx.calendarId;
    assertCalendarInScope(ctx, configuredCalendar);
    const payloadHash = createHash("sha256").update(JSON.stringify({ taskId, startAt: startAt.toISOString(), calendarId: configuredCalendar })).digest("hex");
    let operation = await db.scheduleOperation.findUnique({ where: { userId_id: { userId: ctx.userId, id: operationId } } });
    const reused = !!operation;
    if (operation && operation.payloadHash !== payloadHash) invalid("Idempotency-Key ya se utilizó con otra tarea, fecha o calendario", 409);
    if (!operation) {
      const duration = 30;
      // The Google event id derives from the user as well as the operation, so two users can never collide.
      const eventHash = createHash("sha256").update(`${ctx.userId}:${operationId}`).digest("hex");
      operation = await db.scheduleOperation.create({ data: {
        userId: ctx.userId, id: operationId, payloadHash, calendarEventId: `${ctx.mock ? "mock-" : "planner"}${eventHash}`,
        calendarId: configuredCalendar, clickupTaskId: task.id, title: task.title,
        startAt, endAt: new Date(startAt.getTime() + duration * 60000),
      } });
    }
    const existing = await db.calendarEvent.findUnique({ where: { userId_id: { userId: ctx.userId, id: operation.calendarEventId } } });
    if (operation.savedAt && !existing) invalid("El agendamiento de esta operación fue eliminado. Usa una nueva Idempotency-Key para crear otro.", 410);
    if (!existing) {
      // Google recovers POST409 by fetching the same deterministic ID. This also
      // handles a crash after Google accepted the request but before SQLite saved.
      const remote = await createRemoteEvent(ctx, task.id, operation.title, operation.startAt, operation.endAt, operation.calendarEventId, task.url);
      if (remote.id !== operation.calendarEventId) invalid("Google no devolvió el ID esperado del evento", 502);
      const savedOperation = operation;
      await db.$transaction(async (tx) => {
        await tx.calendarEvent.create({ data: {
          userId: ctx.userId, id: remote.id, calendarId: savedOperation.calendarId, title: remote.summary ?? savedOperation.title,
          startAt: savedOperation.startAt, endAt: savedOperation.endAt, clickupTaskId: task.id,
          rawJson: toJson(remote), remoteUpdated: remote.updated ? new Date(remote.updated) : null,
        } });
        await tx.taskEventLink.create({ data: { userId: ctx.userId, clickupTaskId: task.id, calendarEventId: remote.id, clickupSyncPending: true } });
        await tx.scheduleOperation.update({ where: { userId_id: { userId: ctx.userId, id: savedOperation.id } }, data: { savedAt: new Date() } });
      });
    }
    return { id: operation.calendarEventId, reused, ...await syncTaskSchedule(ctx, task.id, operation.calendarEventId, !reused) };
  });
}

export async function linkTaskToEvent(ctx: UserContext, taskId: string, eventId: string) {
  return withMutationLock(lockKey(ctx), async () => {
    const [task, event] = await Promise.all([findTask(ctx, taskId), findEvent(ctx, eventId)]);
    await assertCurrentTask(ctx, task);
    const raw = await assertEditable(ctx, event);
    if (raw.start?.date) invalid("Elige un agendamiento con hora para vincular la tarea");
    if (event.clickupTaskId !== taskId) {
      const remote = await linkRemoteEvent(ctx, raw, event.calendarId, taskId);
      await db.$transaction(async (tx) => {
        await tx.calendarEvent.update({ where: { userId_id: { userId: ctx.userId, id: eventId } }, data: { clickupTaskId: taskId,
          ...(raw.start && raw.end ? { startAt: googleEventDate(raw.start), endAt: googleEventDate(raw.end) } : {}),
          rawJson: toJson(remote), remoteUpdated: remote.updated ? new Date(remote.updated) : new Date(), syncedAt: new Date() } });
        await tx.taskEventLink.upsert({ where: { userId_calendarEventId: { userId: ctx.userId, calendarEventId: eventId } }, create: { userId: ctx.userId, clickupTaskId: taskId, calendarEventId: eventId, clickupSyncPending: true }, update: { clickupTaskId: taskId, clickupSyncPending: true, dueSyncedStartAt: null, commentedStartAt: null, commentAttemptedStartAt: null } });
      });
    } else {
      await db.taskEventLink.upsert({ where: { userId_calendarEventId: { userId: ctx.userId, calendarEventId: eventId } }, create: { userId: ctx.userId, clickupTaskId: taskId, calendarEventId: eventId, clickupSyncPending: true }, update: {} });
    }
    return syncTaskSchedule(ctx, taskId, eventId, true);
  });
}

// `verified` skips re-fetching the task and event when the caller just validated both.
export async function syncTaskSchedule(ctx: UserContext, taskId: string, eventId: string, verified = false): Promise<ScheduleSyncResult> {
  return withMutationLock(lockKey(ctx), async () => {
    const [task, cachedEvent, link] = await Promise.all([
      db.clickUpTask.findFirst({ where: { id: taskId, ...userTaskWhere(ctx) } }),
      db.calendarEvent.findUnique({ where: { userId_id: { userId: ctx.userId, id: eventId } } }),
      db.taskEventLink.findUnique({ where: { userId_calendarEventId: { userId: ctx.userId, calendarEventId: eventId } } }),
    ]);
    if (!task || !cachedEvent || !link || cachedEvent.clickupTaskId !== taskId || link.clickupTaskId !== taskId || !link.clickupSyncPending) return { clickupSyncPending: false };
    let event = cachedEvent;
    try {
      if (!verified) {
        await assertCurrentTask(ctx, task);
        const current = await assertEditable(ctx, event);
        assertCurrentLink(ctx, event, current);
        if (current.start && current.end) {
          const startAt = googleEventDate(current.start);
          const endAt = googleEventDate(current.end);
          if (startAt.getTime() !== event.startAt.getTime() || endAt.getTime() !== event.endAt.getTime()) {
            event = await db.calendarEvent.update({ where: { userId_id: { userId: ctx.userId, id: eventId } }, data: { startAt, endAt, rawJson: toJson(current), syncedAt: new Date() } });
          }
        }
      }
      // Due date and comment are independent ClickUp calls, so run them concurrently.
      const updateDue = async () => {
      if (link.dueSyncedStartAt?.getTime() !== event.startAt.getTime()) {
        const remote = await updateRemoteTaskDueDate(ctx, taskId, event.startAt);
        const original = task.rawJson && typeof task.rawJson === "object" && !Array.isArray(task.rawJson) ? task.rawJson : {};
        await db.$transaction(async (tx) => {
          await tx.clickUpTask.update({ where: { id: taskId }, data: {
            dueDate: event.startAt, rawJson: toJson({ ...original, ...remote, due_date: String(event.startAt.getTime()) }),
            remoteUpdated: remote.date_updated ? new Date(Number(remote.date_updated)) : new Date(), syncedAt: new Date(),
          } });
          await tx.taskEventLink.update({ where: { id: link.id }, data: { dueSyncedStartAt: event.startAt } });
        });
      }
      };
      const addComment = async () => {
      if (link.commentedStartAt?.getTime() !== event.startAt.getTime()) {
        if (link.commentAttemptedStartAt?.getTime() === event.startAt.getTime()) {
          throw new Error("El resultado del comentario anterior es incierto. Revisa ClickUp antes de repetirlo.");
        }
        const timezone = ctx.timezone;
        const when = new Intl.DateTimeFormat("es", { timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" }).format(event.startAt);
        const calendarReference = rawEvent(event.rawJson, event.id).htmlLink ?? event.id;
        // ClickUp comments have no idempotency key. Record intent first, so a lost
        // response or crash cannot cause an automatic duplicate comment.
        await db.taskEventLink.update({ where: { id: link.id }, data: { commentAttemptedStartAt: event.startAt } });
        try {
          await createRemoteTaskComment(ctx, taskId, `Agendada para el ${when} (${timezone}). Evento de Google Calendar: ${calendarReference}.`);
        } catch (error) {
          // A definitive rejection did not create a comment; network failures or
          // server errors remain ambiguous and must retain the durable marker.
          if (error instanceof Error && "upstreamStatus" in error && typeof error.upstreamStatus === "number" && error.upstreamStatus >= 400 && error.upstreamStatus < 500 && error.upstreamStatus !== 408) {
            await db.taskEventLink.update({ where: { id: link.id }, data: { commentAttemptedStartAt: null } });
          }
          throw error;
        }
        await db.taskEventLink.update({ where: { id: link.id }, data: { commentedStartAt: event.startAt } });
      }
      };
      const steps = await Promise.allSettled([updateDue(), addComment()]);
      const failed = steps.find((step): step is PromiseRejectedResult => step.status === "rejected");
      if (failed) throw failed.reason;
      await db.taskEventLink.update({ where: { id: link.id }, data: { clickupSyncPending: false, clickupSyncError: null } });
      return { clickupSyncPending: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error al actualizar ClickUp";
      await db.taskEventLink.update({ where: { id: link.id }, data: { clickupSyncError: message } }).catch(() => undefined);
      return { clickupSyncPending: true, warning: `El bloque quedó guardado en Google Calendar, pero ClickUp sigue pendiente: ${message}` };
    }
  });
}

export async function rescheduleEvent(ctx: UserContext, id: string, startInput: unknown, endInput: unknown): Promise<ScheduleSyncResult> {
  const startAt = validDate(startInput);
  const endAt = validDate(endInput);
  if (endAt <= startAt) invalid("El final debe ser posterior al inicio");
  return withMutationLock(lockKey(ctx), async () => {
    const event = await findEvent(ctx, id);
    const current = await assertEditable(ctx, event);
    assertCurrentLink(ctx, event, current);
    if (event.clickupTaskId) {
      const task = await db.clickUpTask.findFirst({ where: { id: event.clickupTaskId, ...userTaskWhere(ctx) } });
      if (!task) invalid("Tarea vinculada no encontrada", 404);
      await assertCurrentTask(ctx, task);
    }
    const remote = await updateRemoteEvent(ctx, event.id, event.calendarId, startAt, endAt, typeof current.etag === "string" ? current.etag : undefined);
    const rawJson = ctx.mock
      ? { ...(event.rawJson && typeof event.rawJson === "object" && !Array.isArray(event.rawJson) ? event.rawJson : {}), start: { dateTime: startAt.toISOString() }, end: { dateTime: endAt.toISOString() }, updated: remote.updated }
      : remote;
    await db.$transaction(async (tx) => {
      await tx.calendarEvent.update({ where: { userId_id: { userId: ctx.userId, id } }, data: { startAt, endAt, rawJson: toJson(rawJson), remoteUpdated: remote.updated ? new Date(remote.updated) : new Date(), syncedAt: new Date() } });
      if (event.clickupTaskId) await tx.taskEventLink.updateMany({ where: { userId: ctx.userId, calendarEventId: id, clickupTaskId: event.clickupTaskId }, data: { clickupSyncPending: true } });
    });
    return event.clickupTaskId ? syncTaskSchedule(ctx, event.clickupTaskId, id, true) : { clickupSyncPending: false };
  });
}

export async function renameEvent(ctx: UserContext, id: string, titleInput: unknown) {
  const title = typeof titleInput === "string" ? titleInput.trim() : "";
  if (!title || title.length > 1024) invalid("El título debe tener entre 1 y 1024 caracteres");
  return withMutationLock(lockKey(ctx), async () => {
    const event = await findEvent(ctx, id);
    const current = await assertEditable(ctx, event);
    assertCurrentLink(ctx, event, current);
    const remote = await renameRemoteEvent(ctx, event.id, event.calendarId, title, typeof current.etag === "string" ? current.etag : undefined);
    const rawJson = ctx.mock ? { ...current, summary: title, updated: remote.updated } : remote;
    await db.calendarEvent.update({ where: { userId_id: { userId: ctx.userId, id } }, data: { title, rawJson: toJson(rawJson), remoteUpdated: remote.updated ? new Date(remote.updated) : new Date(), syncedAt: new Date() } });
    return { clickupSyncPending: false };
  });
}

export async function deleteEvent(ctx: UserContext, id: string) {
  return withMutationLock(lockKey(ctx), async () => {
    const event = await findEvent(ctx, id);
    const raw = await assertEditable(ctx, event);
    assertCurrentLink(ctx, event, raw);
    await deleteRemoteEvent(ctx, event.id, event.calendarId, typeof raw.etag === "string" ? raw.etag : undefined);
    await db.$transaction(async (tx) => {
      await tx.taskEventLink.deleteMany({ where: { userId: ctx.userId, calendarEventId: id } });
      await tx.calendarEvent.delete({ where: { userId_id: { userId: ctx.userId, id } } });
    });
  });
}

export async function removeEvent(ctx: UserContext, id: string) {
  return withMutationLock(lockKey(ctx), async () => {
    const event = await findEvent(ctx, id);
    const raw = await assertEditable(ctx, event);
    assertCurrentLink(ctx, event, raw);
    if (!event.clickupTaskId) invalid("Este evento no está vinculado a una tarea");
    const task = await db.clickUpTask.findFirst({ where: { id: event.clickupTaskId, ...userTaskWhere(ctx) } });
    if (!task) invalid("Tarea vinculada no encontrada", 404);
    await assertCurrentTask(ctx, task);
    if (raw.extendedProperties?.private?.source === "planner") {
      await deleteRemoteEvent(ctx, event.id, event.calendarId, typeof raw.etag === "string" ? raw.etag : undefined);
      await db.$transaction(async (tx) => {
        await tx.taskEventLink.deleteMany({ where: { userId: ctx.userId, calendarEventId: id } });
        await tx.calendarEvent.delete({ where: { userId_id: { userId: ctx.userId, id } } });
      });
    } else {
      const remote = await unlinkRemoteEvent(ctx, raw, event.calendarId);
      await db.$transaction(async (tx) => {
        await tx.taskEventLink.deleteMany({ where: { userId: ctx.userId, calendarEventId: id } });
        await tx.calendarEvent.update({ where: { userId_id: { userId: ctx.userId, id } }, data: { clickupTaskId: null, rawJson: toJson(remote), remoteUpdated: remote.updated ? new Date(remote.updated) : new Date(), syncedAt: new Date() } });
      });
    }
  });
}

export async function completeTask(ctx: UserContext, id: string) {
  return withMutationLock(lockKey(ctx), async () => {
    const task = await findTask(ctx, id);
    const currentListId = await assertCurrentTask(ctx, task);
    const raw = task.rawJson as { status?: { type?: string } } | null;
    if (!currentListId && !ctx.mock) invalid("La tarea no tiene lista de ClickUp");
    const closedStatus = currentListId ? await getClosedStatus(ctx, currentListId) : "complete";
    const remote = await completeRemoteTask(ctx, id, closedStatus);
    const nextStatus = typeof remote.status === "object" ? remote.status?.status ?? closedStatus : closedStatus;
    await db.clickUpTask.update({ where: { id }, data: { status: nextStatus, rawJson: toJson(ctx.mock ? { ...(raw ?? {}), status: { status: nextStatus, type: "closed" } } : remote), remoteUpdated: new Date(), syncedAt: new Date() } });
  });
}

export async function unarchiveTask(ctx: UserContext, id: string) {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) invalid("Tarea inválida");
  // Only a task this user archived can be restored, so any other id is simply not found.
  const archived = await db.userTask.findFirst({ where: { userId: ctx.userId, taskId: id, archivedAt: { not: null } } });
  if (!archived) throw new NotFoundError("Tarea no encontrada");
  await withMutationLock(lockKey(ctx), async () => {
    await archiveRemoteTask(ctx, id, false);
    await db.userTask.updateMany({ where: { userId: ctx.userId, taskId: id }, data: { archivedAt: null } });
  });
  await syncClickUp(ctx);
}

export async function archiveTask(ctx: UserContext, id: string) {
  return withMutationLock(lockKey(ctx), async () => {
    const task = await findTask(ctx, id);
    await assertCurrentTask(ctx, task);
    await archiveRemoteTask(ctx, id);
    // Only this user's view changes: their links go and their membership is flagged so they can undo it.
    await db.$transaction([
      db.taskEventLink.deleteMany({ where: { userId: ctx.userId, clickupTaskId: id } }),
      db.userTask.updateMany({ where: { userId: ctx.userId, taskId: id }, data: { archivedAt: new Date() } }),
    ]);
  });
}

/** Creates a task in the AMP list (first configured list); ClickUp places it in its initial backlog status. */
export async function createTask(ctx: UserContext, titleInput: unknown) {
  const title = typeof titleInput === "string" ? titleInput.trim() : "";
  if (!title) invalid("Título inválido");
  if (title.length > 500) invalid("El título es demasiado largo");
  const listId = ctx.listIds[0];
  if (!listId) invalid("Configura tus listas de ClickUp en Ajustes para crear tareas");
  return withMutationLock(lockKey(ctx), async () => {
    const task = await createRemoteTask(ctx, listId, title, ctx.clickupUserId);
    const updated = task.date_updated ? new Date(Number(task.date_updated)) : new Date();
    const data = {
      title: task.name, status: task.status?.status ?? null, priority: task.priority?.priority ?? null,
      dueDate: null, estimateMin: null, url: task.url ?? null, listId: task.list?.id ?? listId, rawJson: toJson(task),
      remoteUpdated: updated, syncedAt: new Date(),
    };
    await db.$transaction([
      db.clickUpTask.upsert({ where: { id: task.id }, create: { id: task.id, ...data }, update: data }),
      db.userTask.upsert({ where: { userId_taskId: { userId: ctx.userId, taskId: task.id } }, create: { userId: ctx.userId, taskId: task.id }, update: { archivedAt: null } }),
    ]);
    return { id: task.id };
  });
}
