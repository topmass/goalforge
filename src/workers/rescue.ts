// The rescue model: when a worker keeps failing verification, a stronger
// backend gets ONE advisory turn to diagnose what is wrong and tell the local
// model how to fix it. It never implements; its guidance flows into the next
// repair prompt and into project lessons.

import { GlobalConfig, readGlobalConfig } from "../board/global_config.ts";
import { ActivityEventInput, Task } from "../board/types.ts";
import { createAgentClient } from "./agent_backend.ts";
import { CodexClient } from "./codex_app_server.ts";
import { gitDiffStat, runCommand } from "./git_utils.ts";

export type RescueClientFactory = (
  onEvent: (event: ActivityEventInput) => void,
) => CodexClient;

export async function consultRescue(input: {
  root: string;
  task: Task;
  worktreePath: string;
  failureNotes: string;
  attempts: number;
  onEvent?: (event: ActivityEventInput) => void;
  createRescueClient?: RescueClientFactory;
  config?: GlobalConfig;
}): Promise<string | null> {
  const config = input.config ?? readGlobalConfig();
  let responseText = "";
  const factory = input.createRescueClient ??
    ((onEvent: (event: ActivityEventInput) => void) =>
      createAgentClient(input.root, onEvent, { ...config, backend: config.rescue.backend }));
  const codex = factory((event) => {
    if (event.role === "codex" && event.kind === "agent") {
      responseText += event.message;
      return;
    }
    input.onEvent?.({ ...event, role: "rescue" });
  });
  try {
    const diff = await collectDiff(input.worktreePath);
    const session = await codex.startSession(input.worktreePath, {
      name: `GoalForge rescue - ${input.task.id}`,
    });
    await codex.runTurn(session, {
      title: `${input.task.id}: rescue`,
      prompt: buildRescuePrompt(input.task, input.failureNotes, diff, input.attempts),
    });
    const guidance = responseText.trim();
    return guidance.length >= 20 ? guidance : null;
  } catch {
    return null;
  } finally {
    await codex.stop().catch(() => {});
  }
}

async function collectDiff(worktreePath: string): Promise<string> {
  try {
    const stat = await gitDiffStat(worktreePath);
    const diff = await runCommand(worktreePath, ["git", "diff"]);
    const untracked = await runCommand(worktreePath, [
      "git",
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    return [
      stat.trim(),
      diff.trim().slice(0, 6000),
      untracked.trim() ? `Untracked files:\n${untracked.trim()}` : "",
    ].filter(Boolean).join("\n\n") || "No uncommitted changes in the worktree.";
  } catch (error) {
    return `Unable to read worktree diff: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

export function buildRescuePrompt(
  task: Task,
  failureNotes: string,
  diff: string,
  attempts: number,
): string {
  return `You are the GoalForge rescue model: a senior engineer reviewing a stuck task.

A less capable local model has failed verification ${attempts} time${
    attempts === 1 ? "" : "s"
  } on this task. Diagnose what is actually wrong and tell it exactly how to fix it.

Task:
- ID: ${task.id}
- Title: ${task.title}
- Description: ${task.description}

Acceptance criteria:
${task.acceptanceCriteria || "- Complete the task."}

Latest verification failure:
${failureNotes}

Current uncommitted changes in the worktree (what the local model tried):
${diff}

Rules:
- You may read files and run read-only commands to investigate. Do NOT edit, write,
  or create files, and do NOT fix the problem yourself.
- Reply with a diagnosis-shaped handoff, not code: what is wrong and why, the exact
  smallest fix to make (named files, functions, behaviors), and the exact command that
  must pass afterward.
- No code blocks. Plain instructions a junior engineer could follow.
- If previous strategies clearly failed, say which different strategy to use now.
- Keep it under 25 lines.
`;
}
