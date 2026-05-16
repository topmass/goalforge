import { BoardStore, readConfig } from "../board/store.ts";
import { ActivityEvent, ActivityEventInput, QueuedMessage, Task } from "../board/types.ts";
import { CodexAppServerClient, CodexClient } from "./codex_app_server.ts";
import { shouldRecordActivity } from "./activity_filter.ts";
import {
  gitCommitAll,
  gitDiffStat,
  gitMergeBranch,
  gitStatus,
  prepareTaskWorktree,
} from "./git_utils.ts";
import { GoalReviewer } from "./goal_reviewer.ts";
import { GoalScheduler } from "./goal_scheduler.ts";
import { GoalTestEngineer } from "./goal_test_engineer.ts";
import { collectAgentsInstructions } from "./project_context.ts";
import { buildProjectMemory } from "./project_memory.ts";
import { runWorkflowHooks } from "./workflow_hooks.ts";
import { PROMPTS } from "../board/prompts.ts";
import { readWorkflow, WorkflowRuntime } from "../workflow/workflow.ts";

export interface GoalForgeWorkerOptions {
  onEvent?: (event: ActivityEvent) => void;
  createCodexClient?: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
}

export class GoalForgeWorker {
  readonly root: string;
  readonly store: BoardStore;
  readonly onEvent?: (event: ActivityEvent) => void;
  readonly createCodexClient: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
  private mergeChain: Promise<void> = Promise.resolve();

  constructor(root: string, store: BoardStore, options: GoalForgeWorkerOptions = {}) {
    this.root = root;
    this.store = store;
    this.onEvent = options.onEvent;
    this.createCodexClient = options.createCodexClient ??
      ((onEvent) => new CodexAppServerClient(onEvent, readConfig(this.root)));
  }

  async runNext(): Promise<Task> {
    const task = this.store.findDispatchableTask();
    if (!task) {
      throw new Error("No Inbox or Ready task is available.");
    }
    return await this.runTask(task.id);
  }

  async runQueue(limit = Number.POSITIVE_INFINITY, maxConcurrency?: number): Promise<Task[]> {
    const completed: Task[] = [];
    while (completed.length < limit) {
      const workflow = readWorkflow(this.root);
      const tasks = this.store.listDispatchableTasks(20);
      if (!tasks.length) {
        break;
      }
      const scheduler = new GoalScheduler(this.root, {
        projectMemory: buildProjectMemory(this.store),
        createCodexClient: this.createCodexClient,
        onEvent: (event) => {
          if (shouldRecordActivity(event)) {
            this.emit(this.store.appendAgentEvent(event));
          }
        },
      });
      const remaining = limit === Number.POSITIVE_INFINITY
        ? maxConcurrency ?? workflow.maxConcurrentAgents
        : limit - completed.length;
      const decision = await scheduler.selectBatch(
        tasks,
        Math.min(maxConcurrency ?? workflow.maxConcurrentAgents, remaining),
      );
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
    const workflow = readWorkflow(this.root);
    const maxAttempts = Math.max(workflow.maxRetries, workflow.maxTurns, 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.runTaskAttempt(taskId);
      } catch (error) {
        if (attempt >= maxAttempts) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.emit(
          this.store.appendEvent(
            taskId,
            null,
            "orchestrator",
            "retry",
            `Retrying ${taskId} after failure ${attempt}/${maxAttempts}: ${message}`,
          ),
        );
        try {
          const task = this.store.getTask(taskId);
          if (task.status === "blocked") {
            this.emit(
              this.store.requestTransition(
                taskId,
                "ready",
                "orchestrator",
                `Retry ${attempt + 1}/${maxAttempts} after transient failure.`,
              ).event,
            );
          }
        } catch {
          // Preserve the original failure if the task disappeared during retry handling.
        }
        await delay(workflow.retryBackoffMs);
      }
    }
    throw new Error(`Unable to run ${taskId}.`);
  }

  private async runTaskAttempt(taskId: string): Promise<Task> {
    let task = this.store.getTask(taskId);
    if (!["inbox", "ready", "blocked", "review"].includes(task.status)) {
      throw new Error(`Cannot start ${task.id} while it is ${task.status}.`);
    }
    const run = this.store.createRun(task.id, "worker");
    this.emit(
      this.store.appendEvent(task.id, run.id, "worker", "phase", "Preparing isolated worktree."),
    );

    const codex = this.createCodexClient((event) => {
      if (shouldRecordActivity(event)) {
        this.emit(
          this.store.appendEvent(
            task.id,
            run.id,
            event.role,
            event.kind,
            event.message,
            event.raw,
          ),
        );
      }
    });

    try {
      const workflow = readWorkflow(this.root);
      const assignment = await prepareTaskWorktree(this.root, task, workflow.worktreesDir);
      const projectInstructions = await collectAgentsInstructions(this.root);
      const projectMemory = buildProjectMemory(this.store);
      const queuedMessages = this.store.listPendingMessages(task.id);
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
      if (assignment.created) {
        await this.runHooks(workflow, "after_create", assignment.worktreePath, task.id, run.id);
      }
      await this.runHooks(workflow, "before_run", assignment.worktreePath, task.id, run.id);

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

      const wasContinuation = Boolean(task.threadId);
      const session = task.threadId
        ? await codex.resumeSession(task.worktreePath ?? assignment.worktreePath, task.threadId)
        : await codex.startSession(task.worktreePath ?? assignment.worktreePath);
      task = this.store.assignThread(task.id, session.threadId);
      this.emit(
        this.store.appendEvent(
          task.id,
          run.id,
          "worker",
          "thread",
          `${wasContinuation ? "Resumed" : "Started"} Codex thread ${session.threadId}.`,
        ),
      );

      const turn = await codex.runTurn(session, {
        title: `${task.id}: ${task.title}`,
        prompt: buildWorkerPrompt(
          this.root,
          task,
          projectInstructions,
          workflow.instructions,
          projectMemory,
          queuedMessages,
        ),
      });
      this.store.markMessagesProcessed(queuedMessages.map((message) => message.id));
      const testEngineer = new GoalTestEngineer(
        projectInstructions,
        projectMemory,
        workflow.instructions,
        {
          onEvent: (event) => {
            this.emit(
              this.store.appendEvent(
                task.id,
                run.id,
                event.role,
                event.kind,
                event.message,
                event.raw,
              ),
            );
          },
        },
      );
      const testTurn = await testEngineer.run(codex, session, task);
      await this.runHooks(workflow, "after_run", session.cwd, task.id, run.id);

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
        `Test turn: ${testTurn.turnId}`,
        `Test turn status: ${testTurn.status}`,
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
      if (isCommitFailure(commit)) {
        this.emit(
          this.store.requestTransition(
            task.id,
            "blocked",
            "worker",
            "GoalForge could not create a commit. Check validation for git status and nested repository details.",
          ).event,
        );
        this.store.finishRun(run.id, "failed");
        return this.store.getTask(task.id);
      }
      const reviewTransition = this.store.requestTransition(
        task.id,
        "review",
        "worker",
        "Codex turn completed and validation evidence was recorded.",
      );
      this.emit(
        reviewTransition.event,
      );
      const result = await this.reviewAndMerge(reviewTransition.task, run.id);
      this.store.finishRun(run.id, "completed");
      return result;
    } catch (error) {
      this.store.finishRun(run.id, "failed");
      const message = error instanceof Error ? error.message : String(error);
      this.emit(this.store.appendEvent(task.id, run.id, "worker", "error", message));
      try {
        this.emit(
          this.store.requestTransition(
            task.id,
            "blocked",
            "worker",
            `GoalForge needs input: ${message}`,
          ).event,
        );
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

  private async reviewAndMerge(task: Task, runId: string): Promise<Task> {
    this.emit(
      this.store.appendEvent(
        task.id,
        runId,
        "reviewer",
        "phase",
        "Automatic review started.",
      ),
    );
    const reviewer = new GoalReviewer(this.root, {
      createCodexClient: this.createCodexClient,
      onEvent: (event) => {
        if (shouldRecordActivity(event)) {
          this.emit(
            this.store.appendEvent(
              task.id,
              runId,
              event.role,
              event.kind,
              event.message,
              event.raw,
            ),
          );
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
    this.emit(
      this.store.appendEvent(
        task.id,
        runId,
        "reviewer",
        "review",
        result.verdict === "approved"
          ? "Review approved. Merging branch."
          : "Review requested changes. Waiting for user direction.",
      ),
    );

    if (result.verdict !== "approved") {
      this.emit(
        this.store.requestTransition(
          task.id,
          "blocked",
          "reviewer",
          "Automatic review requested changes. Add a message to continue this task.",
        ).event,
      );
      return this.store.getTask(task.id);
    }

    if (!task.branchName) {
      this.emit(
        this.store.requestTransition(
          task.id,
          "blocked",
          "merger",
          "GoalForge cannot merge because this task has no assigned branch.",
        ).event,
      );
      return this.store.getTask(task.id);
    }

    const output = await this.mergeBranch(task.branchName);
    this.emit(
      this.store.appendEvent(
        task.id,
        runId,
        "merger",
        "merge",
        output.trim() || `Merged ${task.branchName}.`,
      ),
    );
    this.emit(
      this.store.requestTransition(
        task.id,
        "done",
        "merger",
        `Review approved and merged ${task.branchName}.`,
      ).event,
    );
    return this.store.getTask(task.id);
  }

  private async mergeBranch(branchName: string): Promise<string> {
    const previous = this.mergeChain;
    let release = () => {};
    this.mergeChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await gitMergeBranch(this.root, branchName);
    } finally {
      release();
    }
  }

  private async runHooks(
    workflow: WorkflowRuntime,
    stage: "after_create" | "before_run" | "after_run" | "before_remove",
    cwd: string,
    taskId: string,
    runId: string,
  ): Promise<void> {
    for (const message of await runWorkflowHooks(workflow, stage, cwd)) {
      this.emit(this.store.appendEvent(taskId, runId, "workflow", stage, message));
    }
  }
}

function buildWorkerPrompt(
  root: string,
  task: Task,
  projectInstructions: string,
  workflowInstructions: string,
  projectMemory: string,
  queuedMessages: QueuedMessage[],
): string {
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

Project AGENTS.md context from the original folder:
${projectInstructions}

Repo WORKFLOW.md instructions:
${workflowInstructions}

Current GoalForge board memory:
${projectMemory}

Queued messages for this task:
${formatQueuedMessages(queuedMessages)}

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
- Run as close as possible to normal Codex in this folder: respect the project AGENTS.md context above, local repo conventions, and the user's installed Codex environment and skills.
- Use Codex-native subagents or delegation when they materially help with independent investigation, implementation, testing, or review without overlapping work.
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

function formatQueuedMessages(messages: QueuedMessage[]): string {
  if (!messages.length) {
    return "No queued messages for this task.";
  }
  return messages.map((message) => `- ${message.createdAt} ${message.role}: ${message.message}`)
    .join("\n");
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

function isCommitFailure(commit: string | null): boolean {
  return commit?.startsWith("commit failed:") ?? false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
