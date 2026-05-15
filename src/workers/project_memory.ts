import { BoardStore } from "../board/store.ts";
import { ActivityEvent, BoardSnapshot, Task } from "../board/types.ts";

export function buildProjectMemory(store: BoardStore): string {
  return buildMemoryFromBoard(store.getBoard());
}

export function buildMemoryFromBoard(board: BoardSnapshot): string {
  const tasks = board.tasks.slice(0, 30);
  const activeTasks = tasks.length
    ? tasks.map(formatTaskLine).join("\n")
    : "No queued, active, review, waiting, or done tasks are currently on the board.";
  const validation = tasks
    .filter((task) => task.validation.trim())
    .slice(0, 8)
    .map((task) => `- ${task.id} ${task.title}: ${oneLine(task.validation, 360)}`)
    .join("\n") || "No validation evidence has been recorded yet.";
  const recentEvents = board.events.slice(-35).map(formatEventLine).join("\n") ||
    "No recent GoalForge events.";

  return limitText(
    [
      "GoalForge project memory is a compact view of the durable local board, not a user request.",
      "",
      "Current board:",
      activeTasks,
      "",
      "Recorded validation and handoffs:",
      validation,
      "",
      "Recent activity:",
      recentEvents,
    ].join("\n"),
    8000,
  );
}

function formatTaskLine(task: Task): string {
  const blocked = task.blockedReason ? ` blocked=${oneLine(task.blockedReason, 120)}` : "";
  const branch = task.branchName ? ` branch=${task.branchName}` : "";
  return `- ${task.id} [${task.status}] P${task.priority} ${task.title}${branch}${blocked}`;
}

function formatEventLine(event: ActivityEvent): string {
  const task = event.taskId ? ` ${event.taskId}` : "";
  const run = event.runId ? ` ${event.runId}` : "";
  return `- ${event.createdAt} ${event.role}/${event.kind}${task}${run}: ${
    oneLine(event.message, 220)
  }`;
}

function oneLine(value: string, maxCharacters: number): string {
  return limitText(value.replace(/\s+/g, " ").trim(), maxCharacters);
}

function limitText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }
  return value.slice(0, maxCharacters - 60).trimEnd() +
    " [GoalForge compacted this memory text.]";
}
