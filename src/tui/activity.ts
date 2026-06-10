import { blockedExplanation } from "./task_recommendation.ts";

export interface ActivityLike {
  taskId: string | null;
  role: string;
  kind: string;
  message: string;
  createdAt: string;
}

export interface ActivityTaskLike {
  id: string;
  title: string;
}

export function activityLine(event: ActivityLike, tasks: ActivityTaskLike[]): string {
  const task = event.taskId ? tasks.find((item) => item.id === event.taskId) ?? null : null;
  const label = task ? short(task.title, 34) : "Project";
  return `${friendlyActivity(event, label, tasks)}  ${timeOnly(event.createdAt)}`;
}

export function displayEvents(events: ActivityLike[]): ActivityLike[] {
  return events.filter((event) => {
    const message = event.message.trim();
    if (!message || event.kind.includes("tokenUsage")) {
      return false;
    }
    if (["thread/tokenUsage/updated", "account/rateLimits/updated"].includes(event.kind)) {
      return false;
    }
    if (event.kind.startsWith("mcpServer/")) {
      return false;
    }
    if (message.startsWith("Codex event: hook/")) {
      return false;
    }
    if (isNoisyAgentDelta(event, message)) {
      return false;
    }
    if (
      message === "Started userMessage." ||
      message === "Completed userMessage." ||
      message === "Started reasoning." ||
      message === "Completed reasoning."
    ) {
      return false;
    }
    return true;
  });
}

function isNoisyAgentDelta(event: ActivityLike, message: string): boolean {
  if (event.kind !== "agent") {
    return false;
  }
  if (event.role !== "codex" && event.role !== "main-thread") {
    return false;
  }
  if (message.startsWith("{") || message.startsWith("[")) {
    return false;
  }
  if (/^(APPROVED|CHANGES_REQUESTED|VERIFICATION_|NEEDS_INPUT)\b/i.test(message)) {
    return false;
  }
  return true;
}

function friendlyActivity(
  event: ActivityLike,
  label: string,
  tasks: ActivityTaskLike[],
): string {
  const message = event.message.replace(/\s+/g, " ").trim();
  if (event.role === "compiler") {
    const planned = plannedTaskTitle(message);
    if (planned) {
      return `Planner drafted: ${short(planned, 54)}`;
    }
    if (message.startsWith("Created ")) {
      return message.replace("Created", "Planner created");
    }
  }
  if (event.role === "scheduler" && event.kind === "batch") {
    return `Running ready tasks: ${short(taskListFromMessage(message, tasks), 76)}`;
  }
  if (event.role === "goal" && event.kind === "close") {
    return message.startsWith("Closed ") ? message.replace("Closed", "Goal closed") : message;
  }
  if (event.kind === "transition") {
    if (message.includes("-> Started") || message.includes("-> In Progress")) {
      return `Started work on ${label}`;
    }
    if (message.includes("-> Inbox") || message.includes("-> Blocked")) {
      return `${label} needs input`;
    }
    if (message.includes("-> Done")) {
      return `${label} finished`;
    }
    if (message.includes("-> Review")) {
      return `${label} is ready for review`;
    }
  }
  if (event.role === "worker" && event.kind === "error") {
    const error = blockedExplanation(message);
    return `${label} stopped: ${short(error.summary, 66)}`;
  }
  if (event.role === "steerer" || message.startsWith("Queued message")) {
    return `Input added to ${label}`;
  }
  if (event.role === "supervisor") {
    if (event.kind === "contract-repair-task") {
      return `Supervisor added a proof task for ${label}`;
    }
    if (event.kind === "evidence-repair-task") {
      return `Supervisor added an evidence repair task for ${label}`;
    }
    if (event.kind === "contract-gap") {
      return `Supervisor found missing proof for ${label}`;
    }
    if (event.kind === "evidence-gap") {
      return `Supervisor found missing completion evidence for ${label}`;
    }
    if (event.kind === "conflict") {
      return `Supervisor paused conflicting work on ${label}`;
    }
    return `Supervisor guided ${label}`;
  }
  if (event.role === "codex" || event.role === "main-thread") {
    const command = commandFromMessage(message);
    if (message.startsWith("Started commandExecution")) {
      return `${label} is running: ${short(command, 70)}`;
    }
    if (message.startsWith("Completed commandExecution")) {
      return `${label} finished command: ${short(command, 64)}`;
    }
    if (message.startsWith("Started agentMessage")) {
      return `${label} is writing an update`;
    }
    if (message.startsWith("Completed agentMessage")) {
      return `${label} reported: ${short(messageAfterColon(message), 66)}`;
    }
    if (message.includes("turn completed")) {
      return `${label} finished a Codex turn`;
    }
    if (message.includes("Started Codex turn")) {
      return `${label} started a Codex turn`;
    }
  }
  return `${friendlyRole(event.role)}: ${short(message, 70)}`;
}

function plannedTaskTitle(message: string): string | null {
  try {
    const parsed = JSON.parse(message);
    return typeof parsed.title === "string" ? parsed.title : null;
  } catch {
    return null;
  }
}

function taskListFromMessage(message: string, tasks: ActivityTaskLike[]): string {
  const ids = message.match(/TASK-\d+/g) ?? [];
  const titles = ids.map((id) => tasks.find((task) => task.id === id)?.title ?? id);
  return titles.length ? titles.join(", ") : message;
}

function commandFromMessage(message: string): string {
  const afterColon = messageAfterColon(message);
  return afterColon.replace(/^\/bin\/bash\s+-lc\s+/i, "").replace(/^['"]|['"]$/g, "") ||
    "command";
}

function messageAfterColon(message: string): string {
  const index = message.indexOf(":");
  return index >= 0 ? message.slice(index + 1).trim() : message;
}

function friendlyRole(role: string): string {
  const labels: Record<string, string> = {
    codex: "Agent",
    worker: "Agent",
    compiler: "Planner",
    scheduler: "Scheduler",
    reviewer: "Reviewer",
    steerer: "Input",
    supervisor: "Supervisor",
    core: "Core",
    "main-thread": "Project Memory",
    goal: "Goal",
  };
  return labels[role] ?? role;
}

function timeOnly(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function short(value: string, width: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > width ? `${clean.slice(0, Math.max(0, width - 1))}...` : clean;
}
