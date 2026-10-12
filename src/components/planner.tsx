"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import timeGridPlugin from "@fullcalendar/timegrid";
import luxonPlugin from "@fullcalendar/luxon3";
import interactionPlugin, { Draggable } from "@fullcalendar/interaction";
import type { DateClickArg, DropArg, EventResizeDoneArg } from "@fullcalendar/interaction";
import type { EventClickArg, EventDropArg } from "@fullcalendar/core";
import esLocale from "@fullcalendar/core/locales/es";
import { DateTime } from "luxon";
import { Avatar } from "@base-ui/react/avatar";
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { ArrowDownToLine, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, ExternalLink, GripVertical, Loader2, RotateCw, Search, Trash2, UsersRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PlannerAssignee, PlannerData, PlannerEvent, PlannerTask } from "@/lib/planner/types";

type Mode = { kind: "event"; id: string } | null;
type CalendarView = "timeGridDay" | "timeGridWorkweek" | "timeGridWeekend" | "timeGridWeek";

function dateLabel(value: string | null, timezone: string) {
  if (!value) return null;
  return new Intl.DateTimeFormat("es-DO", { day: "numeric", month: "short", timeZone: timezone }).format(new Date(value));
}
function taskAgeLabel(value: string | null, timezone: string) {
  if (!value) return "Edad desconocida";
  const days = Math.max(0, Math.floor(DateTime.now().setZone(timezone).startOf("day").diff(DateTime.fromISO(value).setZone(timezone).startOf("day"), "days").days));
  return days === 0 ? "Creada hoy" : `Hace ${days} ${days === 1 ? "día" : "días"}`;
}
async function requestJson(url: string, method = "GET", body?: unknown) {
  const response = await fetch(url, { method, headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Error ${response.status}`);
  return data;
}

export default function Planner({ initialData }: { initialData: PlannerData }) {
  const [data, setData] = useState(initialData);
  const timezone = data.timezone;
  const [search, setSearch] = useState("");
  const [selectedAssigneeId, setSelectedAssigneeId] = useState(() => initialData.defaultAssigneeId && initialData.tasks.some((task) => task.assignees.some((assignee) => assignee.id === initialData.defaultAssigneeId)) ? initialData.defaultAssigneeId : "all");
  const [view, setView] = useState<CalendarView>("timeGridWeek");
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<PlannerEvent | null>(null);
  const [mode, setMode] = useState<Mode>(null);
  const [dateTimeInput, setDateTimeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eventPeek, setEventPeek] = useState<{ title: string; time: string; left: number; top: number; below: boolean } | null>(null);
  const paneGroupRef = useGroupRef();
  const taskListRef = useRef<HTMLDivElement>(null);
  const calendarRef = useRef<InstanceType<typeof FullCalendar>>(null);
  const visibleRangeRef = useRef<{ start: string; end: string } | null>(null);
  const rangeRequestRef = useRef(0);
  const headerDragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const saved = Number(window.localStorage.getItem("clickup-planner:task-pane-size"));
    if (saved >= 20 && saved <= 60) paneGroupRef.current?.setLayout({ tasks: saved, calendar: 100 - saved });
  }, [paneGroupRef]);

  const assignees = useMemo(() => {
    const unique = new Map<string, PlannerAssignee>();
    for (const task of data.tasks) for (const assignee of task.assignees) unique.set(assignee.id, assignee);
    return [...unique.values()].sort((a, b) => a.id === data.defaultAssigneeId ? -1 : b.id === data.defaultAssigneeId ? 1 : a.name.localeCompare(b.name, "es"));
  }, [data.tasks, data.defaultAssigneeId]);
  const pendingTasks = useMemo(() => data.tasks.filter((task) => !task.completed && (selectedAssigneeId === "all" || task.assignees.some((assignee) => assignee.id === selectedAssigneeId))), [data.tasks, selectedAssigneeId]);
  const activeTasks = useMemo(() => pendingTasks.filter((task) => `${task.title} ${task.status ?? ""}`.toLowerCase().includes(search.toLowerCase())), [pendingTasks, search]);
  const groupedTasks = useMemo(() => {
    const groups = new Map<string, PlannerTask[]>();
    for (const task of activeTasks) {
      const status = task.status?.trim() || "Sin estado";
      groups.set(status, [...(groups.get(status) ?? []), task]);
    }
    return [...groups];
  }, [activeTasks]);
  const selectedTask = selected?.clickupTaskId ? data.tasks.find((task) => task.id === selected.clickupTaskId) : null;

  useEffect(() => {
    if (mode && window.innerWidth <= 760) document.querySelector(".selection-banner")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [mode]);

  useEffect(() => {
    const container = taskListRef.current;
    if (!container) return;
    const draggable = new Draggable(container, { itemSelector: ".planner-task", eventData: (element) => ({ title: element.getAttribute("data-title") ?? "Tarea", create: false }) });
    return () => draggable.destroy();
  }, []);

  async function refresh() {
    const requestId = ++rangeRequestRef.current;
    const range = visibleRangeRef.current;
    const query = range ? `?${new URLSearchParams(range)}` : "";
    const next = await requestJson(`/api/planner${query}`) as PlannerData;
    if (requestId === rangeRequestRef.current) setData(next);
  }
  async function run(operation: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await operation(); await refresh(); setSelected(null); setMode(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Ocurrió un error"); await refresh(); }
    finally { setBusy(false); }
  }
  function schedule(taskId: string, startAt: Date) { return run(() => requestJson("/api/planner/events", "POST", { taskId, startAt: startAt.toISOString() })); }
  function beginMode(next: Mode, date = new Date()) {
    setMode(next);
    setDateTimeInput(DateTime.fromJSDate(date).setZone(timezone).toFormat("yyyy-LL-dd\'T\'HH:mm"));
  }
  function saveMode() {
    if (!mode || !dateTimeInput) return;
    const start = new Date(`${dateTimeInput}:00-04:00`);
    const event = data.events.find((item) => item.id === mode.id);
    if (!event) return;
    const duration = new Date(event.endAt).getTime() - new Date(event.startAt).getTime();
    void run(() => requestJson("/api/planner/events", "PATCH", { id: event.id, startAt: start.toISOString(), endAt: new Date(start.getTime() + duration).toISOString() }));
  }
  function handleDrop(info: DropArg) {
    const taskId = info.draggedEl.getAttribute("data-task-id");
    if (!taskId) return;
    const target = document.elementsFromPoint(info.jsEvent.clientX, info.jsEvent.clientY)
      .map((element) => element.closest<HTMLElement>(".fc-event[data-event-id]"))
      .find((element) => element?.dataset.eventId);
    if (target?.dataset.eventId) {
      void run(() => requestJson("/api/planner/events", "PATCH", { id: target.dataset.eventId, taskId }));
      return;
    }
    const start = info.allDay ? new Date(`${info.dateStr.slice(0, 10)}T09:00:00-04:00`) : info.date;
    void schedule(taskId, start);
  }
  function handleHeaderPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!(event.target as Element).closest(".fc-col-header")) return;
    headerDragRef.current = { x: event.clientX, y: event.clientY };
  }
  function handleHeaderPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const start = headerDragRef.current;
    headerDragRef.current = null;
    if (!start) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(event.clientY - start.y)) return;
    if (dx < 0) calendarRef.current?.getApi().next();
    else calendarRef.current?.getApi().prev();
  }
  function handleDateClick(info: DateClickArg) {
    if (!mode) return;
    const start = info.allDay ? new Date(`${info.dateStr.slice(0, 10)}T09:00:00-04:00`) : info.date;
    const event = data.events.find((item) => item.id === mode.id);
    if (!event) return;
    const duration = new Date(event.endAt).getTime() - new Date(event.startAt).getTime();
    void run(() => requestJson("/api/planner/events", "PATCH", { id: event.id, startAt: start.toISOString(), endAt: new Date(start.getTime() + duration).toISOString() }));
  }
  function handleEventChange(info: EventDropArg | EventResizeDoneArg) {
    if (!info.event.start || !info.event.end || info.event.allDay) { info.revert(); return; }
    void run(async () => {
      try { await requestJson("/api/planner/events", "PATCH", { id: info.event.id, startAt: info.event.start?.toISOString(), endAt: info.event.end?.toISOString() }); }
      catch (cause) { info.revert(); throw cause; }
    });
  }
  function handleEventClick(info: EventClickArg) {
    setEventPeek(null);
    const event = data.events.find((item) => item.id === info.event.id);
    if (event) setSelected(event);
  }
  function showEventPeek(element: HTMLElement, eventId: string) {
    const event = data.events.find((item) => item.id === eventId);
    if (!event) return;
    const start = DateTime.fromISO(event.startAt).setZone(timezone).setLocale("es");
    const end = DateTime.fromISO(event.endAt).setZone(timezone).setLocale("es");
    const rect = element.getBoundingClientRect();
    setEventPeek({
      title: event.title,
      time: event.allDay ? "Todo el día" : `${start.toFormat("ccc d LLL · HH:mm")}–${end.toFormat("HH:mm")}`,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 292)),
      top: rect.top < 115 ? rect.bottom + 8 : rect.top - 8,
      below: rect.top < 115,
    });
  }
  function changeView(next: CalendarView) { setView(next); calendarRef.current?.getApi().changeView(next); }

  const events = data.events.map((event) => ({
    id: event.id, title: event.title, start: event.allDay ? event.startDate! : event.startAt, end: event.allDay ? event.endDate! : event.endAt, allDay: event.allDay,
    backgroundColor: event.clickupTaskId ? "#563ec9" : "#dce5e2",
    borderColor: event.clickupTaskId ? "#563ec9" : "#cbd5d1",
    textColor: event.clickupTaskId ? "#fff" : "#26312f",
    extendedProps: { clickupTaskId: event.clickupTaskId },
  }));

  return <main className="app-shell">
    <header className="workspace-header">
      <div className="period-heading"><h1>{title || "Calendario"}</h1><div className="nav-buttons"><button aria-label="Periodo anterior" onClick={() => calendarRef.current?.getApi().prev()}><ChevronLeft size={18} /></button><button aria-label="Periodo siguiente" onClick={() => calendarRef.current?.getApi().next()}><ChevronRight size={18} /></button></div></div>
      <div className="header-actions">
        <div className="calendar-controls"><div className="view-switch"><button className={view === "timeGridDay" ? "active" : ""} onClick={() => changeView("timeGridDay")}>Día</button><button className={view === "timeGridWorkweek" ? "active" : ""} onClick={() => changeView("timeGridWorkweek")}>L–V</button><button className={view === "timeGridWeekend" ? "active" : ""} onClick={() => changeView("timeGridWeekend")}>S/D</button><button className={view === "timeGridWeek" ? "active" : ""} onClick={() => changeView("timeGridWeek")}>Semana</button></div><Button variant="outline" size="sm" className="today-button" onClick={() => calendarRef.current?.getApi().today()}>Hoy</Button></div>
        <div className="assignee-avatars" role="group" aria-label="Filtrar tareas por asignado">{assignees.map((assignee) => <button key={assignee.id} type="button" className={selectedAssigneeId === assignee.id ? "selected" : ""} aria-label={`Filtrar por ${assignee.name}`} aria-pressed={selectedAssigneeId === assignee.id} title={`${assignee.name} · pulsa de nuevo para ver todos`} onClick={() => setSelectedAssigneeId((current) => current === assignee.id ? "all" : assignee.id)}><AssigneeAvatar assignee={assignee} /></button>)}</div>
        <Button variant="outline" size="icon-sm" aria-label="Sincronizar" title="Sincronizar" disabled={busy} onClick={() => void run(() => requestJson("/api/sync", "POST"))}><RotateCw size={16} className={busy ? "animate-spin" : ""} /></Button>
      </div>
    </header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Cerrar error" onClick={() => setError(null)}><X size={16} /></button></div>}
    {mode && <div className="selection-banner"><span>Elige un horario para reprogramar este bloque o toca un espacio en el calendario.</span><div className="selection-controls"><input aria-label="Fecha y hora del bloque" type="datetime-local" value={dateTimeInput} onChange={(event) => setDateTimeInput(event.target.value)} /><Button size="sm" disabled={busy || !dateTimeInput} onClick={saveMode}>Guardar</Button><Button variant="ghost" size="sm" onClick={() => setMode(null)}>Cancelar</Button></div></div>}
    <Group className="planner-grid" orientation="horizontal" groupRef={paneGroupRef} onLayoutChanged={(layout, meta) => { if (meta.isUserInteraction && layout.tasks) window.localStorage.setItem("clickup-planner:task-pane-size", String(layout.tasks)); }}>
      <Panel id="tasks" defaultSize="32%" minSize="220px" maxSize="60%"><section className="task-panel" aria-label="Tareas de ClickUp"><div className="task-search"><Search size={16} /><Input aria-label="Buscar tareas" placeholder="Buscar tareas..." value={search} onChange={(event) => setSearch(event.target.value)} /></div><div className="task-list" ref={taskListRef}>{groupedTasks.length ? groupedTasks.map(([status, tasks]) => <section className="task-status-group" key={status} aria-label={`Estado ${status}`}><h2 className="task-status-heading"><span>{status}</span><span>{tasks.length}</span></h2>{tasks.map((task) => <TaskCard key={task.id} task={task} timezone={timezone} />)}</section>) : <div className="empty-tasks">No hay tareas que coincidan.</div>}</div><div className="panel-footer"><GripVertical size={14} />Arrastra una tarea a una hora o sobre un evento para vincularla</div></section></Panel>
      <Separator className="pane-separator" aria-label="Ajustar ancho de tareas y calendario"><span aria-hidden="true" /></Separator>
      <Panel id="calendar" minSize="420px" onResize={() => calendarRef.current?.getApi().updateSize()}><section className="calendar-panel" aria-label="Calendario"><div className="calendar-canvas" onPointerDown={handleHeaderPointerDown} onPointerUp={handleHeaderPointerUp} onPointerCancel={() => { headerDragRef.current = null; }} onFocusCapture={(event) => { const element = (event.target as HTMLElement).closest<HTMLElement>(".fc-event[data-event-id]"); if (element?.dataset.eventId) showEventPeek(element, element.dataset.eventId); }} onBlurCapture={() => setEventPeek(null)}><FullCalendar ref={calendarRef} plugins={[timeGridPlugin, interactionPlugin, luxonPlugin]} initialView="timeGridWeek" views={{ timeGridWorkweek: { type: "timeGridWeek", hiddenDays: [0, 6] }, timeGridWeekend: { type: "timeGridWeek", hiddenDays: [1, 2, 3, 4, 5] } }} locale={esLocale} timeZone={timezone} headerToolbar={false} navLinks navLinkDayClick={(date) => { setView("timeGridDay"); calendarRef.current?.getApi().changeView("timeGridDay", date); }} allDaySlot={false} slotMinTime="06:00:00" slotMaxTime="23:00:00" slotDuration="00:30:00" slotLabelInterval="01:00:00" slotLabelFormat={{ hour: "numeric", hour12: false }} displayEventTime={false} nowIndicator height="auto" contentHeight="auto" expandRows droppable editable selectable eventDurationEditable events={events} eventDidMount={(info) => { info.el.dataset.eventId = info.event.id; info.el.setAttribute("aria-label", info.event.title); }} eventMouseEnter={(info) => showEventPeek(info.el, info.event.id)} eventMouseLeave={() => setEventPeek(null)} drop={handleDrop} dateClick={handleDateClick} eventClick={handleEventClick} eventDrop={handleEventChange} eventResize={handleEventChange} datesSet={(info) => { setTitle(info.view.title); visibleRangeRef.current = { start: info.start.toISOString(), end: info.end.toISOString() }; void refresh(); }} /></div></section></Panel>
    </Group>
    {eventPeek && !selected && <div className={`event-peek${eventPeek.below ? " below" : ""}`} style={{ left: eventPeek.left, top: eventPeek.top }} role="tooltip"><strong>{eventPeek.title}</strong><span>{eventPeek.time}</span></div>}
    {selected && <div className="modal-backdrop" onMouseDown={() => setSelected(null)}><div className="event-modal" role="dialog" aria-modal="true" aria-labelledby="event-title" onMouseDown={(event) => event.stopPropagation()}><div className="modal-top"><div className="modal-icon"><CalendarDays size={20} /></div><button aria-label="Cerrar" onClick={() => setSelected(null)}><X size={18} /></button></div><p className="modal-kicker">{selected.allDay ? "TODO EL DÍA" : "BLOQUE DE TIEMPO"}</p><h2 id="event-title">{selected.title}</h2><p className="modal-time"><Clock3 size={16} />{selected.allDay && selected.startDate ? `${new Intl.DateTimeFormat("es-DO", { weekday: "long", day: "numeric", month: "long", timeZone: timezone }).format(DateTime.fromISO(selected.startDate, { zone: timezone }).toJSDate())} · Todo el día` : new Intl.DateTimeFormat("es-DO", { weekday: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone }).format(new Date(selected.startAt))}</p>{selectedTask ? <div className="modal-actions"><a className="modal-action" href={selectedTask.url ?? `https://app.clickup.com/t/${selectedTask.id}`} target="_blank" rel="noopener noreferrer"><ExternalLink size={17} /> Abrir en ClickUp</a><button className="modal-action" disabled={busy} onClick={() => void run(() => requestJson("/api/planner/tasks", "PATCH", { id: selectedTask.id }))}><Check size={17} /> Marcar como completada</button><button className="modal-action" onClick={() => { beginMode({ kind: "event", id: selected.id }, new Date(selected.startAt)); setSelected(null); }}><ArrowDownToLine size={17} /> Reprogramar</button><button className="modal-action destructive" disabled={busy} onClick={() => void run(() => requestJson("/api/planner/events", "DELETE", { id: selected.id }))}><Trash2 size={17} /> {selected.plannerOwned ? "Quitar del calendario" : "Desvincular tarea"}</button></div> : <div className="modal-actions"><button className="modal-action" onClick={() => { beginMode({ kind: "event", id: selected.id }, new Date(selected.startAt)); setSelected(null); }}><ArrowDownToLine size={17} /> Reprogramar en Google Calendar</button></div>}</div></div>}
    {busy && <div className="busy-indicator" role="status"><Loader2 size={16} className="animate-spin" /> Guardando...</div>}
  </main>;
}

function TaskCard({ task, timezone }: { task: PlannerTask; timezone: string }) {
  return <article className="planner-task" data-task-id={task.id} data-title={task.title}>
    <div className="task-content">
      <div className="task-heading"><h3>{task.actionUrl || task.url ? <a href={task.actionUrl || task.url || "#"} target="_blank" rel="noopener noreferrer" title={task.actionUrl ? "Abrir enlace relacionado" : "Abrir en ClickUp"}>{task.title}</a> : task.title}</h3>{task.plannedCount > 0 && <span className="planned-badge"><Check size={11} /> Planificada</span>}</div>
      <p className="task-meta"><span className={task.dueDate ? "" : "no-due"}>{task.dueDate ? `Vence ${dateLabel(task.dueDate, timezone)}` : "Sin vencimiento"}</span><span title={task.createdAt ? `Creada ${dateLabel(task.createdAt, timezone)}` : undefined}>{taskAgeLabel(task.createdAt, timezone)}</span></p>
      {task.description && <p className="task-description">{task.description}</p>}
    </div>
  </article>;
}

function AssigneeAvatar({ assignee }: { assignee?: PlannerAssignee }) {
  return <Avatar.Root className="assignee-avatar">
    {assignee?.avatarUrl && <Avatar.Image src={assignee.avatarUrl} alt="" referrerPolicy="no-referrer" />}
    <Avatar.Fallback>{assignee ? assignee.name.slice(0, 1).toUpperCase() : <UsersRound size={15} />}</Avatar.Fallback>
  </Avatar.Root>;
}
