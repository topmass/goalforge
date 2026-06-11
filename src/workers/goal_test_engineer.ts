import { ActivityEventInput, Task } from "../board/types.ts";
import { AUTONOMY_CONTRACT } from "../board/prompts.ts";
import { extractVerificationVerdictToken } from "../board/validation_evidence.ts";
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

${AUTONOMY_CONTRACT}
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
	- NEEDS_INPUT is reserved for the absolute blockers in Autonomous Operation (credentials, third-party access, destructive approval, or a scope-changing product decision). "This can only be tested in the running app/game" or "needs manual QA" is never NEEDS_INPUT: verify everything checkable in-repo, and when those checks pass return VERIFICATION_PASSED listing each unverifiable criterion under Remaining risks as "needs manual verification: <what and how>".
	- End with a concise test handoff listing test files changed, commands run, results, and remaining risks.
- A bare verdict token is rejected. Your final answer must follow this exact template:

VERIFICATION_PASSED
- <command you ran>: <observed result>
- <command you ran>: <observed result>
Test files changed: <list or none>
Remaining risks: <one line or none>
	`;
}

export function parseVerificationResponse(responseText: string): VerificationResult {
  const notes = responseText.trim();
  if (!notes) {
    return {
      verdict: "failed",
      notes:
        "VERIFICATION_FAILED\n- Test engineer returned no explicit verification verdict or notes.",
    };
  }
  const verdict = extractVerificationVerdictToken(notes);
  const normalized = verdict && !notes.toUpperCase().startsWith(verdict)
    ? `${verdict}\n${notes}`
    : notes;
  if (verdict === "NEEDS_INPUT") {
    return { verdict: "needs_input", notes: normalized };
  }
  if (verdict === "VERIFICATION_FAILED") {
    return { verdict: "failed", notes: normalized };
  }
  if (verdict === "VERIFICATION_PASSED") {
    if (!hasProofDetails(normalized)) {
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
    return { verdict: "passed", notes: normalized };
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
