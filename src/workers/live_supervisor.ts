import { BoardStore } from "../board/store.ts";
import { ActivityEvent, ActivityEventInput, AgentPhase, Task } from "../board/types.ts";
import { CodexClient, CodexSession } from "./codex_app_server.ts";
import { buildFailureSteerMessage, normalizeCodexEvent } from "./codex_event_normalizer.ts";

export interface LiveSupervisorOptions {
  store: BoardStore;
  task: Task;
  runId: string;
  codex: CodexClient;
  getSession: () => CodexSession | null;
  onEvent?: (event: ActivityEvent) => void;
}

export class LiveSupervisor {
  private steeredFailure = false;
  private steeredConflict = false;
  private readonly store: BoardStore;
  private readonly task: Task;
  private readonly runId: string;
  private readonly codex: CodexClient;
  private readonly getSession: () => CodexSession | null;
  private readonly onEvent?: (event: ActivityEvent) => void;

  constructor(options: LiveSupervisorOptions) {
    this.store = options.store;
    this.task = options.task;
    this.runId = options.runId;
    this.codex = options.codex;
    this.getSession = options.getSession;
    this.onEvent = options.onEvent;
  }

  observe(event: ActivityEventInput): void {
    const session = this.getSession();
    const normalized = normalizeCodexEvent(event);
    this.store.upsertAgentStatus({
      taskId: this.task.id,
      runId: this.runId,
      threadId: session?.threadId ?? this.task.threadId,
      turnId: normalized.turnId,
      phase: normalized.phase,
      headline: normalized.headline,
      detail: normalized.detail,
      risk: normalized.risk,
      needsInputPrompt: normalized.needsInputPrompt,
      interruptible: normalized.interruptible && Boolean(session),
    });
    this.recordLivePaths(normalized.paths);
    if (normalized.shouldSteer) {
      this.steerOnce(normalized.detail);
    }
  }

  markThread(session: CodexSession): void {
    this.store.upsertAgentStatus({
      taskId: this.task.id,
      runId: this.runId,
      threadId: session.threadId,
      phase: "starting",
      headline: "Codex task thread is ready.",
      detail: `Thread ${session.threadId} is assigned to this task.`,
      risk: "none",
      interruptible: false,
    });
  }

  markPhase(phase: AgentPhase, headline: string): void {
    const session = this.getSession();
    this.store.upsertAgentStatus({
      taskId: this.task.id,
      runId: this.runId,
      threadId: session?.threadId ?? this.task.threadId,
      phase,
      headline,
      detail: headline,
      risk: phase === "blocked" ? "needs_user" : "none",
      interruptible: false,
    });
  }

  private steerOnce(signal: string): void {
    const session = this.getSession();
    if (this.steeredFailure || !session || !this.codex.steerTurn) {
      return;
    }
    this.steeredFailure = true;
    const message = buildFailureSteerMessage(signal);
    this.store.recordSupervisorDecision(
      this.task.id,
      "Steered active task because live command output looked like a real failure.",
    );
    this.store.upsertAgentStatus({
      taskId: this.task.id,
      runId: this.runId,
      threadId: session.threadId,
      phase: "testing",
      headline: "Supervisor sent failure guidance.",
      detail: "LoopForge detected failing output and steered the active turn.",
      risk: "test_failed",
      lastSupervisorAction: message,
      interruptible: true,
    });
    this.codex.steerTurn(session, message).then(() => {
      this.emit(this.store.appendEvent(this.task.id, this.runId, "supervisor", "steer", message));
    }).catch((error) => {
      this.emit(
        this.store.appendEvent(
          this.task.id,
          this.runId,
          "supervisor",
          "steer-error",
          error instanceof Error ? error.message : String(error),
        ),
      );
    });
  }

  private recordLivePaths(paths: string[]): void {
    if (!paths.length) {
      return;
    }
    const latest = this.store.getTask(this.task.id);
    this.store.updateTaskTouchedPaths(this.task.id, [...latest.touchedPaths, ...paths]);
    const activeTasks = this.store.getBoard().tasks.filter((candidate) =>
      candidate.id !== this.task.id && candidate.status !== "done"
    );
    for (const candidate of activeTasks) {
      const overlaps = paths.filter((file) => candidate.touchedPaths.includes(file));
      if (!overlaps.length) {
        continue;
      }
      const signal = `${candidate.id} also touches ${overlaps.join(", ")}.`;
      this.store.addConflictSignal(this.task.id, signal);
      this.store.addConflictSignal(
        candidate.id,
        `${this.task.id} also touches ${overlaps.join(", ")}.`,
      );
      this.store.recordSupervisorDecision(
        this.task.id,
        `Detected live file conflict with ${candidate.id}: ${overlaps.join(", ")}.`,
      );
      this.store.upsertAgentStatus({
        taskId: this.task.id,
        runId: this.runId,
        phase: "editing",
        headline: "Possible file conflict detected.",
        detail: signal,
        risk: "conflict",
        interruptible: Boolean(this.getSession()),
      });
      if (candidate.status === "ready" || candidate.status === "inbox") {
        this.store.recordSupervisorDecision(
          candidate.id,
          `Paused dispatch because ${this.task.id} is actively touching ${overlaps.join(", ")}.`,
        );
        this.emit(
          this.store.requestTransition(
            candidate.id,
            "blocked",
            "supervisor",
            `${this.task.id} is actively touching ${
              overlaps.join(", ")
            }. Review conflict before starting.`,
          ).event,
        );
      }
      this.steerConflictOnce(signal);
    }
  }

  private steerConflictOnce(signal: string): void {
    const session = this.getSession();
    if (this.steeredConflict || !session || !this.codex.steerTurn) {
      return;
    }
    this.steeredConflict = true;
    const message = buildConflictSteerMessage(signal);
    this.store.upsertAgentStatus({
      taskId: this.task.id,
      runId: this.runId,
      threadId: session.threadId,
      phase: "editing",
      headline: "Supervisor sent conflict guidance.",
      detail: signal,
      risk: "conflict",
      lastSupervisorAction: message,
      interruptible: true,
    });
    this.codex.steerTurn(session, message).then(() => {
      this.emit(this.store.appendEvent(this.task.id, this.runId, "supervisor", "steer", message));
    }).catch((error) => {
      this.emit(
        this.store.appendEvent(
          this.task.id,
          this.runId,
          "supervisor",
          "steer-error",
          error instanceof Error ? error.message : String(error),
        ),
      );
    });
  }

  private emit(event: ActivityEvent): void {
    this.onEvent?.(event);
  }
}

function buildConflictSteerMessage(signal: string): string {
  return [
    "LoopForge live supervisor:",
    "Possible file conflict with another LoopForge task.",
    "Pause broad edits. Inspect the overlapping file ownership, keep your changes scoped, and avoid rewriting work that belongs to the other task.",
    `Signal: ${signal.replace(/\s+/g, " ").trim().slice(0, 500)}`,
  ].join("\n");
}
