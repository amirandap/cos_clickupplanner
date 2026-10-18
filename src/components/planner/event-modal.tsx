import { useEffect, useRef } from "react";
import { DateTime } from "luxon";
import { ArrowDownToLine, CalendarDays, Check, Clock3, ExternalLink, Trash2, X } from "lucide-react";
import type { PlannerEvent, PlannerTask } from "@/lib/planner/types";

type EventModalProps = {
  event: PlannerEvent;
  task?: PlannerTask | null;
  timezone: string;
  busy: boolean;
  onClose: () => void;
  onComplete: () => void;
  onRemove: () => void;
  onReschedule: () => void;
};

export function EventModal({ event, task, timezone, busy, onClose, onComplete, onRemove, onReschedule }: EventModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const busyRef = useRef(busy);

  useEffect(() => {
    closeRef.current = onClose;
    busyRef.current = busy;
    if (busy) dialogRef.current?.focus();
  }, [onClose, busy]);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    dialog?.focus();
    function onKeyDown(key: KeyboardEvent) {
      if (key.key === "Escape" && !busyRef.current) { key.preventDefault(); closeRef.current(); }
      if (key.key !== "Tab" || !dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>("a[href],button:not([disabled]),input:not([disabled]),[tabindex='0']")];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first) { key.preventDefault(); dialog.focus(); return; }
      const outside = !dialog.contains(document.activeElement);
      if (key.shiftKey && (outside || document.activeElement === first || document.activeElement === dialog)) { key.preventDefault(); last.focus(); }
      else if (!key.shiftKey && (outside || document.activeElement === last || document.activeElement === dialog)) { key.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => { document.removeEventListener("keydown", onKeyDown); previous?.focus(); };
  }, []);

  const date = DateTime.fromISO(event.allDay && event.startDate ? event.startDate : event.startAt, { zone: timezone }).setLocale("es-DO");
  const label = date.isValid ? date.toFormat(event.allDay ? "cccc d 'de' LLLL' · Todo el día'" : "cccc d 'de' LLLL · HH:mm") : "Fecha no disponible";

  return <div className="modal-backdrop" onMouseDown={() => { if (!busy) onClose(); }}>
    <div className="event-modal" role="dialog" aria-modal="true" aria-labelledby="event-title" tabIndex={-1}
      ref={dialogRef} onMouseDown={(pointer) => pointer.stopPropagation()}>
      <div className="modal-top">
        <div className="modal-icon"><CalendarDays size={20} /></div>
        <button aria-label="Cerrar" disabled={busy} onClick={onClose}><X size={18} /></button>
      </div>
      <p className="modal-kicker">{event.recurring ? "EVENTO RECURRENTE" : event.allDay ? "TODO EL DÍA" : "BLOQUE DE TIEMPO"}</p>
      <h2 id="event-title">{event.title}</h2>
      <p className="modal-time"><Clock3 size={16} />{label}</p>
      <div className="modal-actions">
        {task && <a className="modal-action" href={task.url ?? `https://app.clickup.com/t/${task.id}`} target="_blank" rel="noopener noreferrer">
          <ExternalLink size={17} /> Abrir en ClickUp
        </a>}
        {event.recurring ? <p>Gestiona este evento recurrente desde Google Calendar.</p> : <>
          {task && <button className="modal-action" disabled={busy} onClick={onComplete}><Check size={17} /> Marcar como completada</button>}
          <button className="modal-action" disabled={busy} onClick={onReschedule}>
            <ArrowDownToLine size={17} /> {task ? "Reprogramar" : "Reprogramar en Google Calendar"}
          </button>
          {task && <button className="modal-action destructive" disabled={busy} onClick={onRemove}>
            <Trash2 size={17} /> {event.plannerOwned ? "Quitar del calendario" : "Desvincular tarea"}
          </button>}
        </>}
      </div>
    </div>
  </div>;
}
