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

export interface VerificationResult {
  verdict: "passed" | "failed" | "needs_input";
  notes: string;
}

export class GoalTestEngineer {
  constructor(
    private readonly projectInstructions: string,
    private readonly projectMemory: string,
    private readonly workflowInstructions: string,
    private readonly verificationGates: string,
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
      prompt: buildTestPrompt(
        task,
        this.projectInstructions,
        this.projectMemory,
        this.workflowInstructions,
        this.verificationGates,
      ),
    });
  }
}

function buildTestPrompt(
  task: Task,
  projectInstructions: string,
  projectMemory: string,
  workflowInstructions: string,
  verificationGates: string,
): string {
  return `You are the GoalForge test engineer for one local coding task.

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
- Risk: ${task.riskLevel}
- Dependencies: ${task.dependencyIds.length ? task.dependencyIds.join(", ") : "none"}

Acceptance criteria:
${task.acceptanceCriteria || "- Complete the task."}

Verification plan:
${task.verificationPlan || "- Run focused validation for the changed surface."}

Discovered verification gates:
${verificationGates}

Rules:
- Work in the current assigned git worktree only.
- Treat this as the test/verification pass after implementation.
- Inspect the changed surface and existing project test conventions.
- Add or update focused tests only when that is the right way to prove this task.
- Run the exact relevant tests, build, typecheck, lint, or smoke checks for the changed surface.
- If this is a GoalForge contract-evidence or completion-evidence repair task, quote each listed missing contract clause or evidence gap you proved and the exact command/result or inspection that proves it.
	- Do not create commits yourself. The GoalForge daemon commits after this pass.
	- Keep scope tight. Do not perform unrelated cleanup.
	- Start your final answer with exactly VERIFICATION_PASSED, VERIFICATION_FAILED, or NEEDS_INPUT.
	- End with a concise test handoff listing test files changed, commands run, results, and remaining risks.
	`;
}

export function parseVerificationResponse(responseText: string): VerificationResult {
  const notes = responseText.trim();
  const verdict = notes.toUpperCase();
  if (!notes) {
    return {
      verdict: "failed",
      notes:
        "VERIFICATION_FAILED\n- Test engineer returned no explicit verification verdict or notes.",
    };
  }
  if (verdict.startsWith("NEEDS_INPUT")) {
    return { verdict: "needs_input", notes };
  }
  if (verdict.startsWith("VERIFICATION_FAILED")) {
    return { verdict: "failed", notes };
  }
  if (verdict.startsWith("VERIFICATION_PASSED")) {
    if (!hasProofDetails(notes)) {
      return {
        verdict: "failed",
        notes: [
          "VERIFICATION_FAILED",
          "- Test engineer returned VERIFICATION_PASSED without proof details.",
          "",
          "Original response:",
          notes,
        ].join("\n"),
      };
    }
    return { verdict: "passed", notes };
  }
  return {
    verdict: "failed",
    notes: [
      "VERIFICATION_FAILED",
      "- Test engineer did not start with VERIFICATION_PASSED, VERIFICATION_FAILED, or NEEDS_INPUT.",
      "",
      "Original response:",
      notes,
    ].join("\n"),
  };
}

function hasProofDetails(notes: string): boolean {
  const lines = notes.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sameLineProof = lines[0]
    ?.replace(/^VERIFICATION_PASSED/i, "")
    .replace(/^[-:\s]+/, "")
    .trim();
  if (sameLineProof && sameLineProof.length >= 8) {
    return true;
  }
  return lines.slice(1).some((line) =>
    !/^VERIFICATION_PASSED\b/i.test(line) && line.replace(/^[-*]\s*/, "").length >= 8
  );
}
