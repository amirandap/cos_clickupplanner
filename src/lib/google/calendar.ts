import { getCredential, markRevoked, saveCredential } from "@/lib/auth/credentials";
import { googleClient } from "@/lib/config/env";
import { GOOGLE_TOKEN_URL } from "@/lib/auth/google-oauth";
import type { UserContext } from "@/lib/planner/config";
import { ReconnectRequiredError } from "@/lib/planner/http";
import { ProviderHttpError, ProviderPayloadError, record, requestJson } from "@/lib/providers/http";
import { googleEventDate, validateGoogleEvent } from "./validation";
import type { RemoteCalendarEvent } from "./validation";
import { validateGoogleToken } from "@/lib/sync/credentials";
export type { RemoteCalendarEvent } from "./validation";

const calendarUrl = (id: string) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`;

/** The access token of this user only. A dead refresh token marks the credential revoked. */
async function accessToken(userId: string) {
  const credential = await getCredential(userId, "google_calendar");
  if (!credential || credential.revokedAt) throw new ReconnectRequiredError("google_calendar");
  if (credential.accessToken && credential.expiresAt && credential.expiresAt.getTime() > Date.now() + 60000) return credential.accessToken;
  if (!credential.refreshToken) {
    await markRevoked(userId, "google_calendar");
    throw new ReconnectRequiredError("google_calendar");
  }
  const { clientId, clientSecret } = googleClient();
  let data: unknown;
  try {
    data = await requestJson("Google OAuth", GOOGLE_TOKEN_URL, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: credential.refreshToken, grant_type: "refresh_token" }),
    }, { parseErrorCode: true });
  } catch (error) {
    if (error instanceof ProviderHttpError && error.errorCode === "invalid_grant") {
      await markRevoked(userId, "google_calendar");
      throw new ReconnectRequiredError("google_calendar");
    }
    throw error;
  }
  const token = validateGoogleToken(data);
  await saveCredential(userId, "google_calendar", {
    accessToken: token.accessToken, refreshToken: token.refreshToken ?? credential.refreshToken,
    expiresAt: token.expiresAt, scopes: token.scope ?? credential.scopes,
  });
  return token.accessToken;
}

async function googleRequest(ctx: UserContext, url: string, init: RequestInit = {}, retrySafe = true) {
  return requestJson("Google Calendar", url, {
    ...init, headers: { Authorization: `Bearer ${await accessToken(ctx.userId)}`, "Content-Type": "application/json", ...init.headers },
  }, { retrySafe });
}

export async function createRemoteEvent(ctx: UserContext, taskId: string, title: string, startAt: Date, endAt: Date, eventId?: string, taskUrl?: string | null) {
  if (eventId && !/^[a-v0-9]{5,1024}$/.test(eventId) && !ctx.mock) throw new Error("ID de evento Google inválido");
  const data = { ...(eventId ? { id: eventId } : {}), summary: title, ...(taskUrl ? { description: `ClickUp: ${taskUrl}`, source: { title: "ClickUp", url: taskUrl } } : {}), start: { dateTime: startAt.toISOString(), timeZone: ctx.timezone }, end: { dateTime: endAt.toISOString(), timeZone: ctx.timezone }, extendedProperties: { private: { source: "planner", clickupTaskId: taskId } } };
  if (ctx.mock) return { ...data, id: eventId ?? `mock-${crypto.randomUUID()}`, updated: new Date().toISOString() } satisfies RemoteCalendarEvent;
  try {
    return validateGoogleEvent(await googleRequest(ctx, calendarUrl(ctx.calendarId), { method: "POST", body: JSON.stringify(data) }, Boolean(eventId)));
  } catch (error) {
    if (!(error instanceof ProviderHttpError) || error.upstreamStatus !== 409 || !eventId) throw error;
    const existing = validateGoogleEvent(await googleRequest(ctx, `${calendarUrl(ctx.calendarId)}/${encodeURIComponent(eventId)}`));
    if (existing.status === "cancelled" || existing.id !== eventId || existing.extendedProperties?.private?.source !== "planner" || existing.extendedProperties.private.clickupTaskId !== taskId || !existing.start || !existing.end || googleEventDate(existing.start).getTime() !== startAt.getTime() || googleEventDate(existing.end).getTime() !== endAt.getTime()) throw new ProviderHttpError("Google Calendar", 409, "Conflicto: el ID de Google no coincide con la tarea y su horario");
    return existing;
  }
}

export async function getRemoteEvent(ctx: UserContext, id: string, calendar: string) {
  return validateGoogleEvent(await googleRequest(ctx, `${calendarUrl(calendar)}/${encodeURIComponent(id)}`));
}

export async function updateRemoteEvent(ctx: UserContext, id: string, calendar: string, startAt: Date, endAt: Date, etag?: string) {
  if (ctx.mock) return { updated: new Date().toISOString() };
  return validateGoogleEvent(await googleRequest(ctx, `${calendarUrl(calendar)}/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: etag ? { "If-Match": etag } : undefined,
    body: JSON.stringify({ start: { dateTime: startAt.toISOString(), timeZone: ctx.timezone }, end: { dateTime: endAt.toISOString(), timeZone: ctx.timezone } }),
  }));
}

export async function renameRemoteEvent(ctx: UserContext, id: string, calendar: string, title: string, etag?: string) {
  if (ctx.mock) return { updated: new Date().toISOString(), summary: title };
  return validateGoogleEvent(await googleRequest(ctx, `${calendarUrl(calendar)}/${encodeURIComponent(id)}`, {
    method: "PATCH", headers: etag ? { "If-Match": etag } : undefined, body: JSON.stringify({ summary: title }),
  }));
}

export async function linkRemoteEvent(ctx: UserContext, event: RemoteCalendarEvent, calendar: string, taskId: string) {
  const privateProperties = { ...(event.extendedProperties?.private ?? {}), plannerLinkedClickupTaskId: taskId };
  if (ctx.mock) return { ...event, extendedProperties: { ...event.extendedProperties, private: privateProperties }, updated: new Date().toISOString() };
  return validateGoogleEvent(await googleRequest(ctx, `${calendarUrl(calendar)}/${encodeURIComponent(event.id)}`, {
    method: "PATCH", headers: typeof event.etag === "string" ? { "If-Match": event.etag } : undefined,
    body: JSON.stringify({ extendedProperties: { private: privateProperties } }),
  }));
}

export async function unlinkRemoteEvent(ctx: UserContext, event: RemoteCalendarEvent, calendar: string) {
  const privateProperties = { ...(event.extendedProperties?.private ?? {}) };
  delete privateProperties.plannerLinkedClickupTaskId;
  if (ctx.mock) return { ...event, extendedProperties: { ...event.extendedProperties, private: privateProperties }, updated: new Date().toISOString() };
  return validateGoogleEvent(await googleRequest(ctx, `${calendarUrl(calendar)}/${encodeURIComponent(event.id)}`, {
    method: "PATCH", headers: typeof event.etag === "string" ? { "If-Match": event.etag } : undefined,
    body: JSON.stringify({ extendedProperties: { private: { plannerLinkedClickupTaskId: null } } }),
  }));
}

export async function deleteRemoteEvent(ctx: UserContext, id: string, calendar: string, etag?: string) {
  if (ctx.mock) return;
  try { await googleRequest(ctx, `${calendarUrl(calendar)}/${encodeURIComponent(id)}`, { method: "DELETE", headers: etag ? { "If-Match": etag } : undefined }); }
  catch (error) { if (!(error instanceof ProviderHttpError) || ![404, 410].includes(error.upstreamStatus)) throw error; }
}

export async function listRemoteEvents(ctx: UserContext, syncToken?: string) {
  const items: RemoteCalendarEvent[] = [];
  const seenPages = new Set<string>();
  let pageToken: string | undefined;
  let nextSyncToken: string | undefined;
  do {
    const url = new URL(calendarUrl(ctx.calendarId));
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("singleEvents", "false");
    if (syncToken) url.searchParams.set("syncToken", syncToken);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await googleRequest(ctx, url.toString());
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

