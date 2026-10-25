import { DateTime } from "luxon";
import { ProviderPayloadError, record } from "../providers/http";

export type GoogleEventTime = { dateTime?: string; date?: string; timeZone?: string };
export type RemoteCalendarEvent = {
  id: string;
  summary?: string;
  htmlLink?: string;
  status?: string;
  start?: GoogleEventTime;
  end?: GoogleEventTime;
  updated?: string;
  recurrence?: string[];
  recurringEventId?: string;
  originalStartTime?: GoogleEventTime;
  extendedProperties?: { private?: Record<string, string> };
  [key: string]: unknown;
};

export function googleEventDate(time: GoogleEventTime): Date {
  if (typeof time.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(time.date) && time.dateTime === undefined) {
    const parsed = DateTime.fromISO(time.date, { zone: "UTC" });
    if (parsed.isValid && parsed.toISODate() === time.date) return parsed.toJSDate();
  }
  if (typeof time.dateTime === "string" && time.date === undefined && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(time.dateTime)) {
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(time.dateTime) && !time.timeZone) throw new ProviderPayloadError("Google", "fecha sin zona horaria");
    const parsed = DateTime.fromISO(time.dateTime, { zone: time.timeZone ?? "UTC", setZone: true });
    if (parsed.isValid) return parsed.toJSDate();
  }
  throw new ProviderPayloadError("Google", "fecha inválida");
}

function eventTime(value: unknown): GoogleEventTime {
  if (!record(value) || (value.timeZone !== undefined && typeof value.timeZone !== "string")) throw new ProviderPayloadError("Google", "fecha inválida");
  const result: GoogleEventTime = {};
  for (const key of ["date", "dateTime", "timeZone"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string") throw new ProviderPayloadError("Google", "fecha inválida");
      result[key] = value[key];
    }
  }
  googleEventDate(result);
  return result;
}

export function validateGoogleEvent(value: unknown): RemoteCalendarEvent {
  if (!record(value) || typeof value.id !== "string" || !value.id) throw new ProviderPayloadError("Google", "ID del evento");
  for (const key of ["summary", "htmlLink", "status", "updated", "recurringEventId"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") throw new ProviderPayloadError("Google", key);
  }
  if (typeof value.updated === "string") googleEventDate({ dateTime: value.updated });
  const result: RemoteCalendarEvent = { ...value, id: value.id };
  if (value.start !== undefined) result.start = eventTime(value.start);
  if (value.end !== undefined) result.end = eventTime(value.end);
  if (value.originalStartTime !== undefined) result.originalStartTime = eventTime(value.originalStartTime);
  if (value.status !== "cancelled") {
    if (!result.start || !result.end || googleEventDate(result.end) < googleEventDate(result.start) || Boolean(result.start.date) !== Boolean(result.end.date)) throw new ProviderPayloadError("Google", "intervalo de fechas inválido");
  }
  if (value.recurringEventId !== undefined && !result.originalStartTime) throw new ProviderPayloadError("Google", "originalStartTime");
  if (value.recurrence !== undefined) {
    if (!Array.isArray(value.recurrence) || !value.recurrence.length || !value.recurrence.every((line) => typeof line === "string" && /^(RRULE|EXRULE|RDATE|EXDATE)[;:]/.test(line))) throw new ProviderPayloadError("Google", "recurrencia");
    result.recurrence = value.recurrence;
  }
  if (value.extendedProperties !== undefined) {
    if (!record(value.extendedProperties)) throw new ProviderPayloadError("Google", "extendedProperties");
    const properties = value.extendedProperties.private;
    if (properties !== undefined && (!record(properties) || !Object.values(properties).every((item) => typeof item === "string"))) throw new ProviderPayloadError("Google", "extendedProperties.private");
    result.extendedProperties = { private: properties as Record<string, string> | undefined };
  }
  return result;
}
