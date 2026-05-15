import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import {
  configPath,
  databasePath,
  normalizeRoot,
  promptsPath,
  runsPath,
  runtimePath,
  worktreesPath,
} from "../paths.ts";
import { PROMPTS } from "./prompts.ts";
import {
  ActivityEvent,
  BoardSnapshot,
  Goal,
  Run,
  Task,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  TaskDraft,
  TaskStatus,
  TransitionResult,
} from "./types.ts";

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ["ready", "blocked"],
  ready: ["in_progress", "blocked", "inbox"],
  in_progress: ["review", "blocked", "ready"],
  review: ["done", "in_progress", "blocked"],
  blocked: ["ready", "in_progress"],
  done: ["review"],
};

type SqlRow = Record<string, unknown>;

export class BoardStore {
  readonly root: string;
  readonly db: DatabaseSync;

  constructor(root = Deno.cwd()) {
    this.root = normalizeRoot(root);
    ensureRuntimeDirectories(this.root);
    this.db = new DatabaseSync(databasePath(this.root));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.ensureSchema();
  }

  close(): void {
    this.db.close();
  }

  initProject(): void {
    ensureRuntimeDirectories(this.root);
    this.ensureSchema();
    ensureConfig(this.root);
    ensurePrompts(this.root);
    ensureGitignore(this.root);
  }

  createGoal(text: string): { goal: Goal; task: Task } {
    const result = this.createGoalWithTasks(text, [defaultTaskDraft(text)]);
    return { goal: result.goal, task: result.tasks[0] };
  }

  createGoalWithTasks(text: string, drafts: TaskDraft[]): { goal: Goal; tasks: Task[] } {
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Goal text is required.");
    }
    const taskDrafts = drafts.length ? drafts : [defaultTaskDraft(trimmed)];

    const now = timestamp();
    const goalId = this.nextHumanId("GOAL", "goals");

    this.db.prepare(
      "INSERT INTO goals (id, text, created_at) VALUES (?, ?, ?)",
    ).run(goalId, trimmed, now);

    const tasks: Task[] = [];
    for (const draft of taskDrafts) {
      const taskId = this.nextHumanId("TASK", "tasks");
      this.db.prepare(`
        INSERT INTO tasks (
          id, goal_id, title, description, status, priority, branch_name, worktree_path,
          workpad, acceptance_criteria, validation, blocked_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        goalId,
        normalizeTitle(draft.title),
        draft.description.trim() || trimmed,
        "ready",
        normalizePriority(draft.priority),
        null,
        null,
        draft.workpad?.trim() || "Created from GoalForge intake. Awaiting worker handoff.",
        draft.acceptanceCriteria.trim() || defaultAcceptance(trimmed),
        "",
        null,
        now,
        now,
      );
      tasks.push(this.getTask(taskId));
    }

    const goal = this.getGoal(goalId);
    this.appendEvent(
      tasks[0]?.id ?? null,
      null,
      "planner",
      "goal",
      `Created ${tasks.length} task${tasks.length === 1 ? "" : "s"} from ${goalId}.`,
    );
    return { goal, tasks };
  }

  getBoard(): BoardSnapshot {
    return {
      goals: this.listGoals(),
      tasks: this.listTasks(),
      runs: this.listRuns(),
      events: this.listEvents(250),
      statuses: TASK_STATUSES.map((id) => ({ id, label: TASK_STATUS_LABELS[id] })),
    };
  }

  getTask(id: string): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) {
      throw new Error(`Task not found: ${id}`);
    }
    return taskFromRow(row);
  }

  getGoal(id: string): Goal {
    const row = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) {
      throw new Error(`Goal not found: ${id}`);
    }
    return goalFromRow(row);
  }

  findDispatchableTask(): Task | null {
    const row = this.db.prepare(`
      SELECT * FROM tasks
      WHERE status IN ('ready', 'inbox')
      ORDER BY priority DESC, created_at ASC
      LIMIT 1
    `).get() as SqlRow | undefined;
    return row ? taskFromRow(row) : null;
  }

  hasRunningRun(taskId: string): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) AS count FROM runs WHERE task_id = ? AND status = 'running'",
    ).get(taskId) as { count: number };
    return Number(row.count) > 0;
  }

  createRun(taskId: string, role: string): Run {
    if (this.hasRunningRun(taskId)) {
      throw new Error(`${taskId} already has a running agent.`);
    }

    const run: Run = {
      id: makeId("RUN"),
      taskId,
      role,
      status: "running",
      startedAt: timestamp(),
      finishedAt: null,
    };
    this.db.prepare(
      "INSERT INTO runs (id, task_id, role, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(run.id, run.taskId, run.role, run.status, run.startedAt, run.finishedAt);
    this.appendEvent(taskId, run.id, role, "run", `Started ${role} run ${run.id}.`);
    return run;
  }

  finishRun(runId: string, status: "completed" | "failed"): Run {
    const finishedAt = timestamp();
    this.db.prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?").run(
      status,
      finishedAt,
      runId,
    );
    const run = this.getRun(runId);
    this.appendEvent(run.taskId, run.id, run.role, "run", `Run ${run.id} ${status}.`);
    return run;
  }

  getRun(id: string): Run {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as SqlRow | undefined;
    if (!row) {
      throw new Error(`Run not found: ${id}`);
    }
    return runFromRow(row);
  }

  requestTransition(
    taskId: string,
    to: TaskStatus,
    actor = "daemon",
    reason = "",
  ): TransitionResult {
    if (!TASK_STATUSES.includes(to)) {
      throw new Error(`Unknown task status: ${to}`);
    }

    const task = this.getTask(taskId);
    if (task.status === to) {
      const event = this.appendEvent(
        taskId,
        null,
        actor,
        "transition",
        `${taskId} already ${TASK_STATUS_LABELS[to]}.`,
      );
      return { task, event };
    }

    if (!TRANSITIONS[task.status].includes(to)) {
      throw new Error(
        `Invalid transition for ${taskId}: ${TASK_STATUS_LABELS[task.status]} -> ${
          TASK_STATUS_LABELS[to]
        }`,
      );
    }

    if (to === "review" && !task.validation.trim()) {
      throw new Error(`Validation evidence is required before ${taskId} can move to Review.`);
    }

    const blockedReason = to === "blocked" ? reason || "Blocked without details." : null;
    const now = timestamp();
    this.db.prepare(
      "UPDATE tasks SET status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?",
    ).run(to, blockedReason, now, taskId);

    const updated = this.getTask(taskId);
    const event = this.appendEvent(
      taskId,
      null,
      actor,
      "transition",
      `${taskId}: ${TASK_STATUS_LABELS[task.status]} -> ${TASK_STATUS_LABELS[to]}${
        reason ? ` | ${reason}` : ""
      }`,
    );
    return { task: updated, event };
  }

  updateTaskWorkpad(taskId: string, workpad: string): Task {
    this.db.prepare("UPDATE tasks SET workpad = ?, updated_at = ? WHERE id = ?").run(
      workpad,
      timestamp(),
      taskId,
    );
    return this.getTask(taskId);
  }

  updateTaskValidation(taskId: string, validation: string): Task {
    this.db.prepare("UPDATE tasks SET validation = ?, updated_at = ? WHERE id = ?").run(
      validation,
      timestamp(),
      taskId,
    );
    return this.getTask(taskId);
  }

  assignWorktree(taskId: string, branchName: string, worktreePathValue: string): Task {
    this.db.prepare(
      "UPDATE tasks SET branch_name = ?, worktree_path = ?, updated_at = ? WHERE id = ?",
    ).run(branchName, worktreePathValue, timestamp(), taskId);
    return this.getTask(taskId);
  }

  appendEvent(
    taskId: string | null,
    runId: string | null,
    role: string,
    kind: string,
    message: string,
  ): ActivityEvent {
    const now = timestamp();
    const result = this.db.prepare(
      "INSERT INTO events (task_id, run_id, role, kind, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(taskId, runId, role, kind, message, now);
    return {
      id: Number(result.lastInsertRowid),
      taskId,
      runId,
      role,
      kind,
      message,
      createdAt: now,
    };
  }

  enqueueMessage(taskId: string, role: string, message: string): void {
    this.db.prepare(
      "INSERT INTO messages (task_id, role, message, processed, created_at) VALUES (?, ?, ?, 0, ?)",
    ).run(taskId, role, message, timestamp());
    this.appendEvent(taskId, null, role, "queue", `Queued message for ${taskId}: ${message}`);
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        branch_name TEXT,
        worktree_path TEXT,
        workpad TEXT NOT NULL DEFAULT '',
        acceptance_criteria TEXT NOT NULL DEFAULT '',
        validation TEXT NOT NULL DEFAULT '',
        blocked_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        role TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        path TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(path)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        message TEXT NOT NULL,
        processed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);
  }

  private listGoals(): Goal[] {
    return (this.db.prepare("SELECT * FROM goals ORDER BY created_at ASC").all() as SqlRow[]).map(
      goalFromRow,
    );
  }

  private listTasks(): Task[] {
    return (this.db.prepare(
      "SELECT * FROM tasks ORDER BY priority DESC, created_at ASC",
    ).all() as SqlRow[]).map(taskFromRow);
  }

  private listRuns(): Run[] {
    return (this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC").all() as SqlRow[]).map(
      runFromRow,
    );
  }

  private listEvents(limit: number): ActivityEvent[] {
    return (this.db.prepare(
      "SELECT * FROM events ORDER BY id DESC LIMIT ?",
    ).all(limit) as SqlRow[]).map(eventFromRow).reverse();
  }

  private nextHumanId(prefix: string, table: "goals" | "tasks"): string {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return `${prefix}-${Number(row.count) + 1}`;
  }
}

export function ensureRuntimeDirectories(root: string): void {
  Deno.mkdirSync(runtimePath(root), { recursive: true });
  Deno.mkdirSync(worktreesPath(root), { recursive: true });
  Deno.mkdirSync(runsPath(root), { recursive: true });
  Deno.mkdirSync(promptsPath(root), { recursive: true });
}

function ensureConfig(root: string): void {
  const target = configPath(root);
  try {
    Deno.statSync(target);
  } catch {
    Deno.writeTextFileSync(
      target,
      JSON.stringify(
        {
          name: "GoalForge",
          port: 4733,
          workerMode: "codex",
          maxConcurrentAgents: 2,
          codexTransport: "stdio",
          boardStates: TASK_STATUSES,
        },
        null,
        2,
      ) + "\n",
    );
  }
}

function ensurePrompts(root: string): void {
  for (const [name, content] of Object.entries(PROMPTS)) {
    const target = path.join(promptsPath(root), name);
    try {
      Deno.statSync(target);
    } catch {
      Deno.writeTextFileSync(target, content);
    }
  }
}

function ensureGitignore(root: string): void {
  const target = path.join(root, ".gitignore");
  let current = "";
  try {
    current = Deno.readTextFileSync(target);
  } catch {
    current = "";
  }

  const required = ["/.goalforge/"];
  const additions = required.filter((entry) => !current.split(/\r?\n/).includes(entry));
  if (additions.length) {
    const prefix = current && !current.endsWith("\n") ? "\n" : "";
    Deno.writeTextFileSync(target, `${current}${prefix}${additions.join("\n")}\n`);
  }
}

function defaultTaskDraft(text: string): TaskDraft {
  return {
    title: normalizeTitle(text),
    description: text.trim(),
    priority: 100,
    acceptanceCriteria: defaultAcceptance(text),
    workpad: "Created from /goal intake. Awaiting worker plan.",
  };
}

function defaultAcceptance(text: string): string {
  return [
    `- Clarify and implement: ${text.trim()}`,
    "- Record workpad notes before implementation handoff.",
    "- Produce validation evidence before requesting Review.",
  ].join("\n");
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim() || "Untitled task";
  return trimmed.length > 84 ? `${trimmed.slice(0, 81)}...` : trimmed;
}

function normalizePriority(priority: number): number {
  if (!Number.isFinite(priority)) {
    return 100;
  }
  return Math.max(0, Math.min(999, Math.round(priority)));
}

function goalFromRow(row: SqlRow): Goal {
  return {
    id: String(row.id),
    text: String(row.text),
    createdAt: String(row.created_at),
  };
}

function taskFromRow(row: SqlRow): Task {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    title: String(row.title),
    description: String(row.description),
    status: String(row.status) as TaskStatus,
    priority: Number(row.priority),
    branchName: nullableString(row.branch_name),
    worktreePath: nullableString(row.worktree_path),
    workpad: String(row.workpad ?? ""),
    acceptanceCriteria: String(row.acceptance_criteria ?? ""),
    validation: String(row.validation ?? ""),
    blockedReason: nullableString(row.blocked_reason),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function runFromRow(row: SqlRow): Run {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    role: String(row.role),
    status: String(row.status) as Run["status"],
    startedAt: String(row.started_at),
    finishedAt: nullableString(row.finished_at),
  };
}

function eventFromRow(row: SqlRow): ActivityEvent {
  return {
    id: Number(row.id),
    taskId: nullableString(row.task_id),
    runId: nullableString(row.run_id),
    role: String(row.role),
    kind: String(row.kind),
    message: String(row.message),
    createdAt: String(row.created_at),
  };
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function timestamp(): string {
  return new Date().toISOString();
}

function makeId(prefix: string): string {
  const random = crypto.randomUUID().slice(0, 8).toUpperCase();
  return `${prefix}-${random}`;
}
