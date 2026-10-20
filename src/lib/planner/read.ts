import { db } from "@/lib/db/client";
import type { PlannerAssignee, PlannerData } from "./types";
import { isTaskInScope, userTaskWhere, type UserContext } from "./config";
import { expandCalendarEvents } from "../google/recurrences";

function taskAssignees(rawJson: unknown): PlannerAssignee[] {
  if (!rawJson || typeof rawJson !== "object" || !("assignees" in rawJson) || !Array.isArray(rawJson.assignees)) return [];
  return rawJson.assignees.flatMap((value: unknown) => {
    if (!value || typeof value !== "object" || !("id" in value)) return [];
    const user = value as { id: unknown; username?: unknown; profilePicture?: unknown };
    if (typeof user.id !== "string" && typeof user.id !== "number") return [];
    const id = String(user.id);
    const avatarUrl = typeof user.profilePicture === "string" && user.profilePicture.startsWith("https://attachments.clickup.com/") ? user.profilePicture : null;
    return [{ id, name: typeof user.username === "string" ? user.username : `Usuario ${id}`, avatarUrl }];
  });
}

function taskDetails(rawJson: unknown) {
  const raw = rawJson && typeof rawJson === "object" && !Array.isArray(rawJson) ? rawJson as { text_content?: unknown; description?: unknown; date_created?: unknown } : null;
  const text = typeof raw?.text_content === "string" ? raw.text_content : typeof raw?.description === "string" ? raw.description : "";
  const actionUrl = text.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[),.;]+$/, "") ?? null;
  const created = typeof raw?.date_created === "string" || typeof raw?.date_created === "number" ? Number(raw.date_created) : NaN;
  return { description: text.replace(/\s+/g, " ").trim().slice(0, 300) || null, actionUrl, createdAt: Number.isFinite(created) && created > 0 ? new Date(created).toISOString() : null };
}

export async function readPlanner(ctx: UserContext, range?: { startAt: Date; endAt: Date }): Promise<PlannerData> {
  const startAt = range?.startAt ?? new Date(Date.now() - 14 * 86400000);
  const endAt = range?.endAt ?? new Date(Date.now() + 14 * 86400000);
  const [cachedTasks, events, syncStates] = await Promise.all([
    db.clickUpTask.findMany({ where: userTaskWhere(ctx), orderBy: [{ status: "asc" }, { dueDate: "asc" }, { title: "asc" }] }),
    // Masters and original-time exceptions may start outside the requested range.
    // Read the selected calendar cache once and expand only the visible range.
    db.calendarEvent.findMany({ where: { userId: ctx.userId, calendarId: ctx.calendarId }, orderBy: { startAt: "asc" } }),
    db.syncState.findMany({ where: { userId: ctx.userId, id: { in: ctx.mock ? ["mock"] : [`google:${ctx.calendarId}`, "clickup"] } }, orderBy: { lastSyncAt: "desc" }, take: 1 }),
  ]);
  // Settings changes take effect immediately: membership says the user's token saw the task, scope says it is theirs.
  const tasks = cachedTasks.filter((task) => isTaskInScope(ctx, task));
  const links = await db.taskEventLink.findMany({ where: {
    userId: ctx.userId, clickupTaskId: { in: tasks.map((task) => task.id) }, calendarEventId: { in: events.map((event) => event.id) },
  } });
  const counts = new Map<string, number>();
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const nextEvent = new Map<string, { id: string; startAt: Date }>();
  const now = Date.now();
  for (const link of links) {
    counts.set(link.clickupTaskId, (counts.get(link.clickupTaskId) ?? 0) + 1);
    const event = eventsById.get(link.calendarEventId);
    if (!event) continue;
    const current = nextEvent.get(link.clickupTaskId);
    const upcoming = event.startAt.getTime() >= now;
    const currentUpcoming = current ? current.startAt.getTime() >= now : false;
    if (!current || (upcoming && (!currentUpcoming || event.startAt < current.startAt)) || (!upcoming && !currentUpcoming && event.startAt > current.startAt)) {
      nextEvent.set(link.clickupTaskId, { id: event.id, startAt: event.startAt });
    }
  }
  return {
    tasks: tasks.map((task) => ({
      id: task.id, title: task.title, status: task.status, priority: task.priority,
      dueDate: task.dueDate?.toISOString() ?? null, estimateMin: task.estimateMin,
      url: task.url, ...taskDetails(task.rawJson), plannedCount: counts.get(task.id) ?? 0,
      plannedEvent: nextEvent.has(task.id) ? { id: nextEvent.get(task.id)!.id, startAt: nextEvent.get(task.id)!.startAt.toISOString() } : null,
      completed: (typeof task.rawJson === "object" && task.rawJson !== null && !Array.isArray(task.rawJson) && typeof task.rawJson.status === "object" && task.rawJson.status !== null && !Array.isArray(task.rawJson.status) && task.rawJson.status.type === "closed") || /^(complete|completed|done|closed|terminad|completad)/i.test(task.status ?? ""),
      assignees: taskAssignees(task.rawJson),
    })),
    events: expandCalendarEvents(events, { startAt, endAt }),
    mockMode: ctx.mock,
    timezone: ctx.timezone,
    defaultAssigneeId: ctx.clickupUserId,
    lastSyncAt: syncStates[0]?.lastSyncAt?.toISOString() ?? null,
  };
}
