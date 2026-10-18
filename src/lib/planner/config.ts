export function appTimezone() {
  return process.env.APP_TIMEZONE || "UTC";
}

export function getConfiguredListIds() {
  return [...new Set((process.env.CLICKUP_LIST_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
}

export function getConfiguredCalendarId() {
  return process.env.USE_MOCK_DATA === "true" ? "mock-calendar" : process.env.GOOGLE_CALENDAR_ID || "primary";
}

export function isTaskInScope(task: { listId: string | null } | null) {
  if (!task) return false;
  return process.env.USE_MOCK_DATA === "true"
    ? task.listId === "mock-list"
    : task.listId !== null && task.listId !== "mock-list" && getConfiguredListIds().includes(task.listId);
}

export function isCalendarInScope(id: string) {
  return id === getConfiguredCalendarId();
}

export class ScopeError extends Error {
  readonly status = 403;
}

export function assertTaskInScope(task: { listId: string | null } | null) {
  if (!isTaskInScope(task)) throw new ScopeError("La tarea no pertenece a las listas configuradas");
}

export function assertCalendarInScope(id: string) {
  if (!isCalendarInScope(id)) throw new ScopeError("El evento no pertenece al calendario configurado");
}
