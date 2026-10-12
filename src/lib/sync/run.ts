import { db } from "@/lib/db/client";
import { toJson } from "@/lib/db/json";
import { listRemoteTasks } from "@/lib/clickup/tasks";
import { calendarId, listRemoteEvents } from "@/lib/google/calendar";

function fromMillis(value?: string | null) {
  return value && Number.isFinite(Number(value)) ? new Date(Number(value)) : null;
}

export async function syncClickUp() {
  if (process.env.USE_MOCK_DATA === "true") return 0;
  const state = await db.syncState.findUnique({ where: { id: "clickup" } });
  const started = new Date();
  const tasks = await listRemoteTasks(state?.lastSyncAt ?? undefined);
  for (const task of tasks) {
    const updated = fromMillis(task.date_updated);
    const existing = await db.clickUpTask.findUnique({ where: { id: task.id } });
    if (updated && existing?.remoteUpdated && updated < existing.remoteUpdated) continue;
    await db.clickUpTask.upsert({
      where: { id: task.id },
      create: {
        id: task.id, title: task.name, status: task.status?.status, priority: task.priority?.priority,
        dueDate: fromMillis(task.due_date), estimateMin: task.time_estimate ? Math.ceil(task.time_estimate / 60000) : null,
        url: task.url, listId: task.list?.id, rawJson: toJson(task), remoteUpdated: updated, syncedAt: new Date(),
      },
      update: {
        title: task.name, status: task.status?.status, priority: task.priority?.priority,
        dueDate: fromMillis(task.due_date), estimateMin: task.time_estimate ? Math.ceil(task.time_estimate / 60000) : null,
        url: task.url, listId: task.list?.id, rawJson: toJson(task), remoteUpdated: updated, syncedAt: new Date(),
      },
    });
  }
  await db.syncState.upsert({ where: { id: "clickup" }, create: { id: "clickup", source: "clickup", lastSyncAt: started, cursor: started.toISOString() }, update: { lastSyncAt: started, cursor: started.toISOString() } });
  return tasks.length;
}

export async function syncGoogle() {
  if (process.env.USE_MOCK_DATA === "true") return 0;
  const id = `google:${calendarId()}`;
  const state = await db.syncState.findUnique({ where: { id } });
  let result;
  try {
    result = await listRemoteEvents(state?.cursor ?? undefined);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Google Calendar API 410")) throw error;
    result = await listRemoteEvents();
  }
  for (const event of result.items) {
    if (!event.id) continue;
    if (event.status === "cancelled") {
      await db.$transaction(async (tx) => {
        await tx.taskEventLink.deleteMany({ where: { calendarEventId: event.id } });
        await tx.calendarEvent.deleteMany({ where: { id: event.id } });
      });
      continue;
    }
    const start = event.start?.dateTime ?? event.start?.date;
    const end = event.end?.dateTime ?? event.end?.date;
    if (!start || !end) continue;
    const privateProperties = event.extendedProperties?.private;
    const taskId = privateProperties?.plannerLinkedClickupTaskId ?? (privateProperties?.source === "planner" ? privateProperties.clickupTaskId : null);
    const updated = event.updated ? new Date(event.updated) : null;
    const existing = await db.calendarEvent.findUnique({ where: { id: event.id } });
    if (updated && existing?.remoteUpdated && updated < existing.remoteUpdated) continue;
    await db.calendarEvent.upsert({
      where: { id: event.id },
      create: { id: event.id, calendarId: calendarId(), title: event.summary ?? "(Sin título)", startAt: new Date(start), endAt: new Date(end), clickupTaskId: taskId, rawJson: toJson(event), remoteUpdated: updated, syncedAt: new Date() },
      update: { title: event.summary ?? "(Sin título)", startAt: new Date(start), endAt: new Date(end), clickupTaskId: taskId, rawJson: toJson(event), remoteUpdated: updated, syncedAt: new Date() },
    });
    await db.taskEventLink.deleteMany({ where: { calendarEventId: event.id, NOT: { clickupTaskId: taskId ?? "" } } });
    if (taskId) await db.taskEventLink.upsert({ where: { clickupTaskId_calendarEventId: { clickupTaskId: taskId, calendarEventId: event.id } }, create: { clickupTaskId: taskId, calendarEventId: event.id }, update: {} });
  }
  await db.syncState.upsert({ where: { id }, create: { id, source: "google", cursor: result.nextSyncToken, lastSyncAt: new Date() }, update: { cursor: result.nextSyncToken, lastSyncAt: new Date() } });
  return result.items.length;
}
