import { Avatar } from "@base-ui/react/avatar";
import { ChevronLeft, ChevronRight, RotateCw, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PlannerAssignee } from "@/lib/planner/types";

export type CalendarView = "timeGridDay" | "timeGridWorkweek" | "timeGridWeekend" | "timeGridWeek";
const views: [CalendarView, string][] = [
  ["timeGridDay", "Día"], ["timeGridWorkweek", "L–V"], ["timeGridWeekend", "S/D"], ["timeGridWeek", "Semana"],
];

type ToolbarProps = {
  title: string;
  view: CalendarView;
  busy: boolean;
  assignees: PlannerAssignee[];
  selectedAssigneeId: string;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  onView: (view: CalendarView) => void;
  onAssignee: (id: string) => void;
  onSync: () => void;
};

export function PlannerToolbar(props: ToolbarProps) {
  return <header className="workspace-header">
    <div className="period-heading">
      <h1>{props.title || "Calendario"}</h1>
      <div className="nav-buttons">
        <button aria-label="Periodo anterior" disabled={props.busy} onClick={props.onPrevious}><ChevronLeft size={18} /></button>
        <button aria-label="Periodo siguiente" disabled={props.busy} onClick={props.onNext}><ChevronRight size={18} /></button>
      </div>
    </div>
    <div className="header-actions">
      <div className="calendar-controls">
        <div className="view-switch">{views.map(([view, label]) => <button key={view}
          className={props.view === view ? "active" : ""} disabled={props.busy} onClick={() => props.onView(view)}>{label}</button>)}</div>
        <Button variant="outline" size="sm" className="today-button" disabled={props.busy} onClick={props.onToday}>Hoy</Button>
      </div>
      <div className="assignee-avatars" role="group" aria-label="Filtrar tareas por asignado">
        {props.assignees.map((assignee) => <button key={assignee.id} type="button" disabled={props.busy}
          className={props.selectedAssigneeId === assignee.id ? "selected" : ""}
          aria-label={`Filtrar por ${assignee.name}`} aria-pressed={props.selectedAssigneeId === assignee.id}
          title={`${assignee.name} · pulsa de nuevo para ver todos`} onClick={() => props.onAssignee(assignee.id)}>
          <AssigneeAvatar assignee={assignee} />
        </button>)}
      </div>
      <Button variant="outline" size="icon-sm" aria-label="Sincronizar" title="Sincronizar" disabled={props.busy} onClick={props.onSync}>
        <RotateCw size={16} className={props.busy ? "animate-spin" : ""} />
      </Button>
    </div>
  </header>;
}

function AssigneeAvatar({ assignee }: { assignee?: PlannerAssignee }) {
  return <Avatar.Root className="assignee-avatar">
    {assignee?.avatarUrl && <Avatar.Image src={assignee.avatarUrl} alt="" referrerPolicy="no-referrer" />}
    <Avatar.Fallback>{assignee ? assignee.name.slice(0, 1).toUpperCase() : <UsersRound size={15} />}</Avatar.Fallback>
  </Avatar.Root>;
}
