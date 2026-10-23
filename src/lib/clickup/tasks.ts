import { getCredential, markRevoked } from "@/lib/auth/credentials";
import type { UserContext } from "@/lib/planner/config";
import { HttpError, ReconnectRequiredError } from "@/lib/planner/http";
import { ProviderHttpError, ProviderPayloadError, record, requestJson } from "@/lib/providers/http";

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

const CLICKUP_API = "https://api.clickup.com/api/v2";

async function clickupToken(userId: string) {
  const credential = await getCredential(userId, "clickup");
  if (!credential || credential.revokedAt || !credential.accessToken) throw new ReconnectRequiredError("clickup");
  return credential.scheme === "bearer" ? `Bearer ${credential.accessToken}` : credential.accessToken;
}

/** Every call uses the token of the user it is made for, never anyone else's. */
async function clickupRequest(ctx: UserContext, path: string, init: RequestInit = {}, retrySafe = true) {
  try {
    return await requestJson("ClickUp", `${CLICKUP_API}${path}`, {
      ...init, headers: { Authorization: await clickupToken(ctx.userId), "Content-Type": "application/json", ...init.headers },
    }, { retrySafe });
  } catch (error) {
    if (error instanceof ProviderHttpError && error.upstreamStatus === 401) {
      await markRevoked(ctx.userId, "clickup");
      throw new ReconnectRequiredError("clickup");
    }
    throw error;
  }
}

/** Validates a personal token against GET /user and returns the identity it belongs to. */
export async function fetchClickUpIdentity(token: string) {
  let body: unknown;
  try {
    body = await requestJson("ClickUp", `${CLICKUP_API}/user`, { headers: { Authorization: token, "Content-Type": "application/json" } });
  } catch (error) {
    if (error instanceof ProviderHttpError && [400, 401, 403].includes(error.upstreamStatus)) throw new HttpError(400, "ClickUp rechazó el token. Revisa que sea tu token personal.");
    throw error;
  }
  const user = record(body) && record(body.user) ? body.user : null;
  const id = user && (typeof user.id === "number" || typeof user.id === "string") ? String(user.id) : "";
  if (!user || !/^\d{1,20}$/.test(id)) throw new ProviderPayloadError("ClickUp", "usuario");
  return { clickupUserId: id, username: typeof user.username === "string" ? user.username.slice(0, 200) : null };
}

/** Full per-list snapshots reconcile deletions/moves and include newly added lists.
 * This MVP deliberately pays one request per 100 tasks/list rather than inferring
 * deletion from an incremental response. No cache is removed until every page succeeds.
 */
export async function listRemoteTasks(ctx: UserContext) {
  const listIds = ctx.listIds;
  if (!listIds.length && !ctx.clickupUserId) throw new HttpError(409, "Configura tus listas de ClickUp en Ajustes para sincronizar tareas");
  const tasks = new Map<string, RemoteClickUpTask>();
  for (const listId of listIds) {
    let complete = false;
    for (let page = 0; page < 1000; page++) {
      const query = new URLSearchParams({ page: String(page), include_closed: "true", subtasks: "true", order_by: "updated" });
      const result = await clickupRequest(ctx, `/list/${encodeURIComponent(listId)}/task?${query}`);
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
  const me = ctx.clickupUserId;
  if (me) {
    const teams = await clickupRequest(ctx, "/team");
    if (!record(teams) || !Array.isArray(teams.teams)) throw new ProviderPayloadError("ClickUp", "equipos");
    for (const team of teams.teams) {
      if (!record(team) || typeof team.id !== "string") throw new ProviderPayloadError("ClickUp", "equipo");
      let complete = false;
      for (let page = 0; page < 1000; page++) {
        const query = new URLSearchParams({ page: String(page), include_closed: "true", subtasks: "true", order_by: "updated" });
        query.append("assignees[]", me);
        const result = await clickupRequest(ctx, `/team/${encodeURIComponent(team.id)}/task?${query}`);
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

export async function getRemoteTask(ctx: UserContext, id: string): Promise<RemoteClickUpTask | null> {
  try { return validateTask(await clickupRequest(ctx, `/task/${encodeURIComponent(id)}`)); }
  catch (error) {
    if (error instanceof ProviderHttpError && [404, 410].includes(error.upstreamStatus)) return null;
    throw error;
  }
}

export async function createRemoteTask(ctx: UserContext, listId: string, name: string, assigneeId: string | null) {
  if (ctx.mock) {
    return { id: `mock-task-${crypto.randomUUID()}`, name, status: { status: "0. backlog", type: "open" }, list: { id: listId }, date_updated: String(Date.now()), date_created: String(Date.now()) } as RemoteClickUpTask;
  }
  const body: Record<string, unknown> = { name };
  if (assigneeId && /^\d+$/.test(assigneeId)) body.assignees = [Number(assigneeId)];
  return validateTask(await clickupRequest(ctx, `/list/${encodeURIComponent(listId)}/task`, { method: "POST", body: JSON.stringify(body) }, false));
}

export async function completeRemoteTask(ctx: UserContext, id: string, status: string) {
  if (ctx.mock) return { status: { status } };
  return validateTask(await clickupRequest(ctx, `/task/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ status }) }));
}

export async function archiveRemoteTask(ctx: UserContext, id: string, archived = true) {
  if (ctx.mock) return;
  await clickupRequest(ctx, `/task/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ archived }) });
}

export async function updateRemoteTaskDueDate(ctx: UserContext, id: string, dueAt: Date) {
  if (ctx.mock) return { id, due_date: String(dueAt.getTime()), date_updated: String(Date.now()) };
  return validateTask(await clickupRequest(ctx, `/task/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ due_date: dueAt.getTime(), due_date_time: true }) }));
}

export async function createRemoteTaskComment(ctx: UserContext, id: string, comment: string) {
  if (ctx.mock) return { id: `mock-comment-${crypto.randomUUID()}` };
  const result = await clickupRequest(ctx, `/task/${encodeURIComponent(id)}/comment`, { method: "POST", body: JSON.stringify({ comment_text: comment, notify_all: false }) }, false);
  if (!record(result) || !((typeof result.id === "string" && result.id) || (typeof result.id === "number" && Number.isFinite(result.id)))) throw new ProviderPayloadError("ClickUp", "ID del comentario");
  return { id: String(result.id) };
}

export async function getClosedStatus(ctx: UserContext, listId: string) {
  if (ctx.mock) return "complete";
  const list = await clickupRequest(ctx, `/list/${encodeURIComponent(listId)}`);
  if (!record(list) || !Array.isArray(list.statuses) || !list.statuses.every((item) => record(item) && typeof item.status === "string" && (item.type === undefined || typeof item.type === "string"))) throw new ProviderPayloadError("ClickUp", "estados de lista");
  const closed = list.statuses.find((item) => item.type === "closed");
  if (!closed) throw new Error("La lista de ClickUp no tiene un estado cerrado");
  return closed.status as string;
}
