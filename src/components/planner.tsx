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
import { Group, Panel, Separator, useGroupRef } from "react-resizable-panels";
import { Loader2, X } from "lucide-react";
import type { PlannerAssignee, PlannerData, PlannerEvent, PlannerTask } from "@/lib/planner/types";
import { allDayStart, formatDateTimeInput, parseDateTimeInput } from "./planner/dates";
import { isMutationResult, isSyncResult, jsonRequest, persistCalendarEdit, requestJson } from "./planner/client";
import { EventModal } from "./planner/event-modal";
import { TaskPanel } from "./planner/task-panel";
import { PlannerToolbar, type CalendarView } from "./planner/toolbar";
import { usePlannerOperations } from "./planner/use-planner-operations";
import { linkableEvents, taskSelectionIntent } from "./planner/selection";
import { SelectionBanner } from "./planner/selection-banner";

type EventPeek = { title: string; time: string; left: number; top: number; below: boolean };

const INITIAL_SEARCH = typeof window === "undefined" ? "" : window.location.search;

export default function Planner({ initialData }: { initialData: PlannerData }) {
  const { data, busy, error, warning, setError, setWarning, loadRange, run, schedule } = usePlannerOperations(initialData);
  const timezone = data.timezone;
  const archivedRef = useRef<string[]>([]);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const [highlightId, setHighlightId] = useState<string | null>(null);

  function showPlanned(task: PlannerTask) {
    if (!task.plannedEvent) return;
    const api = calendarRef.current?.getApi();
    const target = DateTime.fromISO(task.plannedEvent.startAt, { zone: timezone });
    api?.gotoDate(target.toISO() ?? task.plannedEvent.startAt);
    setHighlightId(task.plannedEvent.id);
    const id = task.plannedEvent.id;
    window.setTimeout(() => {
      document.querySelector(`.fc-event[data-event-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    }, 400);
    window.setTimeout(() => setHighlightId((current) => current === id ? null : current), 6000);
  }

  function archiveTask(task: PlannerTask) {
    void run(() => requestJson("/api/planner/tasks", jsonRequest("DELETE", { id: task.id }), isMutationResult)).then((saved) => {
      if (saved) archivedRef.current.push(task.id);
    });
  }

  function createTask(title: string) {
    void run(() => requestJson("/api/planner/tasks", jsonRequest("PUT", { title }), isMutationResult)).then((saved) => {
      if (!saved) return;
      setPinnedTitle(title.toLowerCase());
      setSearch("");
      setHideScheduled(false);
      setSelectedAssigneeId("all");
      taskListRef.current?.scrollTo({ top: 0 });
    });
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "z") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']") || busyRef.current) return;
      const id = archivedRef.current[archivedRef.current.length - 1];
      if (!id) return;
      event.preventDefault();
      void run(() => requestJson("/api/planner/tasks", jsonRequest("POST", { id }), isMutationResult)).then((saved) => {
        if (saved) archivedRef.current.pop();
      });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [run]);
  const [search, setSearch] = useState("");
  const [pinnedTitle, setPinnedTitle] = useState<string | null>(null);
  const [selectedAssigneeId, setSelectedAssigneeId] = useState(() => initialData.defaultAssigneeId
    && initialData.tasks.some((task) => task.assignees.some((person) => person.id === initialData.defaultAssigneeId))
    ? initialData.defaultAssigneeId : "all");
  const [view, setView] = useState<CalendarView>("timeGridWeek");
  const [title, setTitle] = useState("");
  const [showDesc, setShowDesc] = useState(false);
  const showDescRef = useRef(false);
  const [hideScheduled, setHideScheduled] = useState(true);
  const hideScheduledRef = useRef(true);
  const urlReadyRef = useRef(false);
  const currentDateRef = useRef("");
  useEffect(() => {
    const params = new URLSearchParams(INITIAL_SEARCH);
    const wanted = params.get("view");
    const date = params.get("date");
    const assignee = params.get("assignee");
    if (assignee && initialData.tasks.some((task) => task.assignees.some((person) => person.id === assignee))) setSelectedAssigneeId(assignee);
    showDescRef.current = ["1", "true"].includes(params.get("desc") ?? "");
    setShowDesc(showDescRef.current);
    hideScheduledRef.current = !["1", "true"].includes(params.get("scheduled") ?? "");
    setHideScheduled(hideScheduledRef.current);
    urlReadyRef.current = true;
    const api = calendarRef.current?.getApi();
    const valid: CalendarView[] = ["timeGridDay", "timeGridWorkweek", "timeGridWeekend", "timeGridWeek"];
    if (api && wanted && (valid as string[]).includes(wanted)) {
      setView(wanted as CalendarView);
      api.changeView(wanted, date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined);
    } else if (api && date && /^\d{4}-\d{2}-\d{2}$/.test(date)) api.gotoDate(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const skipFirstUrlWriteRef = useRef(true);
  useEffect(() => {
    if (skipFirstUrlWriteRef.current) { skipFirstUrlWriteRef.current = false; return; }
    if (urlReadyRef.current && currentDateRef.current) writeUrl(view, currentDateRef.current, selectedAssigneeId);
  }, [view, selectedAssigneeId]);
  const [selected, setSelected] = useState<PlannerEvent | null>(null);
  const [rescheduleId, setRescheduleId] = useState<string | null>(null);
  const [scheduleTaskId, setScheduleTaskId] = useState<string | null>(null);
  const [linkEventId, setLinkEventId] = useState("");
  const [dateTimeInput, setDateTimeInput] = useState("");
  const [eventPeek, setEventPeek] = useState<EventPeek | null>(null);
  const paneGroupRef = useGroupRef();
  const taskListRef = useRef<HTMLDivElement>(null);
  const calendarRef = useRef<InstanceType<typeof FullCalendar>>(null);
  const headerDragRef = useRef<{ x: number; y: number } | null>(null);
  const dateTimeInputRef = useRef<HTMLInputElement>(null);
  const selectionTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem("clickup-planner:task-pane-size-v2"));
      if (saved >= 20 && saved <= 60) paneGroupRef.current?.setLayout({ tasks: saved, calendar: 100 - saved });
    } catch { /* Pane size is optional when browser storage is unavailable. */ }
  }, [paneGroupRef]);

  useEffect(() => {
    const container = taskListRef.current;
    if (!container) return;
    function stopControlDrag(event: Event) {
      const target = event.target;
      if (target instanceof Element && target.closest("button,input,select,textarea,[role='button'],[contenteditable='true']")) {
        event.stopPropagation();
      }
    }
    // Links stay draggable; a drag that began on a link must not open it on release.
    let downAt: { x: number; y: number } | null = null;
    let dragged = false;
    const onDown = (event: MouseEvent) => { downAt = { x: event.clientX, y: event.clientY }; dragged = false; };
    const onMove = (event: MouseEvent) => {
      if (downAt && Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 4) dragged = true;
    };
    const onClickCapture = (event: MouseEvent) => {
      if (dragged && event.target instanceof Element && event.target.closest("a")) { event.preventDefault(); event.stopPropagation(); }
      dragged = false; downAt = null;
    };
    container.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    container.addEventListener("click", onClickCapture, true);
    container.addEventListener("dragstart", (event) => event.preventDefault());
    // FullCalendar starts external drags from native mouse/touch events on this list.
    container.addEventListener("mousedown", stopControlDrag, true);
    container.addEventListener("touchstart", stopControlDrag, { capture: true, passive: true });
    const draggable = new Draggable(container, {
      itemSelector: ".planner-task:not([data-disabled='true'])",
      eventData: (element) => ({ title: element.getAttribute("data-title") ?? "Tarea", create: false }),
    });
    return () => {
      draggable.destroy();
      container.removeEventListener("mousedown", stopControlDrag, true);
      container.removeEventListener("touchstart", stopControlDrag, true);
      container.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mousemove", onMove, true);
      container.removeEventListener("click", onClickCapture, true);
    };
  }, []);

  useEffect(() => {
    if (!rescheduleId && !scheduleTaskId) return;
    dateTimeInputRef.current?.focus();
    if (window.innerWidth <= 760) {
      document.querySelector(".selection-banner")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [rescheduleId, scheduleTaskId]);

  const assignees = useMemo(() => {
    const unique = new Map<string, PlannerAssignee>();
    for (const task of data.tasks) for (const person of task.assignees) unique.set(person.id, person);
    return [...unique.values()].sort((a, b) => a.id === data.defaultAssigneeId ? -1
      : b.id === data.defaultAssigneeId ? 1 : a.name.localeCompare(b.name, "es"));
  }, [data.tasks, data.defaultAssigneeId]);

  const groupedTasks = useMemo(() => {
    const groups = new Map<string, PlannerTask[]>();
    for (const task of data.tasks) {
      if (task.completed || (selectedAssigneeId !== "all" && !task.assignees.some((person) => person.id === selectedAssigneeId))) continue;
      if (hideScheduled && task.plannedCount > 0) continue;
      if (!`${task.title} ${task.status ?? ""}`.toLowerCase().includes(search.toLowerCase())) continue;
      const status = task.status?.trim() || "Sin estado";
      const tasks = groups.get(status) ?? [];
      tasks.push(task);
      groups.set(status, tasks);
    }
    if (pinnedTitle) for (const tasks of groups.values()) {
      const index = tasks.findIndex((task) => task.title.toLowerCase() === pinnedTitle);
      if (index > 0) tasks.unshift(...tasks.splice(index, 1));
    }
    return [...groups];
  }, [data.tasks, search, selectedAssigneeId, hideScheduled, pinnedTitle]);

  const selectedTask = selected?.clickupTaskId ? data.tasks.find((task) => task.id === selected.clickupTaskId) : null;
  const schedulingTask = data.tasks.find((task) => task.id === scheduleTaskId);
  const linkEvents = scheduleTaskId ? linkableEvents(data.events, scheduleTaskId) : [];
  const events = data.events.map((event) => ({
    id: event.id,
    title: event.title,
    start: event.allDay ? event.startDate! : event.startAt,
    end: event.allDay ? event.endDate! : event.endAt,
    allDay: event.allDay,
    editable: !event.recurring && !busy,
    backgroundColor: event.clickupTaskId ? "#563ec9" : event.hasMeet ? "#1a73e8" : event.location ? "#e8710a" : "#7a8f88",
    textColor: "#fff",
    classNames: event.id === highlightId ? ["event-highlight"] : [],
    extendedProps: { clickupTaskId: event.clickupTaskId, hasMeet: Boolean(event.hasMeet), location: event.location ?? null },
  }));

  function closeSelection() {
    setSelected(null);
    setRescheduleId(null);
    setScheduleTaskId(null);
    setLinkEventId("");
    const trigger = selectionTriggerRef.current;
    selectionTriggerRef.current = null;
    if (trigger) window.requestAnimationFrame(() => { if (trigger.isConnected) trigger.focus(); });
  }

  function beginSchedule(task: PlannerTask) {
    if (busy) return;
    selectionTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRescheduleId(null);
    setSelected(null);
    setLinkEventId("");
    setScheduleTaskId(task.id);
    setDateTimeInput(formatDateTimeInput(new Date(), timezone));
  }

  function beginReschedule(event: PlannerEvent) {
    if (busy || event.recurring) return;
    setRescheduleId(event.id);
    setScheduleTaskId(null);
    setLinkEventId("");
    setDateTimeInput(formatDateTimeInput(new Date(event.startAt), timezone));
    setSelected(null);
  }

  function moveEvent(event: PlannerEvent, start: Date) {
    if (busy || event.recurring) return;
    const duration = new Date(event.endAt).getTime() - new Date(event.startAt).getTime();
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(duration) || duration <= 0) {
      setError("La fecha o la duración del bloque no es válida.");
      return;
    }
    void run(() => requestJson("/api/planner/events", jsonRequest("PATCH", {
      id: event.id, startAt: start.toISOString(), endAt: new Date(start.getTime() + duration).toISOString(),
    }), isMutationResult), closeSelection);
  }

  function saveReschedule() {
    if (!rescheduleId || busy) return;
    const event = data.events.find((item) => item.id === rescheduleId);
    if (!event) return;
    const start = parseDateTimeInput(dateTimeInput, timezone, new Date(event.startAt));
    if (!start) { setError("Elige una fecha y hora válida. Si coincide con un cambio de horario, selecciona otra hora."); return; }
    moveEvent(event, start);
  }

  function saveSelection() {
    if (rescheduleId) { saveReschedule(); return; }
    if (!scheduleTaskId || busy) return;
    try {
      const intent = taskSelectionIntent(scheduleTaskId, dateTimeInput, timezone, linkEventId, data.events);
      void run(() => intent.kind === "link"
        ? requestJson("/api/planner/events", jsonRequest("PATCH", { taskId: intent.taskId, id: intent.id }), isMutationResult)
        : schedule(intent.taskId, intent.startAt), closeSelection);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo agendar la tarea."); }
  }

  function calendarStart(info: DropArg | DateClickArg): Date | null {
    const start = info.allDay ? allDayStart(info.dateStr.slice(0, 10), timezone) : info.date;
    if (!start || !Number.isFinite(start.getTime())) {
      setError("Elige una fecha y hora válida en la zona horaria del calendario.");
      return null;
    }
    return start;
  }

  function handleDrop(info: DropArg) {
    if (busy) return;
    const taskId = info.draggedEl.getAttribute("data-task-id");
    if (!taskId) return;
    const target = document.elementsFromPoint(info.jsEvent.clientX, info.jsEvent.clientY)
      .map((element) => element.closest<HTMLElement>(".fc-event[data-event-id]"))
      .find((element) => element?.dataset.eventId);
    const targetId = target?.dataset.eventId;
    if (targetId) {
      if (data.events.find((event) => event.id === targetId)?.recurring) {
        setError("Los eventos recurrentes se gestionan desde Google Calendar.");
        return;
      }
      void run(() => requestJson("/api/planner/events", jsonRequest("PATCH", { id: targetId, taskId }), isMutationResult), closeSelection);
      return;
    }
    const start = calendarStart(info);
    if (!start) return;
    // Dropping on a time slot already occupied by an event links it instead of creating another.
    const overlapping = info.allDay ? undefined : data.events.find((event) => !event.allDay && !event.recurring
      && (!event.clickupTaskId || event.clickupTaskId === taskId)
      && new Date(event.startAt) <= start && start < new Date(event.endAt));
    if (overlapping) {
      void run(() => requestJson("/api/planner/events", jsonRequest("PATCH", { id: overlapping.id, taskId }), isMutationResult), closeSelection);
      return;
    }
    void run(() => schedule(taskId, start.toISOString()), closeSelection);
  }

  function handleDateClick(info: DateClickArg) {
    if (!rescheduleId || busy) return;
    const event = data.events.find((item) => item.id === rescheduleId);
    const start = calendarStart(info);
    if (event && start) moveEvent(event, start);
  }

  function handleEventDragStop(info: { event: { id: string }; jsEvent: MouseEvent | TouchEvent }) {
    if (busy) return;
    const point = "changedTouches" in info.jsEvent ? info.jsEvent.changedTouches[0] : info.jsEvent as MouseEvent;
    const taskEl = document.elementsFromPoint(point.clientX, point.clientY)
      .map((element) => element.closest<HTMLElement>(".planner-task[data-task-id]")).find(Boolean);
    const taskId = taskEl?.dataset.taskId;
    if (!taskId) return;
    if (data.events.find((event) => event.id === info.event.id)?.recurring) {
      setError("Los eventos recurrentes se gestionan desde Google Calendar.");
      return;
    }
    void run(() => requestJson("/api/planner/events", jsonRequest("PATCH", { id: info.event.id, taskId }), isMutationResult), closeSelection);
  }

  function handleEventChange(info: EventDropArg | EventResizeDoneArg) {
    const event = data.events.find((item) => item.id === info.event.id);
    if (busy || event?.recurring || !info.event.start || !info.event.end || info.event.allDay) { info.revert(); return; }
    void persistCalendarEdit({
      id: info.event.id, startAt: info.event.start.toISOString(), endAt: info.event.end.toISOString(),
    }, info.revert, (operation) => run(operation, closeSelection));
  }

  function handleEventClick(info: EventClickArg) {
    if (busy) return;
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
      time: event.allDay ? "Todo el día" : `${start.toFormat("ccc d LLL · h:mm a")}–${end.toFormat("h:mm a")}`,
      left: Math.max(12, Math.min(rect.left, window.innerWidth - 292)),
      top: rect.top < 115 ? rect.bottom + 8 : rect.top - 8,
      below: rect.top < 115,
    });
  }

  function handleHeaderPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!busy && (event.target as Element).closest(".fc-col-header")) headerDragRef.current = { x: event.clientX, y: event.clientY };
  }

  function handleHeaderPointerUp(event: React.PointerEvent<HTMLDivElement>) {
    const start = headerDragRef.current;
    headerDragRef.current = null;
    if (!start || busy) return;
    const dx = event.clientX - start.x;
    if (Math.abs(dx) < 55 || Math.abs(dx) < Math.abs(event.clientY - start.y)) return;
    if (dx < 0) calendarRef.current?.getApi().next();
    else calendarRef.current?.getApi().prev();
  }

  function writeUrl(nextView: string, date: string, assignee: string) {
    const params = new URLSearchParams();
    params.set("view", nextView);
    params.set("date", date);
    if (assignee !== "all") params.set("assignee", assignee);
    if (showDescRef.current) params.set("desc", "1");
    if (!hideScheduledRef.current) params.set("scheduled", "1");
    window.history.replaceState(null, "", `?${params.toString()}`);
  }

  function changeView(next: CalendarView) {
    if (busy) return;
    setView(next);
    calendarRef.current?.getApi().changeView(next);
  }

  return <main className="app-shell" aria-busy={busy}>
    <PlannerToolbar title={title} view={view} busy={busy} assignees={assignees} selectedAssigneeId={selectedAssigneeId}
      onPrevious={() => calendarRef.current?.getApi().prev()} onNext={() => calendarRef.current?.getApi().next()}
      onToday={() => calendarRef.current?.getApi().today()} onView={changeView}
      onAssignee={(id) => setSelectedAssigneeId((current) => current === id ? "all" : id)}
      onSync={() => { void run(() => requestJson("/api/sync", jsonRequest("POST"), isSyncResult), closeSelection); }} />
    {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Cerrar error" onClick={() => setError(null)}><X size={16} /></button></div>}
    {warning && <div className="error-banner" role="status"><span>{warning}</span><button aria-label="Cerrar aviso" onClick={() => setWarning(null)}><X size={16} /></button></div>}
    {(rescheduleId || scheduleTaskId) && <SelectionBanner taskTitle={schedulingTask?.title} timezone={timezone}
      inputRef={dateTimeInputRef} dateTimeInput={dateTimeInput} linkEventId={linkEventId} linkEvents={linkEvents} busy={busy}
      onDateTime={setDateTimeInput} onEvent={setLinkEventId} onSave={saveSelection} onCancel={closeSelection} />}
    <Group className={showDesc ? "planner-grid show-desc" : "planner-grid"} orientation="horizontal" groupRef={paneGroupRef} onLayoutChanged={(layout, meta) => {
      if (meta.isUserInteraction && layout.tasks) {
        try { window.localStorage.setItem("clickup-planner:task-pane-size-v2", String(layout.tasks)); }
        catch { /* Resizing still works when browser storage is unavailable. */ }
      }
    }}>
      <Panel id="tasks" defaultSize="24%" minSize="220px" maxSize="60%">
        <TaskPanel hideScheduled={hideScheduled} onToggleScheduled={() => {
            const next = !hideScheduledRef.current;
            hideScheduledRef.current = next; setHideScheduled(next);
            if (currentDateRef.current) writeUrl(view, currentDateRef.current, selectedAssigneeId);
          }} groups={groupedTasks} timezone={timezone} search={search} busy={busy} onSearch={setSearch}
          onSchedule={beginSchedule} onCreate={createTask} onShowPlanned={showPlanned} onArchive={(task) => {
            archiveTask(task);
          }} listRef={taskListRef} />
      </Panel>
      <Separator className="pane-separator" aria-label="Ajustar ancho de tareas y calendario"><span aria-hidden="true" /></Separator>
      <Panel id="calendar" minSize="420px" onResize={() => calendarRef.current?.getApi().updateSize()}>
        <section className="calendar-panel" aria-label="Calendario">
          <div className="calendar-canvas" onPointerDown={handleHeaderPointerDown} onPointerUp={handleHeaderPointerUp}
            onPointerCancel={() => { headerDragRef.current = null; }} onFocusCapture={(event) => {
              const element = (event.target as HTMLElement).closest<HTMLElement>(".fc-event[data-event-id]");
              if (element?.dataset.eventId) showEventPeek(element, element.dataset.eventId);
            }} onBlurCapture={() => setEventPeek(null)}>
            <FullCalendar ref={calendarRef} plugins={[timeGridPlugin, interactionPlugin, luxonPlugin]} initialView="timeGridWeek"
              views={{ timeGridWorkweek: { type: "timeGridWeek", hiddenDays: [0, 6] }, timeGridWeekend: { type: "timeGridWeek", hiddenDays: [1, 2, 3, 4, 5] } }}
              locale={esLocale} timeZone={timezone} headerToolbar={false} navLinks={!busy} navLinkDayClick={(date) => {
                if (busy) return;
                setView("timeGridDay"); calendarRef.current?.getApi().changeView("timeGridDay", date);
              }} allDaySlot allDayText="∞" slotMinTime="06:00:00" slotMaxTime="23:00:00" slotDuration="00:30:00" snapDuration="00:15:00" defaultTimedEventDuration="00:30:00" slotLabelInterval="01:00:00"
              slotLabelFormat={(arg) => { const h = arg.date.hour; return `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`; }} displayEventTime={false} nowIndicator height="auto" contentHeight="auto"
              expandRows slotEventOverlap eventMinHeight={22} droppable={!busy} editable={!busy} selectable={!busy} eventDurationEditable={!busy} events={events}
              eventContent={(arg) => (
                <div className="fc-event-main-frame">
                  <div className="fc-event-title">{arg.event.extendedProps.hasMeet ? "📹 " : ""}{arg.event.extendedProps.location ? "📍 " : ""}{arg.event.title}</div>
                </div>
              )}
              eventClassNames={(arg) => (arg.event.extendedProps.clickupTaskId ? ["is-clickup"] : [])}
              eventDidMount={(info) => { info.el.title = info.event.title; info.el.dataset.eventId = info.event.id; info.el.setAttribute("aria-label", info.event.title); }}
              eventMouseEnter={(info) => showEventPeek(info.el, info.event.id)} eventMouseLeave={() => setEventPeek(null)}
              drop={handleDrop} dateClick={handleDateClick} eventClick={handleEventClick} eventDragStop={handleEventDragStop} eventDrop={handleEventChange} eventResize={handleEventChange}
              datesSet={(info) => {
                setTitle(info.view.title); currentDateRef.current = info.startStr.slice(0, 10);
                if (urlReadyRef.current) writeUrl(info.view.type, currentDateRef.current, selectedAssigneeId);
                loadRange({ start: info.start.toISOString(), end: info.end.toISOString() }); }} />
          </div>
        </section>
      </Panel>
    </Group>
    {eventPeek && !selected && <div className={`event-peek${eventPeek.below ? " below" : ""}`}
      style={{ left: eventPeek.left, top: eventPeek.top }} role="tooltip"><strong>{eventPeek.title}</strong><span>{eventPeek.time}</span></div>}
    {selected && <EventModal event={selected} task={selectedTask} timezone={timezone} busy={busy} onClose={() => setSelected(null)}
      onReschedule={() => beginReschedule(selected)}
      onDelete={() => { void run(() => requestJson("/api/planner/events", jsonRequest("DELETE", { id: selected.id, hard: true }), isMutationResult), closeSelection); }}
      onRename={(title) => { void run(() => requestJson("/api/planner/events", jsonRequest("PATCH", { id: selected.id, title }), isMutationResult), closeSelection); }}
      onComplete={() => { if (selectedTask) void run(() => requestJson("/api/planner/tasks", jsonRequest("PATCH", { id: selectedTask.id }), isMutationResult), closeSelection); }}
      onRemove={() => { void run(() => requestJson("/api/planner/events", jsonRequest("DELETE", { id: selected.id }), isMutationResult), closeSelection); }} />}
    {busy && <div className="busy-indicator" role="status"><Loader2 size={16} className="animate-spin" /> Guardando...</div>}
  </main>;
}
