import { DateTime } from "luxon";
import { db } from "@/lib/db/client";
import { connectionStates, deleteCredential, getCredential, saveCredential } from "@/lib/auth/credentials";
import { revokeGoogleToken } from "@/lib/auth/google-oauth";
import { fetchClickUpIdentity } from "@/lib/clickup/tasks";
import { parseListIds } from "@/lib/planner/config";
import { HttpError } from "@/lib/planner/http";
import { enforceRateLimit } from "@/lib/ratelimit";

const MAX_LISTS = 50;
const CLICKUP_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{8,200}$/;
const TOKEN_ATTEMPTS = 10;
const TOKEN_WINDOW_MS = 10 * 60_000;

export type SettingsInput = { calendarId: string; listIds: string[]; timezone: string };

export function validateSettingsInput(body: unknown): SettingsInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Ajustes inválidos");
  const { calendarId, listIds, timezone } = body as Record<string, unknown>;
  if (typeof calendarId !== "string" || !/^[^\s\u0000-\u001f]{1,256}$/.test(calendarId.trim())) throw new HttpError(400, "ID de calendario inválido");
  const lists = typeof listIds === "string" ? parseListIds(listIds) : Array.isArray(listIds) && listIds.every((id) => typeof id === "string") ? parseListIds(listIds.join(",")) : null;
  if (!lists || lists.length > MAX_LISTS || !lists.every((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id))) throw new HttpError(400, "IDs de lista inválidos");
  if (typeof timezone !== "string" || !timezone.trim() || !DateTime.now().setZone(timezone.trim()).isValid) throw new HttpError(400, "Zona horaria inválida");
  return { calendarId: calendarId.trim(), listIds: lists, timezone: timezone.trim() };
}

export async function updateSettings(userId: string, input: SettingsInput) {
  await db.userSettings.upsert({
    where: { userId },
    create: { userId, calendarId: input.calendarId, listIds: input.listIds.join(","), timezone: input.timezone },
    update: { calendarId: input.calendarId, listIds: input.listIds.join(","), timezone: input.timezone },
  });
}

export async function settingsView(user: { id: string; email: string; name: string | null }) {
  const [settings, connections] = await Promise.all([db.userSettings.findUnique({ where: { userId: user.id } }), connectionStates(user.id)]);
  return {
    email: user.email, name: user.name, mockMode: process.env.USE_MOCK_DATA === "true",
    googleCalendar: connections.googleCalendar,
    clickup: { state: connections.clickup, clickupUserId: settings?.clickupUserId ?? null, username: settings?.clickupUsername ?? null },
    settings: {
      calendarId: settings?.calendarId ?? "primary", listIds: parseListIds(settings?.listIds ?? ""),
      timezone: settings?.timezone ?? (process.env.APP_TIMEZONE || "UTC"),
    },
  };
}

/** Validates the personal token against ClickUp's GET /user and keeps the user id it reports. */
export async function connectClickUp(userId: string, tokenInput: unknown) {
  const token = typeof tokenInput === "string" ? tokenInput.trim() : "";
  if (!CLICKUP_TOKEN_PATTERN.test(token)) throw new HttpError(400, "El token de ClickUp no tiene un formato válido");
  await enforceRateLimit(`clickup-token:${userId}`, TOKEN_ATTEMPTS, TOKEN_WINDOW_MS);
  const identity = await fetchClickUpIdentity(token);
  const previous = await db.userSettings.findUnique({ where: { userId }, select: { clickupUserId: true } });
  await saveCredential(userId, "clickup", { accessToken: token, scheme: "raw" });
  await db.$transaction(async (tx) => {
    await tx.userSettings.upsert({
      where: { userId },
      create: { userId, clickupUserId: identity.clickupUserId, clickupUsername: identity.username },
      update: { clickupUserId: identity.clickupUserId, clickupUsername: identity.username },
    });
    // A different ClickUp account must not inherit what the previous token fetched.
    if (previous?.clickupUserId && previous.clickupUserId !== identity.clickupUserId) await tx.userTask.deleteMany({ where: { userId } });
  });
  return identity;
}

export async function disconnectClickUp(userId: string) {
  await deleteCredential(userId, "clickup");
  await db.$transaction([
    db.userSettings.updateMany({ where: { userId }, data: { clickupUserId: null, clickupUsername: null } }),
    db.userTask.deleteMany({ where: { userId } }),
  ]);
}

export async function disconnectGoogleCalendar(userId: string) {
  const credential = await getCredential(userId, "google_calendar").catch(() => null);
  await deleteCredential(userId, "google_calendar");
  const token = credential?.refreshToken ?? credential?.accessToken;
  if (token) await revokeGoogleToken(token);
}
