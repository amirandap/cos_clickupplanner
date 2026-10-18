import type { RefObject } from "react";
import { Check, GripVertical, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { PlannerTask } from "@/lib/planner/types";
import { dateLabel, taskAgeLabel } from "./dates";

type TaskPanelProps = {
  groups: [string, PlannerTask[]][];
  timezone: string;
  search: string;
  busy: boolean;
  onSearch: (value: string) => void;
  onSchedule: (task: PlannerTask) => void;
  listRef: RefObject<HTMLDivElement | null>;
};

export function TaskPanel({ groups, timezone, search, busy, onSearch, onSchedule, listRef }: TaskPanelProps) {
  return <section className="task-panel" aria-label="Tareas de ClickUp">
    <div className="task-search">
      <Search size={16} />
      <Input aria-label="Buscar tareas" placeholder="Buscar tareas..." value={search}
        disabled={busy} onChange={(event) => onSearch(event.target.value)} />
    </div>
    <div className="task-list" ref={listRef}>
      {groups.length ? groups.map(([status, tasks]) => <section className="task-status-group" key={status} aria-label={`Estado ${status}`}>
        <h2 className="task-status-heading"><span>{status}</span><span>{tasks.length}</span></h2>
        {tasks.map((task) => <TaskCard key={task.id} task={task} timezone={timezone} busy={busy} onSchedule={onSchedule} />)}
      </section>) : <div className="empty-tasks">No hay tareas que coincidan.</div>}
    </div>
    <div className="panel-footer"><GripVertical size={14} />Agenda una tarea o arrástrala a una hora o sobre un evento</div>
  </section>;
}

function TaskCard({ task, timezone, busy, onSchedule }: { task: PlannerTask; timezone: string; busy: boolean; onSchedule: (task: PlannerTask) => void }) {
  return <article className="planner-task" data-task-id={task.id} data-title={task.title} data-disabled={busy}>
    <div className="task-content">
      <div className="task-heading">
        <h3>{task.actionUrl || task.url ? <a href={task.actionUrl || task.url || "#"} target="_blank" rel="noopener noreferrer"
          title={task.actionUrl ? "Abrir enlace relacionado" : "Abrir en ClickUp"}>{task.title}</a> : task.title}</h3>
        {task.plannedCount > 0 && <span className="planned-badge"><Check size={11} /> Planificada</span>}
      </div>
      <p className="task-meta">
        <span className={task.dueDate ? "" : "no-due"}>{task.dueDate ? `Vence ${dateLabel(task.dueDate, timezone)}` : "Sin vencimiento"}</span>
        <span title={task.createdAt ? `Creada ${dateLabel(task.createdAt, timezone)}` : undefined}>{taskAgeLabel(task.createdAt, timezone)}</span>
      </p>
      {task.description && <p className="task-description">{task.description}</p>}
      <Button type="button" variant="outline" size="sm" className="mt-2" disabled={busy}
        aria-label={`Agendar ${task.title}`} onClick={() => onSchedule(task)}>Agendar</Button>
    </div>
  </article>;
}
