// Main-agent triage of worker blockers. The main thread gets one constrained
// turn to classify a NEEDS_INPUT blocker: resolve it with an allowed harness
// action, retry the worker with corrected instructions, or escalate to the
// user with one clear ask. Parsing fails closed to escalate.

import { Task } from "../board/types.ts";

export type TriageVerdict = "resolve" | "retry" | "escalate";

export interface TriageDecision {
  verdict: TriageVerdict;
  action: string | null;
  message: string;
}

export function parseTriageResponse(
  responseText: string,
  allowedActions: string[],
): TriageDecision {
  const lines = responseText.split(/\r?\n/).map((line) => line.trim());
  const headerIndex = lines.findIndex((line) => /^TRIAGE_(RESOLVE|RETRY|ESCALATE)\b/.test(line));
  if (headerIndex < 0) {
    return { verdict: "escalate", action: null, message: "" };
  }
  const header = lines[headerIndex];
  const message = lines.slice(headerIndex + 1).join("\n").trim();
  if (header.startsWith("TRIAGE_RESOLVE")) {
    const action = header.replace("TRIAGE_RESOLVE", "").trim().toLowerCase();
    if (!allowedActions.includes(action)) {
      return { verdict: "escalate", action: null, message };
    }
    return { verdict: "resolve", action, message };
  }
  if (header.startsWith("TRIAGE_RETRY")) {
    if (!message) {
      return { verdict: "escalate", action: null, message: "" };
    }
    return { verdict: "retry", action: null, message };
  }
  return { verdict: "escalate", action: null, message };
}

export function fingerprintBlocker(blocker: string): string {
  return blocker
    .toLowerCase()
    .replace(/[0-9a-f]{7,40}/g, "#")
    .replace(/\d+/g, "#")
    .replace(/[/\\][^\s`"']+/g, "/path")
    .replace(/[^a-z# ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function buildTriagePrompt(input: {
  task: Task;
  blocker: string;
  allowedActions: string[];
  projectMemory: string;
  workflowInstructions: string;
}): string {
  const actions = input.allowedActions.length
    ? input.allowedActions.map((action) =>
      `- ${action}: ${ACTION_DESCRIPTIONS[action] ?? "harness action"}`
    ).join("\n")
    : "- none available";
  return `You are the GoalForge main agent triaging a blocked sub-agent task.

A worker on ${input.task.id} stopped and asked for input. Decide whether GoalForge can resolve
this itself, whether the worker should retry once with corrected instructions, or whether the
user must be asked.

GoalForge runs pseudo-autonomously: the user may be away for hours and expects to come back to
finished work, not a stalled queue. Escalation is the last resort, reserved for blockers where
literally nothing can proceed without the user.

Task:
- ID: ${input.task.id}
- Title: ${input.task.title}
- Description: ${input.task.description}
- Triage attempts so far: ${input.task.triageAttempts}

Blocker reported by the worker:
${input.blocker}

Harness actions you may invoke (run deterministically by GoalForge, not by an agent):
${actions}

Repo WORKFLOW.md instructions:
${input.workflowInstructions}

Current GoalForge board memory:
${input.projectMemory}

Rules:
- Reply with exactly one verdict in the required format. No markdown, no preamble.
- TRIAGE_RESOLVE <action> when one allowed harness action directly satisfies the blocker.
- TRIAGE_RETRY followed by corrected instructions when the worker misunderstood the task or
  missed context you can supply. Only choose this when a retry can plausibly succeed.
- Blockers of the form "this can only be tested in the running app/game", "needs manual QA",
  or "cannot verify visually" are never escalations. TRIAGE_RETRY with instructions to verify
  everything checkable inside the repository (builds, tests, greps, inspection) and record the
  rest in the handoff as "needs manual verification: <what and how>".
- A worker asking which reasonable option to pick (naming, structure, library already used in
  the repo, test approach) is not an escalation: TRIAGE_RETRY and tell it to pick the option
  most consistent with the existing code and note the decision in its handoff.
- TRIAGE_ESCALATE followed by a single-sentence ask when the blocker needs something only the
  user can provide: credentials, API keys, third-party accounts, money, destructive approval,
  or a product decision. Never retry these.
- When unsure, escalate.

Required format (pick one):
TRIAGE_RESOLVE <action>
<one line explaining why>

TRIAGE_RETRY
<corrected instructions for the worker>

TRIAGE_ESCALATE
<single-sentence ask telling the user exactly what to provide or decide>
`;
}

const ACTION_DESCRIPTIONS: Record<string, string> = {
  publish:
    "commit the repository root working tree and push the current branch to the origin remote",
};
