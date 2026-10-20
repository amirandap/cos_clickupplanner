import type { RefObject } from "react";
import { Archive, Plus, CalendarCheck, CalendarX, CalendarPlus, GripVertical, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import type { PlannerTask } from "@/lib/planner/types";
import { dateLabel, taskAgeLabel } from "./dates";

type TaskPanelProps = {
  hideScheduled: boolean;
  onToggleScheduled: () => void;
  groups: [string, PlannerTask[]][];
  timezone: string;
  search: string;
  busy: boolean;
  onSearch: (value: string) => void;
  onSchedule: (task: PlannerTask) => void;
  onArchive: (task: PlannerTask) => void;
  onCreate: (title: string) => void;
  onShowPlanned: (task: PlannerTask) => void;
  listRef: RefObject<HTMLDivElement | null>;
};

export function TaskPanel({ hideScheduled, onToggleScheduled, groups, timezone, search, busy, onSearch, onSchedule, onArchive, onCreate, onShowPlanned, listRef }: TaskPanelProps) {
  return <section className="task-panel" aria-label="Tareas de ClickUp">
    <div className="task-search">
      <Search size={16} />
      <Input aria-label="Buscar tareas" placeholder="Buscar tareas..." value={search}
        disabled={busy} onChange={(event) => onSearch(event.target.value)} />
      <button type="button" className={`task-icon-btn${hideScheduled ? " active" : ""}`} aria-pressed={hideScheduled}
        title={hideScheduled ? "Mostrar tareas agendadas" : "Ocultar tareas agendadas"} aria-label="Ocultar tareas agendadas"
        onClick={onToggleScheduled}><CalendarX size={14} /></button>
    </div>
    <div className="task-list" ref={listRef}>
      {groups.length ? groups.map(([status, tasks]) => <section className="task-status-group" key={status} aria-label={`Estado ${status}`}>
        <h2 className="task-status-heading"><span>{status}</span><span>{tasks.length}</span></h2>
        {tasks.map((task) => <TaskCard key={task.id} task={task} timezone={timezone} busy={busy} onSchedule={onSchedule} onArchive={onArchive} onShowPlanned={onShowPlanned} />)}
      </section>) : <div className="empty-tasks">No hay tareas que coincidan.</div>}
      {search.trim() && <button type="button" className="task-create" disabled={busy} onClick={() => onCreate(search.trim())}>
        <Plus size={14} />Crear «{search.trim()}» en AMP · backlog
      </button>}
    </div>
    <div className="panel-footer"><GripVertical size={14} />Agenda una tarea o arrástrala a una hora o sobre un evento</div>
  </section>;
}

function TaskCard({ task, timezone, busy, onSchedule, onArchive, onShowPlanned }: { task: PlannerTask; timezone: string; busy: boolean; onSchedule: (task: PlannerTask) => void; onArchive: (task: PlannerTask) => void; onShowPlanned: (task: PlannerTask) => void }) {
  return <article className="planner-task" data-task-id={task.id} data-title={task.title} data-disabled={busy}
    onClick={(event) => {
      if (task.url && !(event.target as HTMLElement).closest("a, button")) window.open(task.url, "_blank", "noopener,noreferrer");
    }}>
    <div className="task-content">
      <div className="task-heading">
        <h3>{task.actionUrl || task.url ? <a href={task.actionUrl || task.url || "#"} target="_blank" rel="noopener noreferrer"
          title={task.actionUrl ? "Abrir enlace relacionado" : "Abrir en ClickUp"}>{task.title}</a> : task.title}</h3>
        <div className="task-actions">
          {task.plannedCount > 0 && <button type="button" className="task-icon-btn planned-badge" title="Ver en el calendario" aria-label={`Ver ${task.title} en el calendario`}
            onClick={() => onShowPlanned(task)}><CalendarCheck size={14} /></button>}
          <button type="button" className="task-icon-btn" disabled={busy} title="Agendar" aria-label={`Agendar ${task.title}`}
            onClick={() => onSchedule(task)}><CalendarPlus size={14} /></button>
          <button type="button" className="task-icon-btn" disabled={busy} title="Archivar" aria-label={`Archivar ${task.title}`}
            onClick={() => onArchive(task)}><Archive size={14} /></button>
        </div>
      </div>
      <p className="task-meta">
        <span className={task.dueDate ? "" : "no-due"}>{task.dueDate ? `Vence ${dateLabel(task.dueDate, timezone)}` : "Sin vencimiento"}</span>
        <span title={task.createdAt ? `Creada ${dateLabel(task.createdAt, timezone)}` : undefined}>{taskAgeLabel(task.createdAt, timezone)}</span>
      </p>
      {task.description && <p className="task-description">{task.description}</p>}
    </div>
  </article>;
}
