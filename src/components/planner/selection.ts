import type { PlannerEvent } from "@/lib/planner/types";
import { parseDateTimeInput } from "./dates";

export function linkableEvents(events: PlannerEvent[], taskId: string): PlannerEvent[] {
  return events.filter((event) => !event.recurring && !event.allDay
    && (!event.clickupTaskId || event.clickupTaskId === taskId)
    && Number.isFinite(Date.parse(event.startAt)) && Date.parse(event.endAt) > Date.parse(event.startAt));
}

export function taskSelectionIntent(taskId: string, input: string, timezone: string, eventId: string, events: PlannerEvent[]) {
  if (eventId) {
    if (!linkableEvents(events, taskId).some((event) => event.id === eventId)) {
      throw new Error("El evento ya no está disponible para vincular esta tarea. Elige otro evento.");
    }
    return { kind: "link" as const, taskId, id: eventId };
  }
  const start = parseDateTimeInput(input, timezone);
  if (!start) throw new Error("Elige una fecha y hora válida. Si coincide con un cambio de horario, selecciona otra hora.");
  return { kind: "schedule" as const, taskId, startAt: start.toISOString() };
}
