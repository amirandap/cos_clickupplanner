import { db } from "@/lib/db/client";
import { appTimezone } from "@/lib/planner/config";

export type RemoteCalendarEvent = {
  id: string;
  summary?: string;
  htmlLink?: string;
  status?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
  [key: string]: unknown;
};

const calendarId = () => process.env.GOOGLE_CALENDAR_ID || "primary";
const calendarUrl = (id = calendarId()) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`;

async function accessToken() {
  const credential = await db.oAuthCredential.findUnique({ where: { provider: "google" } });
  if (credential && (!credential.expiresAt || credential.expiresAt.getTime() > Date.now() + 60000)) return credential.accessToken;
  const refreshToken = credential?.refreshToken || process.env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new Error("Google requiere conexión OAuth o GOOGLE_REFRESH_TOKEN");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  if (!response.ok) throw new Error(`Google token refresh failed: ${response.status}`);
  const data = await response.json() as { access_token: string; expires_in: number };
  await db.oAuthCredential.upsert({ where: { provider: "google" }, create: { provider: "google", accessToken: data.access_token, refreshToken, expiresAt: new Date(Date.now() + data.expires_in * 1000) }, update: { accessToken: data.access_token, refreshToken, expiresAt: new Date(Date.now() + data.expires_in * 1000) } });
  return data.access_token;
}

async function googleRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...init.headers },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Google Calendar API ${response.status}: ${(await response.text()).slice(0, 240)}`);
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export async function createRemoteEvent(taskId: string, title: string, startAt: Date, endAt: Date) {
  if (process.env.USE_MOCK_DATA === "true") {
    return { id: `mock-${crypto.randomUUID()}`, summary: title, start: { dateTime: startAt.toISOString() }, end: { dateTime: endAt.toISOString() }, extendedProperties: { private: { source: "planner", clickupTaskId: taskId } }, updated: new Date().toISOString() } satisfies RemoteCalendarEvent;
  }
  return googleRequest<RemoteCalendarEvent>(calendarUrl(), {
    method: "POST",
    body: JSON.stringify({ summary: title, start: { dateTime: startAt.toISOString(), timeZone: appTimezone() }, end: { dateTime: endAt.toISOString(), timeZone: appTimezone() }, extendedProperties: { private: { source: "planner", clickupTaskId: taskId } } }),
  });
}

export async function updateRemoteEvent(id: string, calendar: string, startAt: Date, endAt: Date) {
  if (process.env.USE_MOCK_DATA === "true") return { updated: new Date().toISOString() };
  return googleRequest<RemoteCalendarEvent>(`${calendarUrl(calendar)}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ start: { dateTime: startAt.toISOString(), timeZone: appTimezone() }, end: { dateTime: endAt.toISOString(), timeZone: appTimezone() } }),
  });
}

export async function linkRemoteEvent(event: RemoteCalendarEvent, calendar: string, taskId: string) {
  const privateProperties = { ...(event.extendedProperties?.private ?? {}), plannerLinkedClickupTaskId: taskId };
  if (process.env.USE_MOCK_DATA === "true") return { ...event, extendedProperties: { ...event.extendedProperties, private: privateProperties }, updated: new Date().toISOString() };
  return googleRequest<RemoteCalendarEvent>(`${calendarUrl(calendar)}/${encodeURIComponent(event.id)}`, {
    method: "PATCH", body: JSON.stringify({ extendedProperties: { private: privateProperties } }),
  });
}

export async function unlinkRemoteEvent(event: RemoteCalendarEvent, calendar: string) {
  const privateProperties = { ...(event.extendedProperties?.private ?? {}) };
  delete privateProperties.plannerLinkedClickupTaskId;
  if (process.env.USE_MOCK_DATA === "true") return { ...event, extendedProperties: { ...event.extendedProperties, private: privateProperties }, updated: new Date().toISOString() };
  return googleRequest<RemoteCalendarEvent>(`${calendarUrl(calendar)}/${encodeURIComponent(event.id)}`, {
    method: "PATCH", body: JSON.stringify({ extendedProperties: { private: { plannerLinkedClickupTaskId: null } } }),
  });
}

export async function deleteRemoteEvent(id: string, calendar: string) {
  if (process.env.USE_MOCK_DATA === "true") return;
  await googleRequest<void>(`${calendarUrl(calendar)}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function listRemoteEvents(syncToken?: string) {
  const items: RemoteCalendarEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const url = new URL(calendarUrl());
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showDeleted", "true");
    if (syncToken) url.searchParams.set("syncToken", syncToken);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleRequest<{ items?: RemoteCalendarEvent[]; nextPageToken?: string; nextSyncToken?: string }>(url.toString());
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken;
  } while (pageToken);
  return { items, nextSyncToken };
}

export { calendarId };
