import { db } from "@/lib/db/client";
import { appTimezone, getConfiguredCalendarId } from "@/lib/planner/config";
import { ProviderHttpError, ProviderPayloadError, record, requestJson } from "../providers/http";
import { googleEventDate, validateGoogleEvent } from "./validation";
import type { RemoteCalendarEvent } from "./validation";
import { validateGoogleToken } from "@/lib/sync/credentials";
export type { RemoteCalendarEvent } from "./validation";

const calendarId = getConfiguredCalendarId;
const calendarUrl = (id = calendarId()) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`;

async function accessToken() {
  const credential = await db.oAuthCredential.findUnique({ where: { provider: "google" } });
  if (credential && (!credential.expiresAt || credential.expiresAt.getTime() > Date.now() + 60000)) return credential.accessToken;
  const refreshToken = credential ? credential.refreshToken : process.env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken || !process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) throw new Error("Google requiere conexión OAuth o GOOGLE_REFRESH_TOKEN");
  const data = await requestJson("Google OAuth", "https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const token = validateGoogleToken(data);
  await db.oAuthCredential.upsert({ where: { provider: "google" }, create: { provider: "google", accessToken: token.accessToken, refreshToken, expiresAt: token.expiresAt }, update: { accessToken: token.accessToken, refreshToken, expiresAt: token.expiresAt } });
  return token.accessToken;
}

async function googleRequest(url: string, init: RequestInit = {}, retrySafe = true) {
  return requestJson("Google Calendar", url, {
    ...init, headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json", ...init.headers },
  }, { retrySafe });
}

export async function createRemoteEvent(taskId: string, title: string, startAt: Date, endAt: Date, eventId?: string, taskUrl?: string | null) {
  if (eventId && !/^[a-v0-9]{5,1024}$/.test(eventId) && process.env.USE_MOCK_DATA !== "true") throw new Error("ID de evento Google inválido");
  const data = { ...(eventId ? { id: eventId } : {}), summary: title, ...(taskUrl ? { description: `ClickUp: ${taskUrl}`, source: { title: "ClickUp", url: taskUrl } } : {}), start: { dateTime: startAt.toISOString(), timeZone: appTimezone() }, end: { dateTime: endAt.toISOString(), timeZone: appTimezone() }, extendedProperties: { private: { source: "planner", clickupTaskId: taskId } } };
  if (process.env.USE_MOCK_DATA === "true") return { ...data, id: eventId ?? `mock-${crypto.randomUUID()}`, updated: new Date().toISOString() } satisfies RemoteCalendarEvent;
  try {
    return validateGoogleEvent(await googleRequest(calendarUrl(), { method: "POST", body: JSON.stringify(data) }, Boolean(eventId)));
  } catch (error) {
    if (!(error instanceof ProviderHttpError) || error.upstreamStatus !== 409 || !eventId) throw error;
    const existing = validateGoogleEvent(await googleRequest(`${calendarUrl()}/${encodeURIComponent(eventId)}`));
    if (existing.status === "cancelled" || existing.id !== eventId || existing.extendedProperties?.private?.source !== "planner" || existing.extendedProperties.private.clickupTaskId !== taskId || !existing.start || !existing.end || googleEventDate(existing.start).getTime() !== startAt.getTime() || googleEventDate(existing.end).getTime() !== endAt.getTime()) throw new ProviderHttpError("Google Calendar", 409, "Conflicto: el ID de Google no coincide con la tarea y su horario");
    return existing;
  }
}

export async function getRemoteEvent(id: string, calendar: string) {
  return validateGoogleEvent(await googleRequest(`${calendarUrl(calendar)}/${encodeURIComponent(id)}`));
}

export async function updateRemoteEvent(id: string, calendar: string, startAt: Date, endAt: Date, etag?: string) {
  if (process.env.USE_MOCK_DATA === "true") return { updated: new Date().toISOString() };
  return validateGoogleEvent(await googleRequest(`${calendarUrl(calendar)}/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: etag ? { "If-Match": etag } : undefined,
    body: JSON.stringify({ start: { dateTime: startAt.toISOString(), timeZone: appTimezone() }, end: { dateTime: endAt.toISOString(), timeZone: appTimezone() } }),
  }));
}

export async function renameRemoteEvent(id: string, calendar: string, title: string, etag?: string) {
  if (process.env.USE_MOCK_DATA === "true") return { updated: new Date().toISOString(), summary: title };
  return validateGoogleEvent(await googleRequest(`${calendarUrl(calendar)}/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: etag ? { "If-Match": etag } : undefined, body: JSON.stringify({ summary: title }),
  }));
}

export async function linkRemoteEvent(event: RemoteCalendarEvent, calendar: string, taskId: string) {
  const privateProperties = { ...(event.extendedProperties?.private ?? {}), plannerLinkedClickupTaskId: taskId };
  if (process.env.USE_MOCK_DATA === "true") return { ...event, extendedProperties: { ...event.extendedProperties, private: privateProperties }, updated: new Date().toISOString() };
  return validateGoogleEvent(await googleRequest(`${calendarUrl(calendar)}/${encodeURIComponent(event.id)}`, {
    method: "PATCH", headers: typeof event.etag === "string" ? { "If-Match": event.etag } : undefined,
    body: JSON.stringify({ extendedProperties: { private: privateProperties } }),
  }));
}

export async function unlinkRemoteEvent(event: RemoteCalendarEvent, calendar: string) {
  const privateProperties = { ...(event.extendedProperties?.private ?? {}) };
  delete privateProperties.plannerLinkedClickupTaskId;
  if (process.env.USE_MOCK_DATA === "true") return { ...event, extendedProperties: { ...event.extendedProperties, private: privateProperties }, updated: new Date().toISOString() };
  return validateGoogleEvent(await googleRequest(`${calendarUrl(calendar)}/${encodeURIComponent(event.id)}`, {
    method: "PATCH", headers: typeof event.etag === "string" ? { "If-Match": event.etag } : undefined,
    body: JSON.stringify({ extendedProperties: { private: { plannerLinkedClickupTaskId: null } } }),
  }));
}

export async function deleteRemoteEvent(id: string, calendar: string, etag?: string) {
  if (process.env.USE_MOCK_DATA === "true") return;
  try { await googleRequest(`${calendarUrl(calendar)}/${encodeURIComponent(id)}`, { method: "DELETE", headers: etag ? { "If-Match": etag } : undefined }); }
  catch (error) { if (!(error instanceof ProviderHttpError) || ![404, 410].includes(error.upstreamStatus)) throw error; }
}

export async function listRemoteEvents(syncToken?: string) {
  const items: RemoteCalendarEvent[] = [];
  const seenPages = new Set<string>();
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const url = new URL(calendarUrl());
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("singleEvents", "false");
    if (syncToken) url.searchParams.set("syncToken", syncToken);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleRequest(url.toString());
    if (!record(page) || (page.items !== undefined && !Array.isArray(page.items)) || (page.nextPageToken !== undefined && (typeof page.nextPageToken !== "string" || !page.nextPageToken)) || (page.nextSyncToken !== undefined && (typeof page.nextSyncToken !== "string" || !page.nextSyncToken))) throw new ProviderPayloadError("Google", "página de eventos");
    items.push(...(page.items ?? []).map(validateGoogleEvent));
    pageToken = page.nextPageToken;
    nextSyncToken = page.nextSyncToken;
    if (pageToken) {
      if (seenPages.has(pageToken) || seenPages.size >= 1000) throw new ProviderPayloadError("Google", "paginación repetida o excesiva");
      seenPages.add(pageToken);
    }
  } while (pageToken);
  if (!nextSyncToken) throw new ProviderPayloadError("Google", "nextSyncToken ausente");
  return { items, nextSyncToken };
}

export { calendarId };
