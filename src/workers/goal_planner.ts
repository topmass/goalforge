import { ActivityEventInput, TaskDraft } from "../board/types.ts";
import { CodexAppServerClient, CodexClient } from "./codex_app_server.ts";
import { shouldRecordActivity } from "./activity_filter.ts";
import { readConfig } from "../board/store.ts";
import { readWorkflow } from "../workflow/workflow.ts";

export interface GoalPlannerOptions {
  onEvent?: (event: ActivityEventInput) => void;
  projectMemory?: string;
  createCodexClient?: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
}

export class GoalPlanner {
  readonly root: string;
  readonly onEvent?: (event: ActivityEventInput) => void;
  readonly projectMemory?: string;
  readonly createCodexClient: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;

  constructor(root: string, options: GoalPlannerOptions = {}) {
    this.root = root;
    this.onEvent = options.onEvent;
    this.projectMemory = options.projectMemory;
    this.createCodexClient = options.createCodexClient ??
      ((onEvent) => new CodexAppServerClient(onEvent, readConfig(this.root)));
  }

  async plan(goalText: string): Promise<TaskDraft[]> {
    let responseText = "";
    const codex = this.createCodexClient((event) => {
      if (event.role === "codex" && event.kind === "agent") {
        responseText += event.message;
      }
      const activity = {
        taskId: null,
        runId: null,
        role: "compiler",
        kind: event.kind,
        message: event.message,
        raw: event.raw,
      };
      if (shouldRecordActivity(activity)) {
        this.onEvent?.(activity);
      }
    });

    try {
      const session = await codex.startSession(this.root);
      const workflow = readWorkflow(this.root);
      await codex.runTurn(session, {
        title: "GoalForge goal compiler",
        prompt: buildPlannerPrompt(goalText, this.projectMemory, workflow.instructions),
      });
      return parsePlannerResponse(responseText);
    } finally {
      await codex.stop().catch(() => {});
    }
  }
}

export function parsePlannerResponse(responseText: string): TaskDraft[] {
  const jsonText = extractJson(responseText);
  const parsed = JSON.parse(jsonText);
  const items = Array.isArray(parsed) ? parsed : [parsed];

  const drafts = items.slice(0, 1).map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Planner task ${index + 1} is not an object.`);
    }
    const record = item as Record<string, unknown>;
    const prompt = limitText(
      stringField(
        record.prompt,
        stringField(record.description, stringField(record.title, `Task ${index + 1}`)),
      ),
      4000,
    );
    return {
      title: stringField(record.title, `Task ${index + 1}`),
      description: prompt,
      acceptanceCriteria: stringField(
        record.acceptanceCriteria,
        "- Implement the task.\n- Run relevant validation.",
      ),
      priority: numberField(record.priority, 100 - index),
      workpad: stringField(record.workpad, "Created by GoalForge prompt compiler."),
    };
  });

  if (!drafts.length) {
    throw new Error("Planner returned no tasks.");
  }
  return drafts;
}

function buildPlannerPrompt(
  goalText: string,
  projectMemory = "No project memory was supplied.",
  workflowInstructions = "No WORKFLOW.md instructions were supplied.",
): string {
  return `You are the GoalForge prompt compiler for a local coding project.

Turn the user's rough feature request into one strong Codex-ready goal prompt.

Rules:
- Output only valid JSON. Do not wrap it in markdown.
- Return one JSON object, not an array.
- The object must include title, prompt, acceptanceCriteria, priority, and workpad.
- prompt is the exact multiline prompt a Codex worker will follow for this goal.
- prompt must be under 4,000 characters.
- priority is an integer from 0 to 999. Higher priority runs first.
- acceptanceCriteria must be a single markdown string with concrete checkable bullets.
- Keep the prompt scoped so one worker can complete it in an isolated git worktree.
- Include relevant repo-inspection, implementation, and validation instructions in the prompt.
- Mention dependency, parallelization, or delegation notes in workpad.
- Do not ask the user follow-up questions. Make reasonable assumptions and encode them in the prompt.
- Do not include unrelated cleanup.

Repo WORKFLOW.md instructions:
${workflowInstructions}

Current GoalForge board memory:
${projectMemory}

User goal:
${goalText}
`;
}

function extractJson(responseText: string): string {
  const trimmed = responseText.trim();
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    return trimmed;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return extractJson(fenced[1]);
  }
  const arrayStart = trimmed.indexOf("[");
  const arrayEnd = trimmed.lastIndexOf("]");
  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  const useObject = objectStart >= 0 && (arrayStart < 0 || objectStart < arrayStart);
  const start = useObject ? objectStart : arrayStart;
  const end = useObject ? objectEnd : arrayEnd;
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  throw new Error("Planner response did not contain JSON.");
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberField(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function limitText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }
  return value.slice(0, maxCharacters - 80).trimEnd() +
    "\n\n[GoalForge truncated this compiled prompt to keep it under 4,000 characters.]";
}
