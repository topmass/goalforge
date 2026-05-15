import { ActivityEventInput, Task } from "../board/types.ts";
import { CodexSession, CodexTurnResult } from "./codex_app_server.ts";

export interface TurnRunner {
  runTurn(
    session: CodexSession,
    input: { title: string; prompt: string },
  ): Promise<CodexTurnResult>;
}

export interface GoalTestEngineerOptions {
  onEvent?: (event: ActivityEventInput) => void;
}

export class GoalTestEngineer {
  constructor(
    private readonly projectInstructions: string,
    private readonly projectMemory: string,
    private readonly options: GoalTestEngineerOptions = {},
  ) {}

  async run(
    client: TurnRunner,
    session: CodexSession,
    task: Task,
  ): Promise<CodexTurnResult> {
    this.options.onEvent?.({
      taskId: task.id,
      runId: null,
      role: "test-engineer",
      kind: "phase",
      message: "Starting test-engineer validation pass.",
    });
    return await client.runTurn(session, {
      title: `${task.id}: test-engineer`,
      prompt: buildTestPrompt(task, this.projectInstructions, this.projectMemory),
    });
  }
}

function buildTestPrompt(task: Task, projectInstructions: string, projectMemory: string): string {
  return `You are the GoalForge test engineer for one local coding task.

Project AGENTS.md context from the original folder:
${projectInstructions}

Current GoalForge board memory:
${projectMemory}

Task:
- ID: ${task.id}
- Title: ${task.title}
- Description: ${task.description}

Acceptance criteria:
${task.acceptanceCriteria || "- Complete the task."}

Rules:
- Work in the current assigned git worktree only.
- Treat this as the test/verification pass after implementation.
- Inspect the changed surface and existing project test conventions.
- Add or update focused tests only when that is the right way to prove this task.
- Run the exact relevant tests, build, typecheck, lint, or smoke checks for the changed surface.
- Do not create commits yourself. The GoalForge daemon commits after this pass.
- Keep scope tight. Do not perform unrelated cleanup.
- End with a concise test handoff listing test files changed, commands run, results, and remaining risks.
`;
}
