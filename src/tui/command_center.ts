import { BoardStore, readConfig } from "../board/store.ts";
import { summarizeClosedGoals, summarizeGoalProgress } from "../board/goal_progress.ts";
import { ActivityEvent, BoardSnapshot, Task } from "../board/types.ts";
import { parseValidationEvidence } from "../board/validation_evidence.ts";
import { normalizeRoot } from "../paths.ts";
import { ensureGitRepository, gitMergeBranch } from "../workers/git_utils.ts";
import { GoalPlanner } from "../workers/goal_planner.ts";
import { GoalReviewer } from "../workers/goal_reviewer.ts";
import { GoalForgeWorker } from "../workers/goalforge_worker.ts";
import { buildProjectMemory } from "../workers/project_memory.ts";
import { buildTaskCard, ensureProjectKnowledgeFiles } from "../workers/task_memory.ts";
import { readWorkflow } from "../workflow/workflow.ts";
import { activityLine, displayEvents } from "./activity.ts";
import { decodePromptInput, normalizePromptText } from "./input.ts";
import { parseResetMemoryConfirmation } from "./memory_controls.ts";
import { taskRecommendation } from "./task_recommendation.ts";

type PromptMode = "build-goal" | "goal" | "steer" | "reset-main" | null;

export interface TuiState {
  selectedTaskId: string | null;
  promptMode: PromptMode;
  input: string;
  notice: string;
  busy: boolean;
  frame: number;
  showHelp: boolean;
}

export interface TuiRenderOptions {
  width: number;
  height: number;
  color?: boolean;
}

const STATUS_BADGE: Record<string, string> = {
  inbox: "IN",
  ready: "RD",
  in_progress: "WK",
  review: "RV",
  blocked: "BL",
  done: "DN",
};

const SPINNER = ["◐", "◓", "◑", "◒"];

export async function runCommandCenterTui(root = Deno.cwd(), args: string[] = []): Promise<void> {
  const normalizedRoot = normalizeRoot(root);
  const snapshot = args.includes("--snapshot");
  const noColor = args.includes("--no-color") || Deno.env.get("NO_COLOR") === "1";
  const store = new BoardStore(normalizedRoot);
  store.initProject();
  ensureProjectKnowledgeFiles(normalizedRoot);
  await ensureGitRepository(normalizedRoot);
  if (!snapshot && !store.getProjectState().mainThreadId) {
    const worker = new GoalForgeWorker(normalizedRoot, store);
    await worker.ensureMainThread();
  }

  const app = new CommandCenterApp(normalizedRoot, store, { color: !noColor });
  try {
    if (snapshot) {
      const size = terminalSize();
      app.refresh();
      console.log(app.render(size.width, size.height));
      return;
    }
    await app.run();
  } finally {
    store.close();
  }
}

class CommandCenterApp {
  private state: TuiState = {
    selectedTaskId: null,
    promptMode: null,
    input: "",
    notice: "Ready.",
    busy: false,
    frame: 0,
    showHelp: false,
  };
  private board: BoardSnapshot;
  private eventsSeen = 0;
  private runningAction: Promise<void> | null = null;

  constructor(
    private readonly root: string,
    private readonly store: BoardStore,
    private readonly options: { color: boolean },
  ) {
    this.board = this.store.getBoard();
    this.ensureSelection();
  }

  refresh(): void {
    this.board = this.store.getBoard();
    this.eventsSeen = this.board.events.length;
    this.ensureSelection();
  }

  render(width: number, height: number): string {
    return renderCommandCenterFrame(this.board, this.state, {
      width,
      height,
      color: this.options.color,
    });
  }

  async run(): Promise<void> {
    const rawWasSet = setRawMode(true);
    let alive = true;
    const reader = Deno.stdin.readable.getReader();
    const tick = setInterval(() => {
      this.state.frame++;
      this.pullBoard();
      this.paint();
    }, 250);

    try {
      enterScreen();
      this.paint();
      while (alive) {
        const read = await reader.read();
        if (read.done) {
          break;
        }
        const key = decodeKey(read.value);
        alive = this.handleKey(key);
        this.pullBoard();
        this.paint();
      }
    } finally {
      clearInterval(tick);
      reader.releaseLock();
      if (rawWasSet) {
        setRawMode(false);
      }
      leaveScreen();
    }
  }

  private pullBoard(): void {
    try {
      this.board = this.store.getBoard();
      if (this.board.events.length !== this.eventsSeen) {
        this.eventsSeen = this.board.events.length;
      }
      this.ensureSelection();
    } catch (error) {
      this.state.notice = error instanceof Error ? error.message : String(error);
    }
  }

  private paint(): void {
    const size = terminalSize();
    write(`\x1b[H${this.render(size.width, size.height)}`);
  }

  private handleKey(key: string): boolean {
    if (key === "ctrl-c" || (!this.state.promptMode && key === "q")) {
      return false;
    }
    if (this.state.promptMode) {
      this.handlePromptKey(key);
      return true;
    }
    if (key === "?") {
      this.state.showHelp = !this.state.showHelp;
      return true;
    }
    if (key === "up" || key === "k") {
      this.moveSelection(-1);
      return true;
    }
    if (key === "down" || key === "j" || key === "tab") {
      this.moveSelection(1);
      return true;
    }
    if (key === "g") {
      this.openPrompt("goal", "Describe the project goal to compile.");
      return true;
    }
    if (key === "b") {
      this.openPrompt("build-goal", "Describe the project goal to build now.");
      return true;
    }
    if (key === "s") {
      if (!this.selectedTask()) {
        this.state.notice = "Select a task before steering.";
        return true;
      }
      this.openPrompt("steer", `Steer ${this.selectedTask()?.id}.`);
      return true;
    }
    if (key === "R") {
      this.openPrompt("reset-main", "Type RESET to clear memory, or RESET custom-id.");
      return true;
    }
    if (key === "M") {
      this.startAction("Compact main memory", () => this.compactMainThread());
      return true;
    }
    if (key === "r") {
      this.startAction("Run queue", () => this.runQueue());
      return true;
    }
    if (key === "n") {
      this.startAction("Run next", () => this.runNext());
      return true;
    }
    if (key === "enter") {
      this.startAction("Run selected task", () => this.runSelected());
      return true;
    }
    if (key === "v") {
      this.startAction("Review & merge selected task", () => this.reviewSelected());
      return true;
    }
    if (key === "m") {
      this.startAction("Merge selected task", () => this.mergeSelected());
      return true;
    }
    if (key === "c") {
      this.compactSelected();
      return true;
    }
    if (key === "D") {
      this.clearDoneTasks();
      return true;
    }
    if (key === "C") {
      this.closeActiveGoal();
      return true;
    }
    if (key === "x" || key === "delete") {
      this.deleteSelected();
      return true;
    }
    return true;
  }

  private handlePromptKey(key: string): void {
    const input = isPromptKeyName(key) ? { kind: "key" as const, key } : decodePromptInput(key);
    if (input?.kind === "text") {
      this.appendPromptText(input.text);
      return;
    }
    if (input?.kind === "key") {
      key = input.key === "escape" ? "esc" : input.key;
    }
    if (key === "esc") {
      this.closePrompt("Canceled.");
      return;
    }
    if (key === "backspace") {
      this.state.input = this.state.input.slice(0, -1);
      return;
    }
    if (key === "enter") {
      const mode = this.state.promptMode;
      const value = this.state.input.trim();
      this.state.promptMode = null;
      this.state.input = "";
      if (mode === "build-goal") {
        if (!value) {
          this.state.notice = "Goal text is required.";
          return;
        }
        this.startAction("Build goal", () => this.buildGoal(value));
        return;
      }
      if (mode === "goal") {
        if (!value) {
          this.state.notice = "Goal text is required.";
          return;
        }
        this.startAction("Compile goal", () => this.createGoal(value));
        return;
      }
      if (mode === "steer") {
        const task = this.selectedTask();
        if (!task || !value) {
          this.state.notice = "Steer message is required.";
          return;
        }
        this.startAction("Steer task", () => this.steerTask(task.id, value));
        return;
      }
      if (mode === "reset-main") {
        const reset = parseResetMemoryConfirmation(value);
        if (!reset.confirmed) {
          this.state.notice = "Type RESET to reset project memory, or RESET custom-id.";
          return;
        }
        this.resetMainThread(reset.threadId ?? "");
      }
      return;
    }
    if (key.length === 1 && key >= " ") {
      this.appendPromptText(key);
    }
  }

  private appendPromptText(text: string): void {
    this.state.input = normalizePromptText(`${this.state.input}${text}`).slice(0, 8000);
  }

  private openPrompt(mode: PromptMode, notice: string): void {
    this.state.promptMode = mode;
    this.state.input = "";
    this.state.notice = notice;
  }

  private closePrompt(notice: string): void {
    this.state.promptMode = null;
    this.state.input = "";
    this.state.notice = notice;
  }

  private startAction(label: string, action: () => Promise<void>): void {
    if (this.runningAction) {
      this.state.notice = "An action is already running.";
      return;
    }
    this.state.busy = true;
    this.state.notice = `${label} started.`;
    this.runningAction = action()
      .then(() => {
        this.state.notice = `${label} complete.`;
      })
      .catch((error) => {
        this.state.notice = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.state.busy = false;
        this.runningAction = null;
        this.pullBoard();
      });
  }

  private async createGoal(text: string): Promise<void> {
    const planner = new GoalPlanner(this.root, {
      projectMemory: buildProjectMemory(this.store),
      onEvent: (event) => {
        if (event.message.trim()) {
          this.emitAgentEvent(event.taskId, event.role, event.kind, event.message, event.raw);
        }
      },
    });
    const plan = await planner.planGoal(text);
    const result = this.store.createGoalWithTasks(text, plan.tasks, {
      completionContract: plan.completionContract,
    });
    this.state.selectedTaskId = result.tasks[0]?.id ?? this.state.selectedTaskId;
  }

  private async buildGoal(text: string): Promise<void> {
    const planner = new GoalPlanner(this.root, {
      projectMemory: buildProjectMemory(this.store),
      onEvent: (event) => {
        if (event.message.trim()) {
          this.emitAgentEvent(event.taskId, event.role, event.kind, event.message, event.raw);
        }
      },
    });
    const plan = await planner.planGoal(text);
    const result = this.store.createGoalWithTasks(text, plan.tasks, {
      completionContract: plan.completionContract,
    });
    this.state.selectedTaskId = result.tasks[0]?.id ?? this.state.selectedTaskId;
    const worker = this.worker();
    await worker.runQueue();
    const progress = summarizeGoalProgress(this.store.getBoard(), result.goal.id);
    if (this.store.getGoal(result.goal.id).status === "closed") {
      this.state.notice = `${result.goal.id} built and closed.`;
    } else if (progress?.completionReady) {
      this.store.closeGoal(
        progress.goal.id,
        `${progress.done}/${progress.total} tasks done. ${progress.completionReason}`,
      );
      this.state.notice = `${progress.goal.id} built and closed.`;
    }
  }

  private async runQueue(): Promise<void> {
    const worker = this.worker();
    await worker.runQueue();
  }

  private async runNext(): Promise<void> {
    const worker = this.worker();
    const task = await worker.runNext();
    this.state.selectedTaskId = task.id;
  }

  private async runSelected(): Promise<void> {
    const task = this.selectedTask();
    if (!task) {
      throw new Error("Select a task first.");
    }
    const worker = this.worker();
    const updated = await worker.runTask(task.id);
    this.state.selectedTaskId = updated.id;
  }

  private async reviewSelected(): Promise<void> {
    const task = this.selectedTask();
    if (!task) {
      throw new Error("Select a task first.");
    }
    if (task.status !== "review") {
      throw new Error(`${task.id} must be in Review before review.`);
    }
    const reviewer = new GoalReviewer(this.root, {
      onEvent: (event) => {
        if (event.message.trim()) {
          this.emitAgentEvent(task.id, event.role, event.kind, event.message, event.raw);
        }
      },
    });
    const result = await reviewer.review(task);
    const latest = this.store.getTask(task.id);
    const reviewText = [
      latest.validation,
      "",
      `GoalForge review: ${result.verdict.toUpperCase()}`,
      result.notes,
    ].filter(Boolean).join("\n");
    this.store.updateTaskValidation(task.id, reviewText);
    this.store.appendEvent(
      task.id,
      null,
      "reviewer",
      "review",
      result.verdict === "approved"
        ? "Review approved. Merging branch."
        : "Review requested changes. Waiting for user direction.",
    );
    if (result.verdict !== "approved") {
      this.store.requestTransition(
        task.id,
        "blocked",
        "reviewer",
        "Review requested changes. Add a message to continue this task.",
      );
      return;
    }
    if (!task.branchName) {
      this.store.requestTransition(
        task.id,
        "blocked",
        "merger",
        "GoalForge cannot merge because this task has no assigned branch.",
      );
      return;
    }
    const output = await gitMergeBranch(this.root, task.branchName);
    this.store.appendEvent(
      task.id,
      null,
      "merger",
      "merge",
      output.trim() || `Merged ${task.branchName}.`,
    );
    this.store.requestTransition(
      task.id,
      "done",
      "merger",
      `Review approved and merged ${task.branchName}.`,
    );
  }

  private async mergeSelected(): Promise<void> {
    const task = this.selectedTask();
    if (!task) {
      throw new Error("Select a task first.");
    }
    if (!task.branchName) {
      throw new Error(`${task.id} does not have an assigned branch.`);
    }
    if (task.status !== "review" && task.status !== "done") {
      throw new Error(`${task.id} must be in Review or Done before merge.`);
    }
    const output = await gitMergeBranch(this.root, task.branchName);
    this.store.appendEvent(
      task.id,
      null,
      "merger",
      "merge",
      output.trim() || `Merged ${task.branchName}.`,
    );
    if (task.status === "review") {
      this.store.requestTransition(task.id, "done", "merger", `Merged ${task.branchName}.`);
    }
  }

  private async steerTask(taskId: string, message: string): Promise<void> {
    const worker = this.worker();
    const task = this.store.getTask(taskId);
    await worker.steerTask(taskId, message);
    if (task.status === "blocked") {
      await worker.runTask(taskId);
    }
  }

  private async compactMainThread(): Promise<void> {
    const worker = this.worker();
    await worker.compactMainThread();
  }

  private compactSelected(): void {
    const task = this.selectedTask();
    if (!task) {
      this.state.notice = "Select a task first.";
      return;
    }
    this.store.updateTaskCard(task.id, buildTaskCard(task));
    this.state.notice = `${task.id} compact card refreshed.`;
    this.pullBoard();
  }

  private deleteSelected(): void {
    const task = this.selectedTask();
    if (!task) {
      this.state.notice = "Select a task first.";
      return;
    }
    this.store.deleteTask(task.id);
    this.state.notice = `${task.id} deleted.`;
    this.state.selectedTaskId = null;
    this.pullBoard();
  }

  private clearDoneTasks(): void {
    const result = this.store.clearDoneTasks();
    this.state.notice = result.count
      ? `Cleared ${result.count} completed task${result.count === 1 ? "" : "s"}.`
      : "No completed tasks to clear.";
    this.pullBoard();
  }

  private closeActiveGoal(): void {
    const goal = summarizeGoalProgress(this.board);
    if (!goal?.completionReady) {
      this.state.notice = goal
        ? `${goal.goal.id} is not ready to close: ${goal.completionReason}`
        : "No open goal is ready to close.";
      return;
    }
    const result = this.store.closeGoal(
      goal.goal.id,
      `${goal.done}/${goal.total} tasks done. ${goal.completionReason}`,
    );
    this.state.notice = `${result.goal.id} closed.`;
    this.pullBoard();
  }

  private resetMainThread(threadId: string): void {
    const state = this.store.resetMainThread(
      threadId || `manual-main-${crypto.randomUUID()}`,
      "Project main thread reset from the GoalForge command center.",
    );
    this.state.notice = `Main thread reset to ${state.mainThreadId}.`;
    this.pullBoard();
  }

  private worker(): GoalForgeWorker {
    return new GoalForgeWorker(this.root, this.store, {
      onEvent: () => {
        this.pullBoard();
      },
    });
  }

  private emitAgentEvent(
    taskId: string | null,
    role: string,
    kind: string,
    message: string,
    raw?: unknown,
  ): void {
    this.store.appendAgentEvent({ taskId, runId: null, role, kind, message, raw });
    this.pullBoard();
  }

  private selectedTask(): Task | null {
    return this.board.tasks.find((task) => task.id === this.state.selectedTaskId) ?? null;
  }

  private ensureSelection(): void {
    if (
      this.state.selectedTaskId &&
      this.board.tasks.some((task) => task.id === this.state.selectedTaskId)
    ) {
      return;
    }
    this.state.selectedTaskId = this.board.tasks[0]?.id ?? null;
  }

  private moveSelection(delta: number): void {
    if (!this.board.tasks.length) {
      return;
    }
    const currentIndex = Math.max(
      0,
      this.board.tasks.findIndex((task) => task.id === this.state.selectedTaskId),
    );
    const next = (currentIndex + delta + this.board.tasks.length) % this.board.tasks.length;
    this.state.selectedTaskId = this.board.tasks[next].id;
  }
}

function isPromptKeyName(key: string): boolean {
  return key === "esc" || key === "escape" || key === "backspace" || key === "enter" ||
    key === "return";
}

export function renderCommandCenterFrame(
  board: BoardSnapshot,
  state: TuiState,
  options: TuiRenderOptions,
): string {
  const width = Math.max(72, options.width);
  const height = Math.max(24, options.height);
  const theme = makeTheme(options.color !== false);
  const config = readConfig(Deno.cwd());
  const workflow = readWorkflow(Deno.cwd());
  const selected = board.tasks.find((task) => task.id === state.selectedTaskId) ?? null;
  const activeRuns = board.runs.filter((run) => run.status === "running");
  const blocked = board.tasks.filter((task) => task.status === "blocked");
  const dispatchable = board.tasks.filter((task) =>
    task.status === "ready" || task.status === "inbox"
  );
  const spinner = state.busy || activeRuns.length ? SPINNER[state.frame % SPINNER.length] : " ";

  const header = [
    theme.header(
      pad(
        ` ${spinner} GoalForge Command Center  ${board.tasks.length} tasks  ${activeRuns.length} live  ${blocked.length} inbox`,
        width,
      ),
    ),
    theme.dim(
      pad(
        ` model ${config.model}  effort ${config.reasoningEffort}  max agents ${workflow.maxConcurrentAgents}  main ${
          board.projectState.mainThreadId ?? "not started"
        }`,
        width,
      ),
    ),
  ];

  const footer = renderFooter(state, width, theme);
  const contentHeight = height - header.length - footer.length;
  const leftWidth = width >= 120 ? 38 : 34;
  const rightWidth = width >= 118 ? 42 : 0;
  const centerWidth = width - leftWidth - rightWidth;
  const tasksPanel = renderTaskRail(
    board.tasks,
    selected?.id ?? null,
    leftWidth,
    contentHeight,
    state.frame,
    theme,
  );
  const centerPanel = renderSelectedTask(
    selected,
    board.events,
    board.messages,
    dispatchable.length,
    centerWidth,
    contentHeight,
    theme,
  );
  const rightPanel = rightWidth ? renderRightRail(board, rightWidth, contentHeight, theme) : [];

  const rows: string[] = [];
  for (let index = 0; index < contentHeight; index++) {
    rows.push(
      `${tasksPanel[index] ?? "".padEnd(leftWidth)}${centerPanel[index] ?? "".padEnd(centerWidth)}${
        rightPanel[index] ?? ""
      }`,
    );
  }

  return [...header, ...rows, ...footer].slice(0, height).join("\n");
}

function renderTaskRail(
  tasks: Task[],
  selectedTaskId: string | null,
  width: number,
  height: number,
  frame: number,
  theme: Theme,
): string[] {
  const rows = tasks.length
    ? tasks.map((task) => {
      const marker = task.id === selectedTaskId ? ">" : " ";
      const status = STATUS_BADGE[task.status] ?? task.status.slice(0, 2).toUpperCase();
      const pulse = task.status === "in_progress" ? SPINNER[frame % SPINNER.length] : " ";
      const conflicts = task.conflictSignals.length ? "!" : " ";
      const label = `${marker}${pulse} ${status} ${
        loopLabel(task.loopPhase)
      } ${task.id} P${task.priority} ${conflicts} ${task.title}`;
      return colorByStatus(fit(label, width - 4), task.status, theme);
    })
    : [theme.dim("No tasks. Press g to compile a goal.")];
  return box("Agents / Tasks", rows, width, height, theme);
}

function renderSelectedTask(
  task: Task | null,
  events: ActivityEvent[],
  messages: BoardSnapshot["messages"],
  dispatchableCount: number,
  width: number,
  height: number,
  theme: Theme,
): string[] {
  if (!task) {
    return box(
      "Selected Task",
      [
        theme.dim("No task selected."),
        "",
        "Press g to compile a goal.",
        "Press r to run the queue when tasks exist.",
      ],
      width,
      height,
      theme,
    );
  }
  const recommendation = taskRecommendation(
    task,
    messages.filter((message) => message.taskId === task.id),
  );
  const lines = [
    theme.accent(`${task.id} - ${task.title}`),
    `${STATUS_BADGE[task.status] ?? task.status} ${task.status}  ${
      loopLabel(task.loopPhase)
    }  gate ${gateLabel(task.currentGate)}`,
    `priority ${task.priority}  risk ${task.riskLevel}  attempt ${task.loopAttempt}  queue ${dispatchableCount}`,
    theme.label(recommendation.heading),
    ...wrap(`${recommendation.summary} ${recommendation.action}`, width - 4).slice(0, 3),
    `branch ${task.branchName ?? "none"}`,
    `worktree ${task.worktreePath ?? "none"}`,
    `dependencies ${task.dependencyIds.length ? task.dependencyIds.join(", ") : "none"}`,
    ...(task.supervisorDecision
      ? [
        "",
        theme.label("Supervisor"),
        ...wrap(task.supervisorDecision, width - 4).slice(0, 2),
      ]
      : []),
    "",
    ...(task.touchedPaths.length
      ? [
        theme.label("Changed Files"),
        ...task.touchedPaths.slice(0, 4).map((item) => `- ${fit(item, width - 6)}`),
        "",
      ]
      : []),
    ...(task.validation.trim()
      ? [
        theme.label("Validation Evidence"),
        ...validationEvidenceLines(task),
        "",
        theme.label("Validation Log"),
        ...wrap(validationPreview(task.validation), width - 4).slice(0, 3),
        "",
      ]
      : []),
    theme.label("Threads"),
    `parent ${task.parentThreadId ?? "none"}`,
    `child  ${task.threadId ?? "none"}`,
    `turn   ${task.activeTurnId ?? "none"}`,
    `ctx    ${task.contextManifestPath ?? "none"}`,
    "",
    theme.label("Recent Activity"),
    ...selectedTaskActivityLines(task, events, width - 4, theme),
    "",
    theme.label("Task Card"),
    ...wrap(task.taskCard || task.description || "No task card yet.", width - 4).slice(0, 8),
    "",
    theme.label("Acceptance"),
    ...wrap(task.acceptanceCriteria || "No acceptance criteria recorded.", width - 4).slice(0, 5),
    "",
    theme.label("Verification"),
    ...wrap(task.verificationPlan || "No verification plan recorded.", width - 4).slice(0, 4),
  ];
  if (task.verificationSummary) {
    lines.push("", theme.label("Evidence"));
    lines.push(...wrap(task.verificationSummary, width - 4).slice(0, 4));
  }
  if (task.needsInputPrompt) {
    lines.push("", theme.warn("Needs Input"));
    lines.push(...wrap(task.needsInputPrompt, width - 4).slice(0, 4));
  }
  if (task.conflictSignals.length) {
    lines.push("", theme.warn("Conflict Signals"));
    lines.push(...task.conflictSignals.slice(-4).map((item) => `! ${item}`));
  }
  if (task.handoffSummary) {
    lines.push("", theme.label("Handoff"));
    lines.push(...wrap(task.handoffSummary, width - 4).slice(0, 5));
  }
  return box("Selected Task", lines, width, height, theme);
}

function validationPreview(value: string): string {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join(" | ");
}

function validationEvidenceLines(task: Task): string[] {
  const evidence = parseValidationEvidence(task.validation);
  return [
    `gates ${
      evidence.verificationGatesRecorded ? evidence.verificationGates.length : "missing"
    } | verify ${evidence.verificationVerdict ?? "missing"} | proof ${
      evidence.verificationHasProofDetails ? "recorded" : "missing"
    }`,
    `review ${evidence.reviewVerdict ?? "missing"} | test ${
      evidence.testStatus ?? "missing"
    } | git ${evidence.finalGitStatus ?? "missing"}`,
  ];
}

function selectedTaskActivityLines(
  task: Task,
  events: ActivityEvent[],
  width: number,
  theme: Theme,
): string[] {
  const lines = displayEvents(events).filter((event) => event.taskId === task.id).slice(-5).map(
    (event) => fit(activityLine(event, [task]), width),
  );
  return lines.length ? lines : [theme.dim("No activity recorded for this task yet.")];
}

function renderRightRail(
  board: BoardSnapshot,
  width: number,
  height: number,
  theme: Theme,
): string[] {
  const mainHeight = Math.max(8, Math.floor(height * 0.34));
  const eventHeight = height - mainHeight;
  const goal = summarizeGoalProgress(board);
  const closedGoals = summarizeClosedGoals(board, 2);
  const mainLines = [
    `thread ${board.projectState.mainThreadId ?? "none"}`,
    `created ${board.projectState.mainThreadCreatedAt ?? "none"}`,
    `reset ${board.projectState.mainThreadResetAt ?? "none"}`,
    "",
    theme.label("Current Goal"),
    ...(goal
      ? [
        `${goal.goal.id} ${goal.status} ${goal.done}/${goal.total} done (${goal.percentDone}%)`,
        ...wrap(goal.goal.text, width - 4).slice(0, 2),
        `verdict ${goal.completionVerdict}`,
        `evidence gaps ${goal.evidenceGaps.length}`,
        ...wrap(`contract ${goal.goal.completionContract}`, width - 4).slice(0, 1),
        ...goal.evidenceGaps.slice(0, 2).flatMap((gap) => wrap(`- ${gap}`, width - 4).slice(0, 2)),
        `next ${shortMessage(goal.nextAction, width - 9)}`,
      ]
      : [theme.dim("No goal planned yet.")]),
    "",
    theme.label("Closed Goals"),
    ...(closedGoals.length
      ? closedGoals.flatMap((item) => [
        `${item.id} ${item.closedAt ?? ""}`,
        ...wrap(item.text, width - 4).slice(0, 1),
      ]).slice(0, 4)
      : [theme.dim("No closed goals yet.")]),
    "",
    ...wrap(board.projectState.mainThreadSummary || "No project summary yet.", width - 4).slice(
      0,
      Math.max(0, mainHeight - 16),
    ),
  ];
  const eventLines = displayEvents(board.events)
    .slice(-Math.max(1, eventHeight - 3))
    .map((event) => activityLine(event, board.tasks));
  return [
    ...box("Main Thread", mainLines, width, mainHeight, theme),
    ...box(
      "Live Stream",
      eventLines.length ? eventLines : [theme.dim("No live agent events yet.")],
      width,
      eventHeight,
      theme,
    ),
  ];
}

function renderFooter(state: TuiState, width: number, theme: Theme): string[] {
  const prompt = state.promptMode
    ? `${promptLabel(state.promptMode)} ${state.input}${state.frame % 2 ? " " : "_"}`
    : state.notice;
  const keys = state.showHelp
    ? "q quit  b build  g plan  r queue  n next  enter run  s reply  v review  C close  M mem  R reset  D done  del rm  ?"
    : "b build  g plan  r queue  enter run  delete remove  C close goal  M memory compact  R reset  D clear done  ? help  q quit";
  return [
    theme.status(pad(` ${prompt}`, width)),
    theme.dim(pad(` ${keys}`, width)),
  ];
}

function box(
  title: string,
  lines: string[],
  width: number,
  height: number,
  theme: Theme,
): string[] {
  const inner = Math.max(1, width - 2);
  const visibleTitle = ` ${title} `;
  const top = `${theme.border("╭")}${
    theme.border("─".repeat(Math.max(0, inner - visibleLength(visibleTitle))))
  }${theme.label(visibleTitle)}${theme.border("╮")}`;
  const bottom = `${theme.border("╰")}${theme.border("─".repeat(inner))}${theme.border("╯")}`;
  const bodyHeight = Math.max(0, height - 2);
  const rows = lines.slice(0, bodyHeight);
  while (rows.length < bodyHeight) {
    rows.push("");
  }
  return [
    fitAnsi(top, width),
    ...rows.map((line) => `${theme.border("│")}${fitAnsi(line, inner)}${theme.border("│")}`),
    fitAnsi(bottom, width),
  ].slice(0, height);
}

function colorByStatus(text: string, status: string, theme: Theme): string {
  if (status === "done") return theme.ok(text);
  if (status === "blocked") return theme.warn(text);
  if (status === "in_progress") return theme.accent(text);
  if (status === "review") return theme.review(text);
  return text;
}

function loopLabel(phase: string): string {
  const labels: Record<string, string> = {
    queued: "Queued",
    planning: "Planning",
    working: "Working",
    testing: "Testing",
    repairing: "Repairing",
    reviewing: "Reviewing",
    remembering: "Remembering",
    blocked: "Needs Input",
    done: "Done",
  };
  return labels[phase] ?? phase;
}

function gateLabel(gate: string): string {
  const labels: Record<string, string> = {
    waiting: "Waiting",
    context: "Context",
    worktree: "Worktree",
    "context-manifest": "Task Packet",
    implementation: "Implementation",
    repair: "Repair",
    verification: "Verification",
    "test-engineer": "Verification",
    commit: "Commit",
    "automatic-review": "Review",
    review: "Review",
    merge: "Merge",
    "project-memory": "Memory",
    complete: "Complete",
    "needs-input": "Needs Input",
    stopped: "Stopped",
  };
  return labels[gate] ?? gate;
}

function wrap(value: string, width: number): string[] {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  const words = clean.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) {
      current = word;
      continue;
    }
    if (visibleLength(`${current} ${word}`) > width) {
      lines.push(current);
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines.flatMap((line) => {
    if (visibleLength(line) <= width) return [line];
    const chunks: string[] = [];
    for (let index = 0; index < line.length; index += width) {
      chunks.push(line.slice(index, index + width));
    }
    return chunks;
  });
}

function fit(value: string, width: number): string {
  if (visibleLength(value) <= width) {
    return value.padEnd(width);
  }
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function fitAnsi(value: string, width: number): string {
  const visible = visibleLength(value);
  if (visible === width) return value;
  if (visible < width) return `${value}${" ".repeat(width - visible)}`;
  return fit(stripAnsi(value), width);
}

function pad(value: string, width: number): string {
  return fit(value, width);
}

function visibleLength(value: string): number {
  return stripAnsi(value).length;
}

function stripAnsi(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === "[") {
      index += 2;
      while (index < value.length && value[index] !== "m") {
        index++;
      }
      continue;
    }
    output += value[index];
  }
  return output;
}

function shortMessage(value: string, width = 80): string {
  return fit(value.replace(/\s+/g, " ").trim(), Math.max(12, width));
}

function promptLabel(mode: PromptMode): string {
  if (mode === "build-goal") return "build>";
  if (mode === "goal") return "goal>";
  if (mode === "steer") return "steer>";
  if (mode === "reset-main") return "reset>";
  return ">";
}

interface Theme {
  accent: (value: string) => string;
  border: (value: string) => string;
  dim: (value: string) => string;
  header: (value: string) => string;
  label: (value: string) => string;
  ok: (value: string) => string;
  review: (value: string) => string;
  status: (value: string) => string;
  warn: (value: string) => string;
}

function makeTheme(color: boolean): Theme {
  const paint = (code: string) => (value: string) => color ? `\x1b[${code}m${value}\x1b[0m` : value;
  return {
    accent: paint("36;1"),
    border: paint("38;5;239"),
    dim: paint("38;5;245"),
    header: paint("30;48;5;117;1"),
    label: paint("38;5;117;1"),
    ok: paint("38;5;114"),
    review: paint("38;5;182"),
    status: paint("30;48;5;151"),
    warn: paint("38;5;221"),
  };
}

function terminalSize(): { width: number; height: number } {
  const fallback = {
    width: Number(Deno.env.get("COLUMNS")) || 120,
    height: Number(Deno.env.get("LINES")) || 36,
  };
  try {
    const size = Deno.consoleSize();
    return {
      width: Math.max(72, size.columns || fallback.width),
      height: Math.max(24, size.rows || fallback.height),
    };
  } catch {
    return fallback;
  }
}

function setRawMode(enabled: boolean): boolean {
  try {
    if (!Deno.stdin.isTerminal()) {
      return false;
    }
    Deno.stdin.setRaw(enabled, { cbreak: true });
    return true;
  } catch {
    return false;
  }
}

function enterScreen(): void {
  write("\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H");
}

function leaveScreen(): void {
  write("\x1b[?25h\x1b[?1049l");
}

function write(value: string): void {
  Deno.stdout.writeSync(new TextEncoder().encode(value));
}

function decodeKey(bytes: Uint8Array): string {
  const value = new TextDecoder().decode(bytes);
  if (value === "\x03") return "ctrl-c";
  if (value === "\x1b") return "esc";
  if (value === "\x1b[A") return "up";
  if (value === "\x1b[B") return "down";
  if (value === "\x1b[C") return "right";
  if (value === "\x1b[D") return "left";
  if (value === "\x1b[3~") return "delete";
  if (value === "\t") return "tab";
  if (value === "\r" || value === "\n") return "enter";
  if (value === "\x7f" || value === "\b") return "backspace";
  return value;
}
