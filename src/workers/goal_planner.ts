import { ActivityEvent, TaskDraft } from "../board/types.ts";
import { CodexAppServerClient, CodexClient } from "./codex_app_server.ts";

export interface GoalPlannerOptions {
  onEvent?: (event: Omit<ActivityEvent, "id" | "createdAt">) => void;
  createCodexClient?: (
    onEvent: (event: Omit<ActivityEvent, "id" | "createdAt">) => void,
  ) => CodexClient;
}

export class GoalPlanner {
  readonly root: string;
  readonly onEvent?: (event: Omit<ActivityEvent, "id" | "createdAt">) => void;
  readonly createCodexClient: (
    onEvent: (event: Omit<ActivityEvent, "id" | "createdAt">) => void,
  ) => CodexClient;

  constructor(root: string, options: GoalPlannerOptions = {}) {
    this.root = root;
    this.onEvent = options.onEvent;
    this.createCodexClient = options.createCodexClient ??
      ((onEvent) => new CodexAppServerClient(onEvent));
  }

  async plan(goalText: string): Promise<TaskDraft[]> {
    let responseText = "";
    const codex = this.createCodexClient((event) => {
      if (event.role === "codex" && event.kind === "agent") {
        responseText += event.message;
      }
      this.onEvent?.({
        taskId: null,
        runId: null,
        role: "planner",
        kind: event.kind,
        message: event.message,
      });
    });

    try {
      const session = await codex.startSession(this.root);
      await codex.runTurn(session, {
        title: "GoalForge planner",
        prompt: buildPlannerPrompt(goalText),
      });
      return parsePlannerResponse(responseText);
    } finally {
      await codex.stop().catch(() => {});
    }
  }
}

export function parsePlannerResponse(responseText: string): TaskDraft[] {
  const jsonText = extractJsonArray(responseText);
  const parsed = JSON.parse(jsonText);
  if (!Array.isArray(parsed)) {
    throw new Error("Planner response must be a JSON array.");
  }

  const drafts = parsed.slice(0, 12).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Planner task ${index + 1} is not an object.`);
    }
    const record = item as Record<string, unknown>;
    return {
      title: stringField(record.title, `Task ${index + 1}`),
      description: stringField(record.description, stringField(record.title, `Task ${index + 1}`)),
      acceptanceCriteria: stringField(
        record.acceptanceCriteria,
        "- Implement the task.\n- Run relevant validation.",
      ),
      priority: numberField(record.priority, 100 - index),
      workpad: stringField(record.workpad, "Created by GoalForge planner."),
    };
  });

  if (!drafts.length) {
    throw new Error("Planner returned no tasks.");
  }
  return drafts;
}

function buildPlannerPrompt(goalText: string): string {
  return `You are the GoalForge planner for a local coding project.

Break the user's goal into a small, ordered kanban task list for Codex workers.

Rules:
- Output only valid JSON. Do not wrap it in markdown.
- Return a JSON array with 1 to 8 task objects.
- Each object must include title, description, acceptanceCriteria, priority, and workpad.
- priority is an integer from 0 to 999. Higher priority runs first.
- acceptanceCriteria must be a single markdown string with concrete checkable bullets.
- Keep tasks scoped so a worker can complete exactly one task in an isolated git worktree.
- Mention dependencies or delegation notes in workpad.
- Do not include tasks for unrelated cleanup.

User goal:
${goalText}
`;
}

function extractJsonArray(responseText: string): string {
  const trimmed = responseText.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return extractJsonArray(fenced[1]);
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  throw new Error("Planner response did not contain a JSON array.");
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
