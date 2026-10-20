import { NotFoundError } from "@/lib/planner/http";

/** Everything the planner needs to know about the signed-in user. Built from UserSettings. */
export type UserContext = {
  userId: string;
  calendarId: string;
  listIds: string[];
  timezone: string;
  clickupUserId: string | null;
  mock: boolean;
};

type ScopedTask = { listId: string | null; rawJson?: unknown } | null;

export const MOCK_LIST_ID = "mock-list";
export const MOCK_CALENDAR_ID = "mock-calendar";

export function parseListIds(value: string) {
  return [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
}

export function lockKey(ctx: Pick<UserContext, "userId">) {
  return `planner:${ctx.userId}`;
}

export function isAssignedTo(clickupUserId: string | null, raw: unknown) {
  const assignees = raw && typeof raw === "object" && "assignees" in raw ? (raw as { assignees?: unknown }).assignees : null;
  return !!clickupUserId && Array.isArray(assignees) && assignees.some((person) => person && typeof person === "object" && String((person as { id?: unknown }).id) === clickupUserId);
}

/** In scope: in one of the user's lists or assigned to the user's ClickUp id. */
export function isTaskInScope(ctx: UserContext, task: ScopedTask) {
  if (!task) return false;
  if (ctx.mock) return task.listId === MOCK_LIST_ID;
  if (task.listId === MOCK_LIST_ID) return false;
  return (task.listId !== null && ctx.listIds.includes(task.listId)) || isAssignedTo(ctx.clickupUserId, task.rawJson);
}

/** Prisma filter: only tasks that this user's own ClickUp token has fetched and that they have not archived. */
export function userTaskWhere(ctx: Pick<UserContext, "userId">) {
  return { users: { some: { userId: ctx.userId, archivedAt: null } } };
}

export function assertTaskInScope(ctx: UserContext, task: ScopedTask) {
  if (!isTaskInScope(ctx, task)) throw new NotFoundError("Tarea no encontrada");
}

export function assertCalendarInScope(ctx: UserContext, id: string) {
  if (id !== ctx.calendarId) throw new NotFoundError("Evento no encontrado");
}
