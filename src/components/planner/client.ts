import type { PlannerData } from "@/lib/planner/types";
import { DateTime } from "luxon";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type Validator<T> = (value: unknown) => value is T;
export type MutationResult = { ok: true; warning?: string; clickupSyncPending?: boolean };
export type ScheduleResult = { id: string; clickupSyncPending: boolean; warning?: string; reused?: boolean };
export type SyncResult = { clickup: number; google: number; pending: number; warning?: string };
export type OperationResult = MutationResult | ScheduleResult | SyncResult;

export class PlannerHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "PlannerHttpError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

export function isMutationResult(value: unknown): value is MutationResult {
  return isRecord(value) && value.ok === true && optionalString(value.warning) && optionalBoolean(value.clickupSyncPending);
}

export function isScheduleResult(value: unknown): value is ScheduleResult {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0
    && typeof value.clickupSyncPending === "boolean" && optionalString(value.warning) && optionalBoolean(value.reused);
}

export function isSyncResult(value: unknown): value is SyncResult {
  return isRecord(value) && typeof value.clickup === "number" && typeof value.google === "number"
    && typeof value.pending === "number" && optionalString(value.warning);
}

export function isPlannerData(value: unknown): value is PlannerData {
  if (!isRecord(value) || typeof value.timezone !== "string" || typeof value.mockMode !== "boolean"
    || !DateTime.now().setZone(value.timezone).isValid
    || !nullableString(value.defaultAssigneeId) || !nullableString(value.lastSyncAt)
    || !Array.isArray(value.tasks) || !Array.isArray(value.events)) return false;
  const tasksValid = value.tasks.every((task) => isRecord(task) && typeof task.id === "string"
    && typeof task.title === "string" && typeof task.completed === "boolean" && typeof task.plannedCount === "number"
    && [task.status, task.priority, task.dueDate, task.createdAt, task.url, task.description, task.actionUrl].every(nullableString)
    && (task.estimateMin === null || typeof task.estimateMin === "number") && Array.isArray(task.assignees)
    && task.assignees.every((person) => isRecord(person) && typeof person.id === "string"
      && typeof person.name === "string" && nullableString(person.avatarUrl)));
  const eventsValid = value.events.every((event) => isRecord(event) && typeof event.id === "string"
    && typeof event.calendarId === "string" && typeof event.title === "string" && typeof event.startAt === "string"
    && typeof event.endAt === "string" && Number.isFinite(Date.parse(event.startAt)) && Number.isFinite(Date.parse(event.endAt))
    && typeof event.allDay === "boolean" && typeof event.plannerOwned === "boolean" && typeof event.recurring === "boolean"
    && [event.startDate, event.endDate, event.clickupTaskId].every(nullableString));
  return tasksValid && eventsValid;
}

/** A full page load on purpose: it drops all client state once the session is gone. */
export function goToLogin() {
  if (typeof window === "undefined") return;
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.href = "/login";
}

export async function requestJson<T>(url: string, init: RequestInit, validate: Validator<T>, fetcher: Fetcher = fetch): Promise<T> {
  let response: Response;
  try { response = await fetcher(url, { ...init, cache: "no-store" }); }
  catch { throw new Error("No se pudo conectar. Intenta de nuevo."); }
  let data: unknown;
  try { data = await response.json(); }
  catch {
    if (!response.ok) throw new PlannerHttpError(response.status, "No se pudo completar la solicitud. Intenta de nuevo.");
    throw new Error("No se pudo leer la respuesta. Intenta de nuevo.");
  }
  if (response.status === 401) goToLogin();
  if (!response.ok) {
    throw new PlannerHttpError(response.status, isRecord(data) && typeof data.error === "string" ? data.error : "No se pudo completar la solicitud. Intenta de nuevo.");
  }
  if (!validate(data)) throw new Error("No se pudo leer la respuesta. Intenta de nuevo.");
  return data;
}

export function jsonRequest(method: string, body?: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

export function persistCalendarEdit(
  edit: { id: string; startAt: string; endAt: string },
  revert: () => void,
  run: (operation: () => Promise<MutationResult>) => Promise<boolean>,
  fetcher: Fetcher = fetch,
) {
  // Clear FullCalendar's optimistic state before the refresh applies the remote result.
  revert();
  return run(() => requestJson("/api/planner/events", jsonRequest("PATCH", edit), isMutationResult, fetcher));
}

type PendingScheduleStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const PENDING_SCHEDULES_KEY = "clickup-planner:pending-schedules";

function browserSessionStorage(): PendingScheduleStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; }
  catch { return undefined; }
}

export function createScheduleClient(fetcher: Fetcher = fetch, makeKey = () => crypto.randomUUID(), storage = browserSessionStorage()) {
  const pendingKeys = new Map<string, string>();
  try {
    const raw = storage?.getItem(PENDING_SCHEDULES_KEY);
    const entries: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(entries)) for (const entry of entries) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string" && entry[1]) {
        pendingKeys.set(entry[0], entry[1]);
      }
    }
  } catch { /* An unavailable or invalid session store leaves in-memory retries usable. */ }
  function persistPending() {
    try {
      if (pendingKeys.size) storage?.setItem(PENDING_SCHEDULES_KEY, JSON.stringify([...pendingKeys]));
      else storage?.removeItem(PENDING_SCHEDULES_KEY);
    } catch { /* Browser storage can be disabled; the current page keeps its retry keys. */ }
  }
  return {
    async schedule(taskId: string, startAt: string): Promise<ScheduleResult> {
      const signature = JSON.stringify([taskId, startAt]);
      const key = pendingKeys.get(signature) ?? makeKey();
      pendingKeys.set(signature, key);
      persistPending();
      try {
        const result = await requestJson("/api/planner/events", {
          ...jsonRequest("POST", { taskId, startAt }),
          headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        }, isScheduleResult, fetcher);
        pendingKeys.delete(signature);
        persistPending();
        return result;
      } catch (error) {
        if (error instanceof PlannerHttpError && [409, 410].includes(error.status)) {
          pendingKeys.delete(signature);
          persistPending();
        }
        throw error;
      }
    },
  };
}

export function createOperationRunner() {
  let active = false;
  return {
    async run<T extends OperationResult>(operation: () => Promise<T>, refresh: () => Promise<void>) {
      if (active) return null;
      active = true;
      let result: T | undefined;
      let error: string | null = null;
      try {
        try { result = await operation(); }
        catch (cause) { error = cause instanceof Error ? cause.message : "Ocurrió un error al guardar el cambio."; }
        try { await refresh(); }
        catch {
          if (!error) error = result
            ? "Se guardó el cambio, pero no se pudo actualizar el calendario. Vuelve a sincronizar."
            : "No se pudo actualizar el calendario. Intenta de nuevo.";
        }
        return { saved: result !== undefined, result, error };
      } finally { active = false; }
    },
  };
}
