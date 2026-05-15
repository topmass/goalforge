export const TASK_STATUSES = [
  "inbox",
  "ready",
  "in_progress",
  "review",
  "blocked",
  "done",
] as const;

export type TaskStatus = typeof TASK_STATUSES[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: "Inbox",
  ready: "Ready",
  in_progress: "Started",
  review: "Review",
  blocked: "Waiting",
  done: "Done",
};

export interface Goal {
  id: string;
  text: string;
  createdAt: string;
}

export interface Task {
  id: string;
  goalId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  branchName: string | null;
  worktreePath: string | null;
  threadId: string | null;
  workpad: string;
  acceptanceCriteria: string;
  validation: string;
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDraft {
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: number;
  workpad?: string;
}

export interface Run {
  id: string;
  taskId: string;
  role: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt: string | null;
}

export interface ActivityEvent {
  id: number;
  taskId: string | null;
  runId: string | null;
  role: string;
  kind: string;
  message: string;
  createdAt: string;
  rawJson: string | null;
}

export type ActivityEventInput = Omit<ActivityEvent, "id" | "createdAt" | "rawJson"> & {
  raw?: unknown;
};

export interface BoardSnapshot {
  goals: Goal[];
  tasks: Task[];
  runs: Run[];
  events: ActivityEvent[];
  statuses: { id: TaskStatus; label: string }[];
}

export interface TransitionResult {
  task: Task;
  event: ActivityEvent;
}
