export function appTimezone() {
  return process.env.APP_TIMEZONE || "UTC";
}

export function getConfiguredListIds() {
  return [...new Set((process.env.CLICKUP_LIST_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
}

export function getConfiguredCalendarId() {
  return process.env.USE_MOCK_DATA === "true" ? "mock-calendar" : process.env.GOOGLE_CALENDAR_ID || "primary";
}

export function getDefaultAssigneeId() {
  return process.env.CLICKUP_DEFAULT_ASSIGNEE_ID?.trim() || null;
}

export function isAssignedToDefault(raw: unknown) {
  const me = getDefaultAssigneeId();
  const assignees = raw && typeof raw === "object" && "assignees" in raw ? (raw as { assignees?: unknown }).assignees : null;
  return !!me && Array.isArray(assignees) && assignees.some((person) => person && typeof person === "object" && String((person as { id?: unknown }).id) === me);
}

/** Prisma filter for tasks in configured lists or assigned to the default assignee. */
export function taskScopeWhere() {
  return process.env.USE_MOCK_DATA === "true"
    ? { listId: "mock-list" }
    : { OR: [{ listId: { in: getConfiguredListIds() } }, { assignedToMe: true }] };
}

export function isTaskInScope(task: { listId: string | null; assignedToMe?: boolean; rawJson?: unknown } | null) {
  if (!task) return false;
  if (process.env.USE_MOCK_DATA === "true") return task.listId === "mock-list";
  if (task.listId === "mock-list") return false;
  return (task.listId !== null && getConfiguredListIds().includes(task.listId)) || task.assignedToMe === true || isAssignedToDefault(task.rawJson);
}

export function isCalendarInScope(id: string) {
  return id === getConfiguredCalendarId();
}

export class ScopeError extends Error {
  readonly status = 403;
}

export function assertTaskInScope(task: { listId: string | null; assignedToMe?: boolean; rawJson?: unknown } | null) {
  if (!isTaskInScope(task)) throw new ScopeError("La tarea no está en las listas configuradas ni asignada a ti");
}

export function assertCalendarInScope(id: string) {
  if (!isCalendarInScope(id)) throw new ScopeError("El evento no pertenece al calendario configurado");
}
