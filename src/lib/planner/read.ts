import { db } from "@/lib/db/client";
import type { PlannerAssignee, PlannerData } from "./types";
import { appTimezone } from "./config";

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

export async function readPlanner(range?: { startAt: Date; endAt: Date }): Promise<PlannerData> {
  const defaultAssigneeId = process.env.CLICKUP_DEFAULT_ASSIGNEE_ID || null;
  const startAt = range?.startAt ?? new Date(Date.now() - 14 * 86400000);
  const endAt = range?.endAt ?? new Date(Date.now() + 14 * 86400000);
  // Date-only Google events are cached at UTC midnight; widen the range for local time zones.
  const queryStart = new Date(startAt.getTime() - 86400000);
  const queryEnd = new Date(endAt.getTime() + 86400000);
  const [tasks, events, links, syncStates] = await Promise.all([
    db.clickUpTask.findMany({ where: process.env.USE_MOCK_DATA === "true" ? undefined : { NOT: { listId: "mock-list" } }, orderBy: [{ status: "asc" }, { dueDate: "asc" }, { title: "asc" }] }),
    db.calendarEvent.findMany({ where: { AND: [
      process.env.USE_MOCK_DATA === "true" ? {} : { NOT: { id: { startsWith: "mock-" } } },
      { startAt: { lt: queryEnd }, endAt: { gt: queryStart } },
    ] }, orderBy: { startAt: "asc" } }),
    db.taskEventLink.findMany(),
    db.syncState.findMany({ orderBy: { lastSyncAt: "desc" }, take: 1 }),
  ]);
  const counts = new Map<string, number>();
  for (const link of links) counts.set(link.clickupTaskId, (counts.get(link.clickupTaskId) ?? 0) + 1);
  return {
    tasks: tasks.map((task) => ({
      id: task.id, title: task.title, status: task.status, priority: task.priority,
      dueDate: task.dueDate?.toISOString() ?? null, estimateMin: task.estimateMin,
      url: task.url, ...taskDetails(task.rawJson), plannedCount: counts.get(task.id) ?? 0,
      completed: (typeof task.rawJson === "object" && task.rawJson !== null && !Array.isArray(task.rawJson) && typeof task.rawJson.status === "object" && task.rawJson.status !== null && !Array.isArray(task.rawJson.status) && task.rawJson.status.type === "closed") || /^(complete|completed|done|closed|terminad|completad)/i.test(task.status ?? ""),
      assignees: taskAssignees(task.rawJson),
    })),
    events: events.map((event) => {
      const raw = event.rawJson as { start?: { date?: unknown }; end?: { date?: unknown }; extendedProperties?: { private?: { source?: string } } } | null;
      const startDate = typeof raw?.start?.date === "string" ? raw.start.date : null;
      const endDate = typeof raw?.end?.date === "string" ? raw.end.date : null;
      return {
        id: event.id, calendarId: event.calendarId, title: event.title,
        startAt: event.startAt.toISOString(), endAt: event.endAt.toISOString(),
        allDay: Boolean(startDate && endDate), startDate, endDate,
        clickupTaskId: event.clickupTaskId,
        plannerOwned: raw?.extendedProperties?.private?.source === "planner",
      };
    }),
    mockMode: process.env.USE_MOCK_DATA === "true",
    timezone: appTimezone(),
    defaultAssigneeId,
    lastSyncAt: syncStates[0]?.lastSyncAt?.toISOString() ?? null,
  };
}
