import { ActivityEventInput, Task } from "../board/types.ts";
import { CodexClient } from "./codex_app_server.ts";
import { createAgentClient } from "./agent_backend.ts";
import { collectAgentsInstructions } from "./project_context.ts";
import { buildProjectMemory } from "./project_memory.ts";
import { shouldRecordActivity } from "./activity_filter.ts";
import { BoardStore } from "../board/store.ts";
import { readWorkflow } from "../workflow/workflow.ts";

export interface GoalReviewerOptions {
  onEvent?: (event: ActivityEventInput) => void;
  createCodexClient?: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;
}

export interface ReviewResult {
  verdict: "approved" | "changes_requested";
  notes: string;
}

export class GoalReviewer {
  readonly createCodexClient: (
    onEvent: (event: ActivityEventInput) => void,
  ) => CodexClient;

  constructor(private readonly root: string, private readonly options: GoalReviewerOptions = {}) {
    this.createCodexClient = options.createCodexClient ??
      ((onEvent) => createAgentClient(this.root, onEvent));
  }

  async review(task: Task): Promise<ReviewResult> {
    if (!task.worktreePath) {
      throw new Error(`${task.id} does not have an assigned worktree.`);
    }
    let responseText = "";
    const projectInstructions = await collectAgentsInstructions(this.root);
    const store = new BoardStore(this.root);
    const workflow = readWorkflow(this.root);
    let projectMemory = "";
    try {
      projectMemory = buildProjectMemory(store);
    } finally {
      store.close();
    }
    const codex = this.createCodexClient((event) => {
      if (event.role === "codex" && event.kind === "agent") {
        responseText += event.message;
      }
      const activity = {
        taskId: task.id,
        runId: null,
        role: "reviewer",
        kind: event.kind,
        message: event.message,
      };
      if (shouldRecordActivity(activity)) {
        this.options.onEvent?.(activity);
      }
    });

    try {
      const session = await codex.startSession(task.worktreePath);
      const prompt = buildReviewPrompt(
        task,
        projectInstructions,
        projectMemory,
        workflow.instructions,
      );
      // Transient transport drops can end a turn with no captured text.
      // Retry the review turn in place before failing the whole task attempt.
      for (let attempt = 1; attempt <= 3; attempt++) {
        responseText = "";
        await codex.runTurn(session, {
          title: `${task.id}: review`,
          prompt: attempt === 1
            ? prompt
            : "Your previous review reply did not arrive. Reply again now with your final verdict: start with APPROVED or CHANGES_REQUESTED, then your notes.",
        });
        if (responseText.trim()) {
          break;
        }
      }
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

function buildReviewPrompt(
  task: Task,
  projectInstructions: string,
  projectMemory: string,
  workflowInstructions: string,
): string {
  return `You are the GoalForge reviewer for one local coding task.

Review the implementation in this assigned worktree. Do not modify files.

Project AGENTS.md context from the original folder:
${projectInstructions}

Repo WORKFLOW.md instructions:
${workflowInstructions}

Current GoalForge board memory:
${projectMemory}

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
- GoalForge runs pseudo-autonomously; judge outcomes, not style. Criteria that need the
  running app or manual QA and are honestly recorded in the evidence as
  "needs manual verification" are not grounds for CHANGES_REQUESTED when the in-repo
  evidence covers everything else.
`;
}
