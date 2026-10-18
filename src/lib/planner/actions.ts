import { createHash } from "node:crypto";
import { db } from "@/lib/db/client";
import { appTimezone, assertCalendarInScope, assertTaskInScope } from "@/lib/planner/config";
import { withMutationLock } from "@/lib/planner/locking";
import { toJson } from "@/lib/db/json";
import { googleEventDate } from "@/lib/google/validation";
import { createRemoteEvent, deleteRemoteEvent, getRemoteEvent, linkRemoteEvent, unlinkRemoteEvent, updateRemoteEvent, calendarId } from "@/lib/google/calendar";
import type { RemoteCalendarEvent } from "@/lib/google/calendar";
import { completeRemoteTask, createRemoteTaskComment, getClosedStatus, getRemoteTask, updateRemoteTaskDueDate } from "@/lib/clickup/tasks";

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

function assertCurrentLink(event: { clickupTaskId: string | null }, current: RemoteCalendarEvent) {
  if (process.env.USE_MOCK_DATA !== "true" && remoteLinkedTask(current) !== event.clickupTaskId) {
    invalid("El vínculo del evento cambió en Google Calendar. Sincroniza antes de reintentar.", 409);
  }
}

async function assertCurrentTask(task: { id: string; listId: string | null }) {
  assertTaskInScope(task);
  if (process.env.USE_MOCK_DATA === "true") return task.listId;
  const current = await getRemoteTask(task.id);
  if (!current) invalid("La tarea ya no existe en ClickUp. Sincroniza el calendario.", 404);
  assertTaskInScope({ listId: current.list?.id ?? null });
  return current.list?.id ?? null;
}

async function assertEditable(event: { id: string; calendarId: string; rawJson: unknown }) {
  assertCalendarInScope(event.calendarId);
  const raw = process.env.USE_MOCK_DATA === "true" ? rawEvent(event.rawJson, event.id) : await getRemoteEvent(event.id, event.calendarId);
  if (raw.recurrence || raw.recurringEventId || event.id.startsWith("recurring:")) invalid("Los eventos recurrentes son de solo lectura en el planner");
  if (raw.status === "cancelled") invalid("El evento fue eliminado en Google Calendar", 410);
  if (process.env.USE_MOCK_DATA !== "true" && typeof raw.etag !== "string") invalid("Google no devolvió la versión del evento", 502);
  return raw;
}

type ScheduleSyncResult = { clickupSyncPending: boolean; warning?: string };
export type ScheduleResult = ScheduleSyncResult & { id: string; reused: boolean };

export async function scheduleTask(taskId: string, startInput: unknown, operationId: string): Promise<ScheduleResult> {
  validateOperationId(operationId);
  const startAt = validDate(startInput);
  return withMutationLock("planner", async () => {
    const task = await db.clickUpTask.findUnique({ where: { id: taskId } });
    if (!task) invalid("Tarea no encontrada", 404);
    await assertCurrentTask(task);
    const configuredCalendar = calendarId();
    assertCalendarInScope(configuredCalendar);
    const payloadHash = createHash("sha256").update(JSON.stringify({ taskId, startAt: startAt.toISOString(), calendarId: configuredCalendar })).digest("hex");
    let operation = await db.scheduleOperation.findUnique({ where: { id: operationId } });
    const reused = !!operation;
    if (operation && operation.payloadHash !== payloadHash) invalid("Idempotency-Key ya se utilizó con otra tarea, fecha o calendario", 409);
    if (!operation) {
      const duration = task.estimateMin && task.estimateMin > 0 ? task.estimateMin : 30;
      const eventHash = createHash("sha256").update(operationId).digest("hex");
      operation = await db.scheduleOperation.create({ data: {
        id: operationId, payloadHash, calendarEventId: `${process.env.USE_MOCK_DATA === "true" ? "mock-" : "planner"}${eventHash}`,
        calendarId: configuredCalendar, clickupTaskId: task.id, title: task.title,
        startAt, endAt: new Date(startAt.getTime() + duration * 60000),
      } });
    }
    const existing = await db.calendarEvent.findUnique({ where: { id: operation.calendarEventId } });
    if (operation.savedAt && !existing) invalid("El agendamiento de esta operación fue eliminado. Usa una nueva Idempotency-Key para crear otro.", 410);
    if (!existing) {
      // Google recovers POST409 by fetching the same deterministic ID. This also
      // handles a crash after Google accepted the request but before SQLite saved.
      const remote = await createRemoteEvent(task.id, operation.title, operation.startAt, operation.endAt, operation.calendarEventId);
      if (remote.id !== operation.calendarEventId) invalid("Google no devolvió el ID esperado del evento", 502);
      const savedOperation = operation;
      await db.$transaction(async (tx) => {
        await tx.calendarEvent.create({ data: {
          id: remote.id, calendarId: savedOperation.calendarId, title: remote.summary ?? savedOperation.title,
          startAt: savedOperation.startAt, endAt: savedOperation.endAt, clickupTaskId: task.id,
          rawJson: toJson(remote), remoteUpdated: remote.updated ? new Date(remote.updated) : null,
        } });
        await tx.taskEventLink.create({ data: { clickupTaskId: task.id, calendarEventId: remote.id, clickupSyncPending: true } });
        await tx.scheduleOperation.update({ where: { id: savedOperation.id }, data: { savedAt: new Date() } });
      });
    }
    return { id: operation.calendarEventId, reused, ...await syncTaskSchedule(task.id, operation.calendarEventId) };
  });
}

export async function linkTaskToEvent(taskId: string, eventId: string) {
  return withMutationLock("planner", async () => {
    const [task, event] = await Promise.all([
      db.clickUpTask.findUnique({ where: { id: taskId } }), db.calendarEvent.findUnique({ where: { id: eventId } }),
    ]);
    if (!task || !event) invalid("Tarea o evento no encontrado", 404);
    await assertCurrentTask(task);
    const raw = await assertEditable(event);
    if (event.clickupTaskId && event.clickupTaskId !== taskId) invalid("Este evento ya está vinculado a otra tarea", 409);
    const remoteTaskId = remoteLinkedTask(raw);
    if (remoteTaskId && remoteTaskId !== taskId) invalid("El evento ya se vinculó a otra tarea en Google Calendar", 409);
    if (raw.start?.date) invalid("Elige un agendamiento con hora para vincular la tarea");
    if (event.clickupTaskId !== taskId) {
      const remote = await linkRemoteEvent(raw, event.calendarId, taskId);
      await db.$transaction(async (tx) => {
        await tx.calendarEvent.update({ where: { id: eventId }, data: { clickupTaskId: taskId,
          ...(raw.start && raw.end ? { startAt: googleEventDate(raw.start), endAt: googleEventDate(raw.end) } : {}),
          rawJson: toJson(remote), remoteUpdated: remote.updated ? new Date(remote.updated) : new Date(), syncedAt: new Date() } });
        await tx.taskEventLink.upsert({ where: { calendarEventId: eventId }, create: { clickupTaskId: taskId, calendarEventId: eventId, clickupSyncPending: true }, update: { clickupTaskId: taskId, clickupSyncPending: true, dueSyncedStartAt: null, commentedStartAt: null, commentAttemptedStartAt: null } });
      });
    } else {
      await db.taskEventLink.upsert({ where: { calendarEventId: eventId }, create: { clickupTaskId: taskId, calendarEventId: eventId, clickupSyncPending: true }, update: {} });
    }
    return syncTaskSchedule(taskId, eventId);
  });
}

export async function syncTaskSchedule(taskId: string, eventId: string): Promise<ScheduleSyncResult> {
  return withMutationLock("planner", async () => {
    const [task, cachedEvent, link] = await Promise.all([
      db.clickUpTask.findUnique({ where: { id: taskId } }), db.calendarEvent.findUnique({ where: { id: eventId } }),
      db.taskEventLink.findUnique({ where: { calendarEventId: eventId } }),
    ]);
    if (!task || !cachedEvent || !link || cachedEvent.clickupTaskId !== taskId || link.clickupTaskId !== taskId || !link.clickupSyncPending) return { clickupSyncPending: false };
    let event = cachedEvent;
    try {
      await assertCurrentTask(task);
      const current = await assertEditable(event);
      assertCurrentLink(event, current);
      if (current.start && current.end) {
        const startAt = googleEventDate(current.start);
        const endAt = googleEventDate(current.end);
        if (startAt.getTime() !== event.startAt.getTime() || endAt.getTime() !== event.endAt.getTime()) {
          event = await db.calendarEvent.update({ where: { id: eventId }, data: { startAt, endAt, rawJson: toJson(current), syncedAt: new Date() } });
        }
      }
      if (link.dueSyncedStartAt?.getTime() !== event.startAt.getTime()) {
        const remote = await updateRemoteTaskDueDate(taskId, event.startAt);
        const original = task.rawJson && typeof task.rawJson === "object" && !Array.isArray(task.rawJson) ? task.rawJson : {};
        await db.$transaction(async (tx) => {
          await tx.clickUpTask.update({ where: { id: taskId }, data: {
            dueDate: event.startAt, rawJson: toJson({ ...original, ...remote, due_date: String(event.startAt.getTime()) }),
            remoteUpdated: remote.date_updated ? new Date(Number(remote.date_updated)) : new Date(), syncedAt: new Date(),
          } });
          await tx.taskEventLink.update({ where: { id: link.id }, data: { dueSyncedStartAt: event.startAt } });
        });
      }
      if (link.commentedStartAt?.getTime() !== event.startAt.getTime()) {
        if (link.commentAttemptedStartAt?.getTime() === event.startAt.getTime()) {
          throw new Error("El resultado del comentario anterior es incierto. Revisa ClickUp antes de repetirlo.");
        }
        const timezone = appTimezone();
        const when = new Intl.DateTimeFormat("es", { timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" }).format(event.startAt);
        const calendarReference = rawEvent(event.rawJson, event.id).htmlLink ?? event.id;
        // ClickUp comments have no idempotency key. Record intent first, so a lost
        // response or crash cannot cause an automatic duplicate comment.
        await db.taskEventLink.update({ where: { id: link.id }, data: { commentAttemptedStartAt: event.startAt } });
        try {
          await createRemoteTaskComment(taskId, `Agendada para el ${when} (${timezone}). Evento de Google Calendar: ${calendarReference}.`);
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
      await db.taskEventLink.update({ where: { id: link.id }, data: { clickupSyncPending: false, clickupSyncError: null } });
      return { clickupSyncPending: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error al actualizar ClickUp";
      await db.taskEventLink.update({ where: { id: link.id }, data: { clickupSyncError: message } }).catch(() => undefined);
      return { clickupSyncPending: true, warning: `El bloque quedó guardado en Google Calendar, pero ClickUp sigue pendiente: ${message}` };
    }
  });
}

export async function rescheduleEvent(id: string, startInput: unknown, endInput: unknown): Promise<ScheduleSyncResult> {
  const startAt = validDate(startInput);
  const endAt = validDate(endInput);
  if (endAt <= startAt) invalid("El final debe ser posterior al inicio");
  return withMutationLock("planner", async () => {
    const event = await db.calendarEvent.findUnique({ where: { id } });
    if (!event) invalid("Evento no encontrado", 404);
    const current = await assertEditable(event);
    assertCurrentLink(event, current);
    if (event.clickupTaskId) {
      const task = await db.clickUpTask.findUnique({ where: { id: event.clickupTaskId } });
      if (!task) invalid("Tarea vinculada no encontrada", 404);
      await assertCurrentTask(task);
    }
    const remote = await updateRemoteEvent(event.id, event.calendarId, startAt, endAt, typeof current.etag === "string" ? current.etag : undefined);
    const rawJson = process.env.USE_MOCK_DATA === "true"
      ? { ...(event.rawJson && typeof event.rawJson === "object" && !Array.isArray(event.rawJson) ? event.rawJson : {}), start: { dateTime: startAt.toISOString() }, end: { dateTime: endAt.toISOString() }, updated: remote.updated }
      : remote;
    await db.$transaction(async (tx) => {
      await tx.calendarEvent.update({ where: { id }, data: { startAt, endAt, rawJson: toJson(rawJson), remoteUpdated: remote.updated ? new Date(remote.updated) : new Date(), syncedAt: new Date() } });
      if (event.clickupTaskId) await tx.taskEventLink.updateMany({ where: { calendarEventId: id, clickupTaskId: event.clickupTaskId }, data: { clickupSyncPending: true } });
    });
    return event.clickupTaskId ? syncTaskSchedule(event.clickupTaskId, id) : { clickupSyncPending: false };
  });
}

export async function removeEvent(id: string) {
  return withMutationLock("planner", async () => {
    const event = await db.calendarEvent.findUnique({ where: { id } });
    if (!event) invalid("Evento no encontrado", 404);
    const raw = await assertEditable(event);
    assertCurrentLink(event, raw);
    if (!event.clickupTaskId) invalid("Este evento no está vinculado a una tarea");
    const task = await db.clickUpTask.findUnique({ where: { id: event.clickupTaskId } });
    if (!task) invalid("Tarea vinculada no encontrada", 404);
    await assertCurrentTask(task);
    if (raw.extendedProperties?.private?.source === "planner") {
      await deleteRemoteEvent(event.id, event.calendarId, typeof raw.etag === "string" ? raw.etag : undefined);
      await db.$transaction(async (tx) => {
        await tx.taskEventLink.deleteMany({ where: { calendarEventId: id } });
        await tx.calendarEvent.delete({ where: { id } });
      });
    } else {
      const remote = await unlinkRemoteEvent(raw, event.calendarId);
      await db.$transaction(async (tx) => {
        await tx.taskEventLink.deleteMany({ where: { calendarEventId: id } });
        await tx.calendarEvent.update({ where: { id }, data: { clickupTaskId: null, rawJson: toJson(remote), remoteUpdated: remote.updated ? new Date(remote.updated) : new Date(), syncedAt: new Date() } });
      });
    }
  });
}

export async function completeTask(id: string) {
  return withMutationLock("planner", async () => {
    const task = await db.clickUpTask.findUnique({ where: { id } });
    if (!task) invalid("Tarea no encontrada", 404);
    const currentListId = await assertCurrentTask(task);
    const raw = task.rawJson as { status?: { type?: string } } | null;
    if (!currentListId && process.env.USE_MOCK_DATA !== "true") invalid("La tarea no tiene lista de ClickUp");
    const closedStatus = currentListId ? await getClosedStatus(currentListId) : "complete";
    const remote = await completeRemoteTask(id, closedStatus);
    const nextStatus = typeof remote.status === "object" ? remote.status?.status ?? closedStatus : closedStatus;
    await db.clickUpTask.update({ where: { id }, data: { status: nextStatus, rawJson: toJson(process.env.USE_MOCK_DATA === "true" ? { ...(raw ?? {}), status: { status: nextStatus, type: "closed" } } : remote), remoteUpdated: new Date(), syncedAt: new Date() } });
  });
}
