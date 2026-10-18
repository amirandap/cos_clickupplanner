import { DateTime } from "luxon";

const INPUT_FORMAT = "yyyy-LL-dd'T'HH:mm";

export function formatDateTimeInput(value: Date, timezone: string): string {
  const date = DateTime.fromJSDate(value, { zone: timezone });
  return date.isValid ? date.toFormat(INPUT_FORMAT) : "";
}

export function parseDateTimeInput(value: string, timezone: string, original?: Date): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = DateTime.fromFormat(value, INPUT_FORMAT, { zone: timezone });
  // Luxon shifts nonexistent DST times forward; a round trip detects that shift.
  if (!date.isValid || date.toFormat(INPUT_FORMAT) !== value) return null;
  if (original && formatDateTimeInput(original, timezone) === value) return new Date(original.getTime());
  if (date.getPossibleOffsets().length > 1) return null;
  return date.toJSDate();
}

export function allDayStart(value: string, timezone: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return parseDateTimeInput(`${value}T09:00`, timezone);
}

export function dateLabel(value: string | null, timezone: string): string | null {
  if (!value) return null;
  const date = DateTime.fromISO(value, { zone: timezone }).setLocale("es-DO");
  return date.isValid ? date.toFormat("d LLL") : null;
}

export function taskAgeLabel(value: string | null, timezone: string): string {
  if (!value) return "Edad desconocida";
  const date = DateTime.fromISO(value, { zone: timezone });
  if (!date.isValid) return "Edad desconocida";
  const days = Math.max(0, Math.floor(DateTime.now().setZone(timezone).startOf("day").diff(date.startOf("day"), "days").days));
  return days === 0 ? "Creada hoy" : `Hace ${days} ${days === 1 ? "día" : "días"}`;
}
