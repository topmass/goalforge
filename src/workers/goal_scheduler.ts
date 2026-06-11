import { ActivityEventInput, Task } from "../board/types.ts";
import { CodexClient } from "./codex_app_server.ts";
import { createAgentClient } from "./agent_backend.ts";
import { shouldRecordActivity } from "./activity_filter.ts";
import { readWorkflow } from "../workflow/workflow.ts";

export interface ScheduleDecision {
  taskIds: string[];
  notes: string;
}

export interface GoalSchedulerOptions {
  onEvent?: (event: ActivityEventInput) => void;
  projectMemory?: string;
  createCodexClient?: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
}

export class GoalScheduler {
  readonly createCodexClient: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;

  constructor(private readonly root: string, private readonly options: GoalSchedulerOptions = {}) {
    this.createCodexClient = options.createCodexClient ??
      ((onEvent) => createAgentClient(this.root, onEvent));
  }

  async selectBatch(tasks: Task[], maxConcurrency: number): Promise<ScheduleDecision> {
    const candidates = tasks.slice(0, Math.max(1, maxConcurrency));
    if (tasks.length <= 1 || maxConcurrency <= 1) {
      return {
        taskIds: candidates.map((task) => task.id),
        notes: "Only one dispatchable task or concurrency is limited to one.",
      };
    }

    let responseText = "";
    const codex = this.createCodexClient((event) => {
      if (event.role === "codex" && event.kind === "agent") {
        responseText += event.message;
      }
      const activity = {
        taskId: null,
        runId: null,
        role: "scheduler",
        kind: event.kind,
        message: event.message,
        raw: event.raw,
      };
      if (shouldRecordActivity(activity)) {
        this.options.onEvent?.(activity);
      }
    });

    try {
      const session = await codex.startSession(this.root);
      const workflow = readWorkflow(this.root);
      await codex.runTurn(session, {
        title: "LoopForge scheduler",
        prompt: buildSchedulerPrompt(
          tasks,
          maxConcurrency,
          this.options.projectMemory,
          workflow.instructions,
        ),
      });
      const decision = parseSchedulerResponse(responseText, tasks, maxConcurrency);
      if (!decision.taskIds.length) {
        return { taskIds: [tasks[0].id], notes: "Scheduler returned no runnable tasks." };
      }
      return decision;
    } finally {
      await codex.stop().catch(() => {});
    }
  }
}

export function parseSchedulerResponse(
  responseText: string,
  tasks: Task[],
  maxConcurrency: number,
): ScheduleDecision {
  const allowed = new Set(tasks.map((task) => task.id));
  const parsed = JSON.parse(extractJsonObject(responseText)) as Record<string, unknown>;
  const rawIds = Array.isArray(parsed.taskIds) ? parsed.taskIds : [];
  const taskIds = rawIds
    .filter((value): value is string => typeof value === "string" && allowed.has(value))
    .slice(0, Math.max(1, maxConcurrency));
  return {
    taskIds,
    notes: typeof parsed.notes === "string" ? parsed.notes : "No scheduler notes.",
  };
}

function buildSchedulerPrompt(
  tasks: Task[],
  maxConcurrency: number,
  projectMemory = "No project memory was supplied.",
  workflowInstructions = "No WORKFLOW.md instructions were supplied.",
): string {
  const taskList = tasks.map((task) => ({
    id: task.id,
    title: task.title,
    description: task.description,
    priority: task.priority,
    status: task.status,
    loopPhase: task.loopPhase,
    dependencies: task.dependencyIds,
    touchedPaths: task.touchedPaths,
    conflictSignals: task.conflictSignals,
    riskLevel: task.riskLevel,
    acceptanceCriteria: task.acceptanceCriteria,
    verificationPlan: task.verificationPlan,
    workpad: task.workpad,
  }));

  return `You are the LoopForge scheduler for a local coding project.

Choose which ready tasks can safely run in parallel right now.

Rules:
- Output only valid JSON. Do not wrap it in markdown.
- Return an object with taskIds and notes.
- taskIds must contain 1 to ${maxConcurrency} IDs from the provided tasks.
- Pick independent tasks only. Avoid parallelizing tasks that likely edit the same files, depend on each other, or need the result of another task.
- Prefer higher priority when independence is uncertain.
- Notes should explain why the chosen tasks can run together or why only one should run.

Repo WORKFLOW.md instructions:
${workflowInstructions}

Current LoopForge board memory:
${projectMemory}

Dispatchable tasks:
${JSON.stringify(taskList, null, 2)}
`;
}

function extractJsonObject(responseText: string): string {
  const trimmed = responseText.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return extractJsonObject(fenced[1]);
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  throw new Error("Scheduler response did not contain a JSON object.");
}
