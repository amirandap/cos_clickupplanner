import type { RefObject } from "react";
import { DateTime } from "luxon";
import { Button } from "@/components/ui/button";
import type { PlannerEvent } from "@/lib/planner/types";

type SelectionBannerProps = {
  taskTitle?: string;
  timezone: string;
  inputRef: RefObject<HTMLInputElement | null>;
  dateTimeInput: string;
  linkEventId: string;
  linkEvents: PlannerEvent[];
  busy: boolean;
  onDateTime: (value: string) => void;
  onEvent: (id: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

export function SelectionBanner({ taskTitle, timezone, inputRef, dateTimeInput, linkEventId, linkEvents, busy,
  onDateTime, onEvent, onSave, onCancel }: SelectionBannerProps) {
  return <section className="selection-banner" aria-label={taskTitle ? "Agendar tarea" : "Reprogramar bloque"}
    onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); onCancel(); } }}>
    <span>{taskTitle ? `Agenda ${taskTitle} o vincúlala a un evento existente.`
      : "Elige un horario para reprogramar este bloque o toca un espacio en el calendario."}</span>
    <form className="selection-controls" onSubmit={(event) => { event.preventDefault(); if (!busy) onSave(); }}>
      {taskTitle && <select aria-label="Evento existente para vincular" value={linkEventId} disabled={busy}
        className="max-w-72 rounded-md border border-[#cfc5f2] bg-white px-2 py-1 text-xs"
        onChange={(event) => onEvent(event.target.value)}>
        <option value="">Crear bloque nuevo</option>
        {linkEvents.map((event) => <option key={event.id} value={event.id}>
          {event.title} · {DateTime.fromISO(event.startAt).setZone(timezone).setLocale("es").toFormat("ccc d LLL HH:mm")}
        </option>)}
      </select>}
      <input ref={inputRef} aria-label="Fecha y hora del bloque" type="datetime-local" value={dateTimeInput}
        disabled={busy || !!linkEventId} required={!linkEventId}
        onChange={(event) => onDateTime(event.target.value)} />
      <Button type="submit" size="sm" disabled={busy || (!linkEventId && !dateTimeInput)}>Guardar</Button>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCancel}>Cancelar</Button>
    </form>
  </section>;
}
