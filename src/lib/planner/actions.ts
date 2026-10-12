import { db } from "@/lib/db/client";
import { appTimezone } from "@/lib/planner/config";
import { toJson } from "@/lib/db/json";
import { createRemoteEvent, deleteRemoteEvent, linkRemoteEvent, unlinkRemoteEvent, updateRemoteEvent, calendarId } from "@/lib/google/calendar";
import type { RemoteCalendarEvent } from "@/lib/google/calendar";
import { completeRemoteTask, createRemoteTaskComment, getClosedStatus, updateRemoteTaskDueDate } from "@/lib/clickup/tasks";

function validDate(value: unknown) {
  if (typeof value !== "string") throw new Error("Fecha inválida");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Fecha inválida");
  return date;
}

export async function scheduleTask(taskId: string, startInput: unknown) {
  const task = await db.clickUpTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error("Tarea no encontrada");
  const startAt = validDate(startInput);
  const duration = task.estimateMin && task.estimateMin > 0 ? task.estimateMin : 30;
  const endAt = new Date(startAt.getTime() + duration * 60000);
  const remote = await createRemoteEvent(task.id, task.title, startAt, endAt);
  if (!remote.id) throw new Error("Google no devolvió el ID del evento");
  await db.$transaction(async (tx) => {
    await tx.calendarEvent.create({ data: {
      id: remote.id, calendarId: calendarId(), title: remote.summary ?? task.title, startAt, endAt,
      clickupTaskId: task.id, rawJson: toJson(remote), remoteUpdated: remote.updated ? new Date(remote.updated) : null,
    } });
    await tx.taskEventLink.create({ data: { clickupTaskId: task.id, calendarEventId: remote.id, clickupSyncPending: true } });
  });
  await syncTaskSchedule(task.id, remote.id);
  return remote.id;
}

function rawEvent(value: unknown, id: string): RemoteCalendarEvent {
  return { ...(value && typeof value === "object" && !Array.isArray(value) ? value : {}), id };
}

export async function linkTaskToEvent(taskId: string, eventId: string) {
  const [task, event] = await Promise.all([
    db.clickUpTask.findUnique({ where: { id: taskId } }),
    db.calendarEvent.findUnique({ where: { id: eventId } }),
  ]);
  if (!task || !event) throw new Error("Tarea o evento no encontrado");
  if (event.clickupTaskId && event.clickupTaskId !== taskId) throw new Error("Este evento ya está vinculado a otra tarea");
  const raw = rawEvent(event.rawJson, event.id);
  if (raw.start?.date) throw new Error("Elige un agendamiento con hora para vincular la tarea");
  if (event.clickupTaskId !== taskId) {
    const remote = await linkRemoteEvent(raw, event.calendarId, taskId);
    await db.$transaction(async (tx) => {
      await tx.calendarEvent.update({ where: { id: eventId }, data: { clickupTaskId: taskId, rawJson: toJson(remote), remoteUpdated: remote.updated ? new Date(remote.updated) : new Date(), syncedAt: new Date() } });
      await tx.taskEventLink.upsert({ where: { clickupTaskId_calendarEventId: { clickupTaskId: taskId, calendarEventId: eventId } }, create: { clickupTaskId: taskId, calendarEventId: eventId, clickupSyncPending: true }, update: { clickupSyncPending: true } });
    });
  }
  await syncTaskSchedule(taskId, eventId);
}

export async function syncTaskSchedule(taskId: string, eventId: string) {
  const [task, event, link] = await Promise.all([
    db.clickUpTask.findUnique({ where: { id: taskId } }),
    db.calendarEvent.findUnique({ where: { id: eventId } }),
    db.taskEventLink.findUnique({ where: { clickupTaskId_calendarEventId: { clickupTaskId: taskId, calendarEventId: eventId } } }),
  ]);
  if (!task || !event || !link || !link.clickupSyncPending) return;
  try {
    if (link.dueSyncedStartAt?.getTime() !== event.startAt.getTime()) {
      const remote = await updateRemoteTaskDueDate(taskId, event.startAt);
      const original = task.rawJson && typeof task.rawJson === "object" && !Array.isArray(task.rawJson) ? task.rawJson : {};
      await db.clickUpTask.update({ where: { id: taskId }, data: {
        dueDate: event.startAt,
        rawJson: toJson({ ...original, ...remote, due_date: String(event.startAt.getTime()) }),
        remoteUpdated: remote.date_updated ? new Date(Number(remote.date_updated)) : new Date(), syncedAt: new Date(),
      } });
      await db.taskEventLink.update({ where: { id: link.id }, data: { dueSyncedStartAt: event.startAt } });
    }
    if (link.commentedStartAt?.getTime() !== event.startAt.getTime()) {
      const timezone = appTimezone();
      const when = new Intl.DateTimeFormat("es", { timeZone: timezone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "numeric", minute: "2-digit" }).format(event.startAt);
      const calendarReference = rawEvent(event.rawJson, event.id).htmlLink ?? event.id;
      await createRemoteTaskComment(taskId, `Agendada para el ${when} (${timezone}). Evento de Google Calendar: ${calendarReference}.`);
      await db.taskEventLink.update({ where: { id: link.id }, data: { commentedStartAt: event.startAt } });
    }
    await db.taskEventLink.update({ where: { id: link.id }, data: { clickupSyncPending: false, clickupSyncError: null } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error al actualizar ClickUp";
    await db.taskEventLink.update({ where: { id: link.id }, data: { clickupSyncError: message } });
    throw new Error(`El bloque quedó guardado en Google Calendar, pero ClickUp sigue pendiente: ${message}`);
  }
}

export async function rescheduleEvent(id: string, startInput: unknown, endInput: unknown) {
  const event = await db.calendarEvent.findUnique({ where: { id } });
  if (!event) throw new Error("Evento no encontrado");
  const startAt = validDate(startInput);
  const endAt = validDate(endInput);
  if (endAt <= startAt) throw new Error("El final debe ser posterior al inicio");
  const remote = await updateRemoteEvent(event.id, event.calendarId, startAt, endAt);
  const rawJson = process.env.USE_MOCK_DATA === "true"
    ? { ...(event.rawJson && typeof event.rawJson === "object" && !Array.isArray(event.rawJson) ? event.rawJson : {}), start: { dateTime: startAt.toISOString() }, end: { dateTime: endAt.toISOString() }, updated: remote.updated }
    : remote;
  await db.calendarEvent.update({ where: { id }, data: { startAt, endAt, rawJson: toJson(rawJson), remoteUpdated: remote.updated ? new Date(remote.updated) : new Date(), syncedAt: new Date() } });
  if (event.clickupTaskId) {
    await db.taskEventLink.updateMany({ where: { calendarEventId: id, clickupTaskId: event.clickupTaskId }, data: { clickupSyncPending: true } });
    await syncTaskSchedule(event.clickupTaskId, id);
  }
}

export async function removeEvent(id: string) {
  const event = await db.calendarEvent.findUnique({ where: { id } });
  if (!event) throw new Error("Evento no encontrado");
  if (!event.clickupTaskId) throw new Error("Este evento no está vinculado a una tarea");
  const raw = rawEvent(event.rawJson, event.id);
  if (raw.extendedProperties?.private?.source === "planner") {
    await deleteRemoteEvent(event.id, event.calendarId);
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
}

export async function completeTask(id: string) {
  const task = await db.clickUpTask.findUnique({ where: { id } });
  if (!task) throw new Error("Tarea no encontrada");
  const raw = task.rawJson as { status?: { type?: string } } | null;
  if (!task.listId && process.env.USE_MOCK_DATA !== "true") throw new Error("La tarea no tiene lista de ClickUp");
  const closedStatus = task.listId ? await getClosedStatus(task.listId) : "complete";
  const remote = await completeRemoteTask(id, closedStatus);
  const nextStatus = typeof remote.status === "object" ? remote.status?.status ?? closedStatus : closedStatus;
  await db.clickUpTask.update({ where: { id }, data: { status: nextStatus, rawJson: toJson(process.env.USE_MOCK_DATA === "true" ? { ...(raw ?? {}), status: { status: nextStatus, type: "closed" } } : remote), remoteUpdated: new Date(), syncedAt: new Date() } });
}
