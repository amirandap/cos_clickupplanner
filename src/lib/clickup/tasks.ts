import { db } from "@/lib/db/client";

export type RemoteClickUpTask = {
  id: string; name: string; status?: { status?: string; type?: string }; priority?: { priority?: string } | null;
  due_date?: string | null; time_estimate?: number | null; url?: string; list?: { id?: string };
  date_updated?: string; [key: string]: unknown;
};

async function clickupToken() {
  if (process.env.CLICKUP_TOKEN) return process.env.CLICKUP_TOKEN;
  const credential = await db.oAuthCredential.findUnique({ where: { provider: "clickup" } });
  if (!credential) throw new Error("ClickUp no está conectado");
  return `Bearer ${credential.accessToken}`;
}

async function clickupRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.clickup.com/api/v2${path}`, {
    ...init, headers: { Authorization: await clickupToken(), "Content-Type": "application/json", ...init.headers }, cache: "no-store",
  });
  if (!response.ok) throw new Error(`ClickUp API ${response.status}: ${(await response.text()).slice(0, 240)}`);
  return response.json() as Promise<T>;
}

export async function listRemoteTasks(updatedAfter?: Date) {
  const listIds = (process.env.CLICKUP_LIST_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!listIds.length) throw new Error("Configura CLICKUP_LIST_IDS para sincronizar tareas");
  const tasks: RemoteClickUpTask[] = [];
  for (const listId of listIds) {
    for (let page = 0; ; page++) {
      const query = new URLSearchParams({ page: String(page), include_closed: "true", order_by: "updated" });
      if (updatedAfter) query.set("date_updated_gt", String(updatedAfter.getTime() - 1000));
      const result = await clickupRequest<{ tasks: RemoteClickUpTask[] }>(`/list/${encodeURIComponent(listId)}/task?${query}`);
      tasks.push(...result.tasks);
      if (result.tasks.length < 100) break;
    }
  }
  return tasks;
}

export async function completeRemoteTask(id: string, status: string) {
  if (process.env.USE_MOCK_DATA === "true") return { status: { status } };
  return clickupRequest<RemoteClickUpTask>(`/task/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ status }) });
}

export async function updateRemoteTaskDueDate(id: string, dueAt: Date) {
  if (process.env.USE_MOCK_DATA === "true") return { id, due_date: String(dueAt.getTime()), date_updated: String(Date.now()) } as RemoteClickUpTask;
  return clickupRequest<RemoteClickUpTask>(`/task/${encodeURIComponent(id)}`, {
    method: "PUT", body: JSON.stringify({ due_date: dueAt.getTime(), due_date_time: true }),
  });
}

export async function createRemoteTaskComment(id: string, comment: string) {
  if (process.env.USE_MOCK_DATA === "true") return { id: `mock-comment-${crypto.randomUUID()}` };
  return clickupRequest<{ id: string }>(`/task/${encodeURIComponent(id)}/comment`, {
    method: "POST", body: JSON.stringify({ comment_text: comment, notify_all: false }),
  });
}

export async function getClosedStatus(listId: string) {
  if (process.env.USE_MOCK_DATA === "true") return "complete";
  const list = await clickupRequest<{ statuses?: { status: string; type?: string }[] }>(`/list/${encodeURIComponent(listId)}`);
  const closed = list.statuses?.find((item) => item.type === "closed");
  if (!closed) throw new Error("La lista de ClickUp no tiene un estado cerrado");
  return closed.status;
}
