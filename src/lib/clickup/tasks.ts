import { db } from "@/lib/db/client";
import { getConfiguredListIds, getDefaultAssigneeId } from "@/lib/planner/config";
import { ProviderHttpError, ProviderPayloadError, record, requestJson } from "../providers/http";

export type RemoteClickUpTask = {
  id: string; name: string; status?: { status?: string; type?: string }; priority?: { priority?: string } | null;
  due_date?: string | null; time_estimate?: number | null; url?: string; list?: { id?: string };
  date_updated?: string; [key: string]: unknown;
};

function validMillis(value: unknown) {
  return typeof value === "string" && /^\d+$/.test(value) && Number.isFinite(new Date(Number(value)).getTime());
}

function validateTask(value: unknown): RemoteClickUpTask {
  if (!record(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string" || !record(value.list) || typeof value.list.id !== "string" || !value.list.id) throw new ProviderPayloadError("ClickUp", "tarea o lista");
  for (const key of ["due_date", "date_updated"] as const) {
    if (value[key] !== undefined && value[key] !== null && !validMillis(value[key])) throw new ProviderPayloadError("ClickUp", `fecha ${key}`);
  }
  if (value.time_estimate !== undefined && value.time_estimate !== null && (typeof value.time_estimate !== "number" || !Number.isFinite(value.time_estimate) || value.time_estimate < 0)) throw new ProviderPayloadError("ClickUp", "estimación");
  for (const key of ["status", "priority"] as const) {
    if (value[key] !== undefined && value[key] !== null) {
      if (!record(value[key]) || (value[key][key] !== undefined && typeof value[key][key] !== "string") || (key === "status" && value[key].type !== undefined && typeof value[key].type !== "string")) throw new ProviderPayloadError("ClickUp", key);
    }
  }
  if (value.url !== undefined && typeof value.url !== "string") throw new ProviderPayloadError("ClickUp", "URL");
  return value as RemoteClickUpTask;
}

async function clickupToken() {
  if (process.env.CLICKUP_TOKEN) return process.env.CLICKUP_TOKEN;
  const credential = await db.oAuthCredential.findUnique({ where: { provider: "clickup" } });
  if (!credential) throw new Error("ClickUp no está conectado");
  return `Bearer ${credential.accessToken}`;
}

async function clickupRequest(path: string, init: RequestInit = {}, retrySafe = true) {
  return requestJson("ClickUp", `https://api.clickup.com/api/v2${path}`, {
    ...init, headers: { Authorization: await clickupToken(), "Content-Type": "application/json", ...init.headers },
  }, { retrySafe });
}

/** Full per-list snapshots reconcile deletions/moves and include newly added lists.
 * This MVP deliberately pays one request per 100 tasks/list rather than inferring
 * deletion from an incremental response. No cache is removed until every page succeeds.
 */
export async function listRemoteTasks(updatedAfter?: Date) {
  void updatedAfter; // Full snapshots intentionally supersede legacy delta cursors.
  const listIds = getConfiguredListIds();
  if (!listIds.length && !getDefaultAssigneeId()) throw new Error("Configura CLICKUP_LIST_IDS para sincronizar tareas");
  const tasks = new Map<string, RemoteClickUpTask>();
  for (const listId of listIds) {
    let complete = false;
    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({ page: String(page), include_closed: "true", subtasks: "true", order_by: "updated" });
      const result = await clickupRequest(`/list/${encodeURIComponent(listId)}/task?${query}`);
      if (!record(result) || !Array.isArray(result.tasks) || (result.last_page !== undefined && typeof result.last_page !== "boolean")) throw new ProviderPayloadError("ClickUp", "página de tareas");
      for (const value of result.tasks) {
        const task = validateTask(value);
        const previous = tasks.get(task.id);
        if (!previous || Number(task.date_updated ?? 0) >= Number(previous.date_updated ?? 0)) tasks.set(task.id, task);
      }
      if (result.last_page === true || (result.last_page === undefined && result.tasks.length < 100)) { complete = true; break; }
    }
    if (!complete) throw new ProviderPayloadError("ClickUp", "paginación excesiva");
  }
  const me = getDefaultAssigneeId();
  if (me) {
    const teams = await clickupRequest("/team");
    if (!record(teams) || !Array.isArray(teams.teams)) throw new ProviderPayloadError("ClickUp", "equipos");
    for (const team of teams.teams) {
      if (!record(team) || typeof team.id !== "string") throw new ProviderPayloadError("ClickUp", "equipo");
      let complete = false;
      for (let page = 0; page < 1000; page++) {
        const query = new URLSearchParams({ page: String(page), include_closed: "true", subtasks: "true", order_by: "updated" });
        query.append("assignees[]", me);
        const result = await clickupRequest(`/team/${encodeURIComponent(team.id)}/task?${query}`);
        if (!record(result) || !Array.isArray(result.tasks) || (result.last_page !== undefined && typeof result.last_page !== "boolean")) throw new ProviderPayloadError("ClickUp", "página de tareas asignadas");
        for (const value of result.tasks) {
          const task = validateTask(value);
          const previous = tasks.get(task.id);
          if (!previous || Number(task.date_updated ?? 0) >= Number(previous.date_updated ?? 0)) tasks.set(task.id, task);
        }
        if (result.last_page === true || (result.last_page === undefined && result.tasks.length < 100)) { complete = true; break; }
      }
      if (!complete) throw new ProviderPayloadError("ClickUp", "paginación excesiva");
    }
  }
  return [...tasks.values()];
}

export async function getRemoteTask(id: string): Promise<RemoteClickUpTask | null> {
  try { return validateTask(await clickupRequest(`/task/${encodeURIComponent(id)}`)); }
  catch (error) {
    if (error instanceof ProviderHttpError && [404, 410].includes(error.upstreamStatus)) return null;
    throw error;
  }
}

export async function completeRemoteTask(id: string, status: string) {
  if (process.env.USE_MOCK_DATA === "true") return { status: { status } };
  return validateTask(await clickupRequest(`/task/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ status }) }));
}

export async function archiveRemoteTask(id: string, archived = true) {
  if (process.env.USE_MOCK_DATA === "true") return;
  await clickupRequest(`/task/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ archived }) });
}

export async function updateRemoteTaskDueDate(id: string, dueAt: Date) {
  if (process.env.USE_MOCK_DATA === "true") return { id, due_date: String(dueAt.getTime()), date_updated: String(Date.now()) };
  return validateTask(await clickupRequest(`/task/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ due_date: dueAt.getTime(), due_date_time: true }) }));
}

export async function createRemoteTaskComment(id: string, comment: string) {
  if (process.env.USE_MOCK_DATA === "true") return { id: `mock-comment-${crypto.randomUUID()}` };
  const result = await clickupRequest(`/task/${encodeURIComponent(id)}/comment`, { method: "POST", body: JSON.stringify({ comment_text: comment, notify_all: false }) }, false);
  if (!record(result) || !((typeof result.id === "string" && result.id) || (typeof result.id === "number" && Number.isFinite(result.id)))) throw new ProviderPayloadError("ClickUp", "ID del comentario");
  return { id: String(result.id) };
}

export async function getClosedStatus(listId: string) {
  if (process.env.USE_MOCK_DATA === "true") return "complete";
  const list = await clickupRequest(`/list/${encodeURIComponent(listId)}`);
  if (!record(list) || !Array.isArray(list.statuses) || !list.statuses.every((item) => record(item) && typeof item.status === "string" && (item.type === undefined || typeof item.type === "string"))) throw new ProviderPayloadError("ClickUp", "estados de lista");
  const closed = list.statuses.find((item) => item.type === "closed");
  if (!closed) throw new Error("La lista de ClickUp no tiene un estado cerrado");
  return closed.status as string;
}
