export type PlannerAssignee = {
  id: string;
  name: string;
  avatarUrl: string | null;
};

export type PlannerTask = {
  id: string;
  title: string;
  status: string | null;
  priority: string | null;
  dueDate: string | null;
  createdAt: string | null;
  estimateMin: number | null;
  url: string | null;
  description: string | null;
  actionUrl: string | null;
  plannedCount: number;
  plannedEvent: { id: string; startAt: string } | null;
  completed: boolean;
  assignees: PlannerAssignee[];
};

export type PlannerEvent = {
  id: string;
  calendarId: string;
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  startDate: string | null;
  endDate: string | null;
  clickupTaskId: string | null;
  plannerOwned: boolean;
  recurring: boolean;
  hasMeet?: boolean;
  location?: string | null;
  htmlLink?: string | null;
};

export type PlannerData = {
  tasks: PlannerTask[];
  events: PlannerEvent[];
  timezone: string;
  defaultAssigneeId: string | null;
  mockMode: boolean;
  lastSyncAt: string | null;
};
