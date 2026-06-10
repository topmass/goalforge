import { BoardStore } from "../board/store.ts";
import { ActivityEvent, BoardSnapshot, Task } from "../board/types.ts";
import { summarizeClosedGoals, summarizeGoalProgress } from "../board/goal_progress.ts";

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
  const loopState = tasks
    .filter((task) => task.status !== "done")
    .slice(0, 12)
    .map((task) =>
      `- ${task.id} ${task.loopPhase}/${task.currentGate}: ${oneLine(task.nextAction, 180)}`
    )
    .join("\n") || "No active task loops.";
  const supervisorState = tasks
    .filter((task) => task.supervisorDecision.trim())
    .slice(0, 8)
    .map((task) => `- ${task.id}: ${oneLine(task.supervisorDecision, 220)}`)
    .join("\n") || "No supervisor decisions recorded.";
  const recentEvents = board.events.slice(-35).map(formatEventLine).join("\n") ||
    "No recent GoalForge events.";
  const goalProgress = summarizeGoalProgress(board);
  const closedGoals = summarizeClosedGoals(board, 5);

  return limitText(
    [
      "GoalForge project memory is a compact view of the durable local board, not a user request.",
      "",
      "Project main thread:",
      board.projectState.mainThreadId
        ? `- ${board.projectState.mainThreadId}: ${
          oneLine(board.projectState.mainThreadSummary, 360)
        }`
        : "- none assigned",
      "",
      "Current goal:",
      goalProgress
        ? `- ${goalProgress.goal.id} ${goalProgress.status} ${goalProgress.done}/${goalProgress.total} done (${goalProgress.percentDone}%): ${
          oneLine(goalProgress.goal.text, 260)
        }`
        : "- none planned",
      goalProgress?.goal.completionContract
        ? `- Contract: ${oneLine(goalProgress.goal.completionContract, 420)}`
        : "",
      goalProgress ? `- Next: ${oneLine(goalProgress.nextAction, 220)}` : "",
      goalProgress
        ? `- Evidence: ${goalProgress.missingValidation} missing validation, ${goalProgress.missingApprovedReview} missing approved review, ${goalProgress.missingHandoff} missing handoff`
        : "",
      goalProgress
        ? `- Completion verdict: ${goalProgress.completionVerdict} - ${
          oneLine(goalProgress.completionReason, 220)
        }`
        : "",
      ...(goalProgress?.evidenceGaps.length
        ? goalProgress.evidenceGaps.slice(0, 4).map((gap) => `- Gap: ${oneLine(gap, 220)}`)
        : []),
      "",
      "Recently closed goals:",
      ...(closedGoals.length
        ? closedGoals.map((goal) =>
          `- ${goal.id} closed ${goal.closedAt ?? "unknown time"}: ${oneLine(goal.text, 160)} | ${
            oneLine(goal.closureSummary || "No closure summary recorded.", 220)
          }`
        )
        : ["- none"]),
      "",
      "Current board:",
      activeTasks,
      "",
      "Current loop state:",
      loopState,
      "",
      "Supervisor decisions:",
      supervisorState,
      "",
      "Active task cards:",
      taskCards(tasks),
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
  const thread = task.threadId ? ` thread=${task.threadId}` : "";
  const deps = task.dependencyIds.length ? ` deps=${task.dependencyIds.join(",")}` : "";
  return `- ${task.id} [${task.status}/${task.loopPhase}] P${task.priority} ${task.title}${branch}${thread}${deps}${blocked}`;
}

function taskCards(tasks: Task[]): string {
  const cards = tasks.filter((task) => task.taskCard.trim()).slice(0, 10);
  if (!cards.length) {
    return "No compact task cards recorded yet.";
  }
  return cards.map((task) => `## ${task.id}\n${limitText(task.taskCard, 900)}`).join("\n");
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
