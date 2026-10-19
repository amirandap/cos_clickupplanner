import type { CalendarEvent } from "@prisma/client";
import { DateTime } from "luxon";
import { rrulestr } from "rrule";
import type { PlannerEvent } from "../planner/types";
import { HttpError } from "../planner/http";
import { record } from "../providers/http";
import { googleEventDate } from "./validation";
import type { GoogleEventTime } from "./validation";

type Range = { startAt: Date; endAt: Date };
const maximumOccurrences = 10_000;
function raw(row: CalendarEvent) { return record(row.rawJson) ? row.rawJson : {}; }
function overlaps(start: Date, end: Date, range: Range) { return start < range.endAt && end > range.startAt; }
function floating(date: DateTime) { return new Date(Date.UTC(date.year, date.month - 1, date.day, date.hour, date.minute, date.second)); }
function basic(date: DateTime) { return `${date.toFormat("yyyyMMdd'T'HHmmss")}Z`; }
function resolveWall(date: Date, zone: string, start: DateTime): Date | null {
  if (date.getTime() === floating(start).getTime()) return start.toJSDate();
  const wall = DateTime.fromJSDate(date, { zone: "UTC" });
  const resolved = DateTime.fromObject({ year: wall.year, month: wall.month, day: wall.day, hour: wall.hour, minute: wall.minute, second: wall.second }, { zone });
  if (!resolved.isValid || resolved.toFormat("yyyyMMddHHmmss") !== wall.toFormat("yyyyMMddHHmmss")) return null;
  return resolved.getPossibleOffsets().sort((a, b) => a.toMillis() - b.toMillis())[0].toJSDate();
}

// RFC 5545 excludes nonexistent local times from COUNT. Floating rules alone
// would consume a count at the spring gap, so adjust their generated count first.
function validCount(line: string, start: DateTime, zone: string, upper: Date) {
  const match = /(?:^|;)COUNT=(\d+)/.exec(line.replace(/^(?:EX)?RRULE:/, ""));
  if (!match) return line;
  const count = Number(match[1]);
  if (count < 1 || count > maximumOccurrences) throw new HttpError(422, "El número de repeticiones excede el límite del calendario.");
  const unbounded = line.replace(/;?COUNT=\d+;?/, ";").replace(/;$/, "").replace(/^EXRULE:/, "RRULE:").replace(/:;/, ":");
  const rule = rrulestr(`DTSTART:${basic(start)}\n${unbounded}`);
  let generated = 0;
  let valid = 0;
  rule.all((date) => {
    if (date > upper) return false;
    generated++;
    if (generated > maximumOccurrences + 500) throw new HttpError(422, "La recurrencia excede el presupuesto de expansión.");
    if (resolveWall(date, zone, start)) valid++;
    return valid < count;
  });
  return generated ? line.replace(/COUNT=\d+/, `COUNT=${generated}`) : line;
}
function originalTime(value: unknown) {
  if (!record(value)) throw new HttpError(502, "La excepción recurrente no tiene fecha original.");
  return googleEventDate(value as GoogleEventTime).toISOString();
}

function normalizeLine(line: string, zone: string) {
  if (/^(RRULE|EXRULE):/.test(line)) {
    if (!/FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;|$)/.test(line) || /BY(?:HOUR|MINUTE|SECOND)=[^;]*,/.test(line)) {
      throw new HttpError(422, "La recurrencia es demasiado frecuente para mostrar este rango.");
    }
    return line.replace(/UNTIL=(\d{8}T\d{6}Z)/g, (_match, value: string) => {
      const until = DateTime.fromFormat(value, "yyyyMMdd'T'HHmmss'Z'", { zone: "UTC" });
      if (!until.isValid) throw new HttpError(502, "El límite de la recurrencia no es válido.");
      return `UNTIL=${basic(until.setZone(zone))}`;
    });
  }
  const match = /^(RDATE|EXDATE)((?:;[^:]+)*):(.+)$/.exec(line);
  if (!match) throw new HttpError(502, "La regla de recurrencia no es válida.");
  const sourceZone = /;TZID=([^;:]+)/.exec(match[2])?.[1] ?? zone;
  const values = match[3].split(",").map((value) => {
    const utc = value.endsWith("Z");
    const format = value.length === 8 ? "yyyyMMdd" : utc ? "yyyyMMdd'T'HHmmss'Z'" : "yyyyMMdd'T'HHmmss";
    const parsed = DateTime.fromFormat(value, format, { zone: utc ? "UTC" : sourceZone });
    if (!parsed.isValid) throw new HttpError(502, "Una fecha de recurrencia no es válida.");
    return basic(parsed.setZone(zone));
  });
  return `${match[1]}:${values.join(",")}`;
}

function calendarLink(row: CalendarEvent) {
  if (row.id.startsWith("recurring:") || row.calendarId.startsWith("mock")) return null;
  return `https://calendar.google.com/calendar/event?eid=${Buffer.from(`${row.id} ${row.calendarId}`).toString("base64url")}`;
}

function asPlannerEvent(row: CalendarEvent, recurring: boolean): PlannerEvent {
  const source = raw(row);
  const startDate = record(source.start) && typeof source.start.date === "string" ? source.start.date : null;
  const endDate = record(source.end) && typeof source.end.date === "string" ? source.end.date : null;
  const properties = record(source.extendedProperties) && record(source.extendedProperties.private) ? source.extendedProperties.private : {};
  return { id: row.id, calendarId: row.calendarId, title: row.title, startAt: row.startAt.toISOString(), endAt: row.endAt.toISOString(),
    allDay: Boolean(startDate && endDate), startDate, endDate, clickupTaskId: row.clickupTaskId,
    plannerOwned: properties.source === "planner", recurring,
    hasMeet: typeof source.hangoutLink === "string" || (record(source.conferenceData) && Array.isArray(source.conferenceData.entryPoints)),
    htmlLink: typeof source.htmlLink === "string" ? source.htmlLink : calendarLink(row),
    location: typeof source.location === "string" && source.location.trim() ? source.location.trim() : null };
}

/** Expand wall-clock rules in floating UTC, then resolve them in the series zone.
 * This avoids rrule's TZID conversion depending on the server's own TZ setting.
 * Exceptions are keyed by originalStartTime, including cancelled tombstones.
 */
export function expandCalendarEvents(rows: CalendarEvent[], range: Range): PlannerEvent[] {
  const output: PlannerEvent[] = [];
  const exceptions = new Map<string, Map<string, CalendarEvent>>();
  for (const row of rows) {
    const source = raw(row);
    if (typeof source.recurringEventId !== "string") continue;
    const byOriginal = exceptions.get(source.recurringEventId) ?? new Map<string, CalendarEvent>();
    byOriginal.set(originalTime(source.originalStartTime), row);
    exceptions.set(source.recurringEventId, byOriginal);
  }
  for (const row of rows) {
    const source = raw(row);
    if (source.status === "cancelled") continue;
    if (!Array.isArray(source.recurrence)) {
      if (overlaps(row.startAt, row.endAt, range)) output.push(asPlannerEvent(row, typeof source.recurringEventId === "string"));
      continue;
    }
    if (!source.recurrence.every((line) => typeof line === "string")) throw new HttpError(502, "La regla de recurrencia no es válida.");
    const allDay = record(source.start) && typeof source.start.date === "string";
    const startInfo = record(source.start) ? source.start : {};
    const offsetZone = typeof startInfo.dateTime === "string" ? DateTime.fromISO(startInfo.dateTime, { setZone: true }).zoneName : "UTC";
    const zone = allDay ? "UTC" : typeof startInfo.timeZone === "string" ? startInfo.timeZone : offsetZone ?? "UTC";
    const start = DateTime.fromJSDate(row.startAt, { zone });
    if (!start.isValid) throw new HttpError(502, "La zona horaria de la recurrencia no es válida.");
    if (DateTime.fromJSDate(range.endAt).diff(start, "years").years > 200) throw new HttpError(422, "La serie es demasiado antigua para expandir este rango.");
    const duration = row.endAt.getTime() - row.startAt.getTime();
    let dates: Date[];
    let truncated = false;
    try {
      const lower = floating(DateTime.fromJSDate(new Date(range.startAt.getTime() - duration - 86400000), { zone }));
      const upper = floating(DateTime.fromJSDate(new Date(range.endAt.getTime() + 86400000), { zone }));
      const rule = rrulestr([`DTSTART:${basic(start)}`, ...source.recurrence.map((line) => validCount(normalizeLine(line, zone), start, zone, upper))].join("\n"), { forceset: true });
      dates = rule.between(lower, upper, true, (_date, length) => {
        if (length >= maximumOccurrences) { truncated = true; return false; }
        return true;
      });
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "No se pudo interpretar una regla de recurrencia.");
    }
    if (truncated) throw new HttpError(422, "Hay demasiadas ocurrencias en el rango seleccionado.");
    for (const date of dates) {
      const instant = resolveWall(date, zone, start);
      if (!instant) continue;
      if (exceptions.get(row.id)?.has(instant.toISOString())) continue;
      const end = new Date(instant.getTime() + duration);
      if (!overlaps(instant, end, range)) continue;
      const instance = asPlannerEvent({ ...row, id: `recurring:${row.id}:${instant.toISOString()}`, startAt: instant, endAt: end }, true);
      if (allDay) {
        instance.startDate = DateTime.fromJSDate(instant, { zone: "UTC" }).toISODate();
        instance.endDate = DateTime.fromJSDate(end, { zone: "UTC" }).toISODate();
      }
      output.push(instance);
    }
  }
  if (output.length > maximumOccurrences) throw new HttpError(422, "Hay demasiados eventos en el rango seleccionado.");
  return output.sort((a, b) => a.startAt.localeCompare(b.startAt) || a.id.localeCompare(b.id));
}
