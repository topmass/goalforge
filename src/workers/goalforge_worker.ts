import { BoardStore } from "../board/store.ts";
import { ActivityEvent, Task } from "../board/types.ts";
import { CodexAppServerClient, CodexClient } from "./codex_app_server.ts";
import { gitCommitAll, gitDiffStat, gitStatus, prepareTaskWorktree } from "./git_utils.ts";
import { GoalScheduler } from "./goal_scheduler.ts";
import { PROMPTS } from "../board/prompts.ts";

export interface GoalForgeWorkerOptions {
  onEvent?: (event: ActivityEvent) => void;
  createCodexClient?: (
    onEvent: (event: Omit<ActivityEvent, "id" | "createdAt">) => void,
  ) => CodexClient;
}

export class GoalForgeWorker {
  readonly root: string;
  readonly store: BoardStore;
  readonly onEvent?: (event: ActivityEvent) => void;
  readonly createCodexClient: (
    onEvent: (event: Omit<ActivityEvent, "id" | "createdAt">) => void,
  ) => CodexClient;

  constructor(root: string, store: BoardStore, options: GoalForgeWorkerOptions = {}) {
    this.root = root;
    this.store = store;
    this.onEvent = options.onEvent;
    this.createCodexClient = options.createCodexClient ??
      ((onEvent) => new CodexAppServerClient(onEvent));
  }

  async runNext(): Promise<Task> {
    const task = this.store.findDispatchableTask();
    if (!task) {
      throw new Error("No Inbox or Ready task is available.");
    }
    return await this.runTask(task.id);
  }

  async runQueue(limit = Number.POSITIVE_INFINITY, maxConcurrency = 2): Promise<Task[]> {
    const completed: Task[] = [];
    while (completed.length < limit) {
      const tasks = this.store.listDispatchableTasks(20);
      if (!tasks.length) {
        break;
      }
      const scheduler = new GoalScheduler(this.root, {
        createCodexClient: this.createCodexClient,
        onEvent: (event) => {
          this.emit(this.store.appendEvent(null, null, event.role, event.kind, event.message));
        },
      });
      const remaining = limit === Number.POSITIVE_INFINITY
        ? maxConcurrency
        : limit - completed.length;
      const decision = await scheduler.selectBatch(tasks, Math.min(maxConcurrency, remaining));
      this.emit(
        this.store.appendEvent(
          null,
          null,
          "scheduler",
          "batch",
          `Running ${decision.taskIds.join(", ")}. ${decision.notes}`,
        ),
      );
      const results = await Promise.allSettled(
        decision.taskIds.map((taskId) => this.runTask(taskId)),
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          completed.push(result.value);
        }
      }
      if (results.every((result) => result.status === "rejected")) {
        const first = results[0] as PromiseRejectedResult;
        throw first.reason;
      }
    }
    return completed;
  }

  async runTask(taskId: string): Promise<Task> {
    let task = this.store.getTask(taskId);
    if (!["inbox", "ready", "blocked", "review"].includes(task.status)) {
      throw new Error(`Cannot start ${task.id} while it is ${task.status}.`);
    }
    const run = this.store.createRun(task.id, "worker");
    this.emit(
      this.store.appendEvent(task.id, run.id, "worker", "phase", "Preparing isolated worktree."),
    );

    const codex = this.createCodexClient((event) => {
      this.emit(
        this.store.appendEvent(
          task.id,
          run.id,
          event.role,
          event.kind,
          event.message,
        ),
      );
    });

    try {
      const assignment = await prepareTaskWorktree(this.root, task);
      task = this.store.assignWorktree(task.id, assignment.branchName, assignment.worktreePath);
      this.emit(
        this.store.appendEvent(
          task.id,
          run.id,
          "worker",
          "worktree",
          `Assigned ${assignment.branchName} at ${assignment.worktreePath}.`,
        ),
      );

      if (task.status === "inbox") {
        this.emit(
          this.store.requestTransition(task.id, "ready", "scheduler", "Dispatching Codex worker.")
            .event,
        );
      }
      this.emit(
        this.store.requestTransition(task.id, "in_progress", "worker", "Codex worker claimed task.")
          .event,
      );

      const session = await codex.startSession(task.worktreePath ?? assignment.worktreePath);
      this.emit(
        this.store.appendEvent(
          task.id,
          run.id,
          "worker",
          "thread",
          `Started Codex thread ${session.threadId}.`,
        ),
      );

      const turn = await codex.runTurn(session, {
        title: `${task.id}: ${task.title}`,
        prompt: buildWorkerPrompt(this.root, task),
      });

      const preCommitStatus = await safeGitStatus(session.cwd);
      const preCommitDiff = await safeGitDiffStat(session.cwd);
      const commit = await safeGitCommit(
        session.cwd,
        `${task.id}: ${task.title}`,
      );
      const status = await safeGitStatus(session.cwd);
      const diff = await safeGitDiffStat(session.cwd);
      const validation = [
        `Codex App Server turn completed.`,
        `Thread: ${turn.threadId}`,
        `Turn: ${turn.turnId}`,
        `Turn status: ${turn.status}`,
        `Commit: ${commit ?? "not created"}`,
        "",
        "Pre-commit git status:",
        preCommitStatus.trim() || "clean",
        "",
        "Pre-commit diff stat:",
        preCommitDiff.trim() || "no tracked diff",
        "",
        "Git status:",
        status.trim() || "clean",
        "",
        "Diff stat:",
        diff.trim() || "no diff",
      ].join("\n");

      this.store.updateTaskWorkpad(task.id, buildWorkpad(task, session.threadId, turn.turnId));
      this.store.updateTaskValidation(task.id, validation);
      this.emit(
        this.store.requestTransition(
          task.id,
          "review",
          "worker",
          "Codex turn completed and validation evidence was recorded.",
        ).event,
      );
      this.store.finishRun(run.id, "completed");
      return this.store.getTask(task.id);
    } catch (error) {
      this.store.finishRun(run.id, "failed");
      const message = error instanceof Error ? error.message : String(error);
      this.emit(this.store.appendEvent(task.id, run.id, "worker", "error", message));
      try {
        this.emit(this.store.requestTransition(task.id, "blocked", "worker", message).event);
      } catch {
        // Keep the original worker error if the task cannot move to Blocked from its current state.
      }
      throw error;
    } finally {
      await codex.stop().catch(() => {});
    }
  }

  private emit(event: ActivityEvent): void {
    this.onEvent?.(event);
  }
}

function buildWorkerPrompt(root: string, task: Task): string {
  const instructions = [
    ["constitution.md", PROMPTS["constitution.md"]],
    ["project.md", PROMPTS["project.md"]],
    ["engineering.md", PROMPTS["engineering.md"]],
    ["workflow.md", PROMPTS["workflow.md"]],
    ["worker.md", PROMPTS["worker.md"]],
  ].map(([name, content]) => `## ${name}\n${content}`).join("\n\n");

  return `You are a GoalForge Codex worker.

GoalForge instructions:
${instructions}

Task:
- ID: ${task.id}
- Title: ${task.title}
- Description: ${task.description}
- Branch: ${task.branchName ?? "unassigned"}
- Worktree: ${task.worktreePath ?? "current workspace"}

Acceptance criteria:
${task.acceptanceCriteria || "- Complete the task described above."}

Current workpad:
${task.workpad || "No workpad notes yet."}

Rules:
- Work only in this assigned worktree.
- Do not inspect or modify ${root}/.goalforge/board.sqlite or any GoalForge runtime state. The GoalForge daemon records board, workpad, status, and validation updates after your turn completes.
- Make the implementation changes needed for this task.
- Do not create commits yourself. The GoalForge daemon will commit completed work after your turn.
- Keep scope tight. If you discover unrelated or follow-up work, mention it in your final response instead of doing it silently.
- Run the exact validation needed for the files you touch.
- Do not wait for user input. If blocked, explain the blocker clearly in your final response.
- End with a concise handoff containing changed files, validation commands/results, and any remaining risks.
`;
}

function buildWorkpad(task: Task, threadId: string, turnId: string): string {
  return [
    task.workpad,
    "",
    "Codex worker handoff:",
    `- Thread: ${threadId}`,
    `- Turn: ${turnId}`,
    "- Review the assigned worktree for the implementation diff and validation evidence.",
  ].filter(Boolean).join("\n");
}

async function safeGitStatus(cwd: string): Promise<string> {
  try {
    return await gitStatus(cwd);
  } catch (error) {
    return `Unable to read git status: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function safeGitDiffStat(cwd: string): Promise<string> {
  try {
    return await gitDiffStat(cwd);
  } catch (error) {
    return `Unable to read diff stat: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function safeGitCommit(cwd: string, message: string): Promise<string | null> {
  try {
    return await gitCommitAll(cwd, message);
  } catch (error) {
    return `commit failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
