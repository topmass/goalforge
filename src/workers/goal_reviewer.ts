import { ActivityEvent, Task } from "../board/types.ts";
import { CodexAppServerClient, CodexClient } from "./codex_app_server.ts";
import { collectAgentsInstructions } from "./project_context.ts";

export interface GoalReviewerOptions {
  onEvent?: (event: Omit<ActivityEvent, "id" | "createdAt">) => void;
  createCodexClient?: (
    onEvent: (event: Omit<ActivityEvent, "id" | "createdAt">) => void,
  ) => CodexClient;
}

export interface ReviewResult {
  verdict: "approved" | "changes_requested";
  notes: string;
}

export class GoalReviewer {
  readonly createCodexClient: (
    onEvent: (event: Omit<ActivityEvent, "id" | "createdAt">) => void,
  ) => CodexClient;

  constructor(private readonly root: string, private readonly options: GoalReviewerOptions = {}) {
    this.createCodexClient = options.createCodexClient ??
      ((onEvent) => new CodexAppServerClient(onEvent));
  }

  async review(task: Task): Promise<ReviewResult> {
    if (!task.worktreePath) {
      throw new Error(`${task.id} does not have an assigned worktree.`);
    }
    let responseText = "";
    const projectInstructions = await collectAgentsInstructions(this.root);
    const codex = this.createCodexClient((event) => {
      if (event.role === "codex" && event.kind === "agent") {
        responseText += event.message;
      }
      this.options.onEvent?.({
        taskId: task.id,
        runId: null,
        role: "reviewer",
        kind: event.kind,
        message: event.message,
      });
    });

    try {
      const session = await codex.startSession(task.worktreePath);
      await codex.runTurn(session, {
        title: `${task.id}: review`,
        prompt: buildReviewPrompt(task, projectInstructions),
      });
      return parseReviewResponse(responseText);
    } finally {
      await codex.stop().catch(() => {});
    }
  }
}

export function parseReviewResponse(responseText: string): ReviewResult {
  const notes = responseText.trim();
  if (!notes) {
    throw new Error("Reviewer returned no notes.");
  }
  const verdict = /\bCHANGES_REQUESTED\b/i.test(notes) ? "changes_requested" : "approved";
  return { verdict, notes };
}

function buildReviewPrompt(task: Task, projectInstructions: string): string {
  return `You are the GoalForge reviewer for one local coding task.

Review the implementation in this assigned worktree. Do not modify files.

Project AGENTS.md context from the original folder:
${projectInstructions}

Task:
- ID: ${task.id}
- Title: ${task.title}
- Description: ${task.description}

Acceptance criteria:
${task.acceptanceCriteria || "- Complete the task."}

Worker validation evidence:
${task.validation || "No validation evidence recorded."}

Review rules:
- Inspect the diff and validation evidence.
- Run only lightweight read-only checks unless a validation command is clearly needed.
- Start your final answer with exactly APPROVED or CHANGES_REQUESTED.
- Include concrete findings, missing validation, or remaining risks.
- Keep the review scoped to this task.
`;
}
