import path from "node:path";
import { Task } from "../board/types.ts";
import { contextPath, taskArtifactsPath, workflowPath } from "../paths.ts";

export interface TaskContextArtifacts {
  taskDir: string;
  taskPacketPath: string;
  manifestPath: string;
}

export interface TaskMemoryInput {
  root: string;
  task: Task;
  projectInstructions: string;
  workflowInstructions: string;
  projectMemory: string;
  queuedMessages: string;
}

export function ensureProjectKnowledgeFiles(root: string): void {
  ensureAgentsFile(root);
  ensureSpecsheet(root);
  ensureCurrentState(root);
}

export function writeTaskContextArtifacts(input: TaskMemoryInput): TaskContextArtifacts {
  const taskDir = taskArtifactsPath(input.root, input.task.id);
  Deno.mkdirSync(taskDir, { recursive: true });
  const taskPacketPath = path.join(taskDir, "task-packet.md");
  const manifestPath = path.join(taskDir, "context-manifest.json");
  const taskPacket = buildTaskPacket(input);
  Deno.writeTextFileSync(taskPacketPath, taskPacket);
  Deno.writeTextFileSync(
    manifestPath,
    JSON.stringify(
      {
        taskId: input.task.id,
        taskPacket: taskPacketPath,
        loop: {
          phase: input.task.loopPhase,
          attempt: input.task.loopAttempt,
          gate: input.task.currentGate,
          nextAction: input.task.nextAction,
        },
        dependencies: input.task.dependencyIds,
        risk: input.task.riskLevel,
        verificationPlan: input.task.verificationPlan,
        required: requiredContextPaths(input.root),
        rules: [
          "Read the task packet before editing.",
          "Read AGENTS.md, project-specsheet.md, and WORKFLOW.md when present.",
          "Work only in the assigned worktree for code edits.",
          "Do not mutate .loopforge runtime state directly.",
          "End with a LoopForge compact handoff.",
        ],
      },
      null,
      2,
    ) + "\n",
  );
  return { taskDir, taskPacketPath, manifestPath };
}

export function buildTaskCard(task: Task, touchedPaths: string[] = task.touchedPaths): string {
  return [
    `${task.id} status: ${task.status}`,
    `Goal: ${task.title}`,
    `Thread: ${task.threadId ?? "unassigned"}`,
    `Parent: ${task.parentThreadId ?? "none"}`,
    `Worktree: ${task.worktreePath ?? "unassigned"}`,
    `Loop: ${task.loopPhase} attempt ${task.loopAttempt} gate ${task.currentGate}`,
    `Next: ${task.nextAction}`,
    `Risk: ${task.riskLevel}`,
    `Dependencies: ${task.dependencyIds.length ? task.dependencyIds.join(", ") : "none"}`,
    "Verification plan:",
    ...formatTextBlock(
      task.verificationPlan || "- Run focused validation for the changed surface.",
    ),
    "Verification summary:",
    ...formatTextBlock(task.verificationSummary || "- none yet"),
    "Supervisor:",
    ...formatTextBlock(task.supervisorDecision || "- no supervisor decisions"),
    "Touched:",
    ...formatList(touchedPaths, "- none yet"),
    "Validated:",
    ...formatValidation(task.validation),
    "Risk:",
    ...formatList(task.conflictSignals, "- none known"),
    "Fallback next:",
    `- ${nextAction(task)}`,
  ].join("\n");
}

export function buildFinalHandoff(task: Task, touchedPaths: string[]): string {
  return [
    "# LoopForge Task Handoff",
    "",
    `Task: ${task.id}`,
    `Branch: ${task.branchName ?? "none"}`,
    `Worktree: ${task.worktreePath ?? "none"}`,
    `Thread: ${task.threadId ?? "none"}`,
    "",
    "## Outcome",
    task.title,
    "",
    "## Files Changed",
    ...formatList(touchedPaths, "- no tracked file changes detected"),
    "",
    "## Validation",
    compactValidation(task.validation),
    "",
    "## Decisions",
    "- See task validation and final Codex handoff for implementation decisions.",
    "",
    "## Project Memory Updates",
    `- ${task.id} completed: ${task.title}`,
    "",
    "## Conflict Signals",
    ...formatList(task.conflictSignals, "- none known"),
    "",
    "## Supervisor Decisions",
    task.supervisorDecision || "- none recorded",
    "",
    "## Follow-ups",
    "- none recorded",
  ].join("\n");
}

export function buildMainThreadAbsorptionPrompt(task: Task): string {
  return `Absorb this completed LoopForge task into the project main thread.

Compact style:
- Small words. Exact facts.
- One fact per line.
- Keep durable project facts, validation, conflicts, and follow-ups.
- Do not replay raw logs.

Task card:
${task.taskCard || "No task card recorded."}

Final handoff:
${task.handoffSummary || "No final handoff recorded."}

Validation:
${task.validation || "No validation recorded."}
`;
}

export function appendSpecsheetHandoff(root: string, task: Task): void {
  const target = path.join(root, "project-specsheet.md");
  const current = safeRead(target) || defaultSpecsheet();
  const entry = [
    "",
    `## ${task.id}: ${task.title}`,
    "",
    task.handoffSummary || "- No handoff summary recorded.",
    "",
  ].join("\n");
  if (current.includes(`## ${task.id}:`)) {
    return;
  }
  Deno.writeTextFileSync(target, `${current.trimEnd()}\n${entry}`);
}

export function defaultAgentsInstructions(): string {
  return [
    "# LoopForge Project Instructions",
    "",
    "- Read `project-specsheet.md` for durable project behavior and feature notes.",
    "- Read `WORKFLOW.md` for LoopForge task, review, and merge rules.",
    "- For LoopForge-assigned tasks, read the generated context manifest named in the prompt.",
    "- Keep implementation scope tied to the assigned task.",
    "- End task work with a compact handoff: changed files, validation, risks, follow-ups.",
    "",
  ].join("\n");
}

function ensureAgentsFile(root: string): void {
  const target = path.join(root, "AGENTS.md");
  if (safeRead(target)) {
    return;
  }
  Deno.writeTextFileSync(target, defaultAgentsInstructions());
}

function ensureSpecsheet(root: string): void {
  const target = path.join(root, "project-specsheet.md");
  if (!safeRead(target)) {
    Deno.writeTextFileSync(target, defaultSpecsheet());
  }
}

function ensureCurrentState(root: string): void {
  const target = contextPath(root, "current-state.md");
  if (!safeRead(target)) {
    Deno.writeTextFileSync(
      target,
      [
        "# LoopForge Current State",
        "",
        "- LoopForge uses one project main thread for planning and memory.",
        "- Each task runs in an isolated worktree with its own child Codex thread.",
        "- Completed task handoffs are compacted before main-thread absorption.",
        "",
      ].join("\n"),
    );
  }
}

function buildTaskPacket(input: TaskMemoryInput): string {
  return `# ${input.task.id}: ${input.task.title}

## Required Context
- AGENTS.md
- project-specsheet.md
- WORKFLOW.md
- ${contextPath(input.root, "current-state.md")}

## Task
${input.task.description}

	## Acceptance Criteria
	${input.task.acceptanceCriteria || "- Complete the task."}

	## Verification Plan
	${input.task.verificationPlan || "- Run focused validation for the changed surface."}

	## Loop State
	- Phase: ${input.task.loopPhase}
	- Attempt: ${input.task.loopAttempt}
	- Current gate: ${input.task.currentGate}
	- Next action: ${input.task.nextAction}
	- Risk: ${input.task.riskLevel}
	- Dependencies: ${input.task.dependencyIds.length ? input.task.dependencyIds.join(", ") : "none"}

## Project AGENTS.md Context
${input.projectInstructions || "No AGENTS.md context found."}

## WORKFLOW.md Context
${input.workflowInstructions || "No WORKFLOW.md context found."}

## Board Memory
${input.projectMemory || "No board memory supplied."}

## Queued Messages
${input.queuedMessages}
`;
}

function requiredContextPaths(root: string): string[] {
  return [
    path.join(root, "AGENTS.md"),
    path.join(root, "project-specsheet.md"),
    workflowPath(root),
    contextPath(root, "current-state.md"),
  ];
}

function defaultSpecsheet(): string {
  return [
    "# Project Specsheet",
    "",
    "LoopForge durable project memory.",
    "",
    "## Rules",
    "",
    "- Keep task summaries compact and factual.",
    "- Promote only validated or merged behavior into this file.",
    "- Use exact file paths, commands, risks, and follow-ups.",
    "",
  ].join("\n");
}

function formatList(values: string[], empty: string): string[] {
  return values.length ? values.map((value) => `- ${value}`) : [empty];
}

function formatValidation(validation: string): string[] {
  if (!validation.trim()) {
    return ["- none yet"];
  }
  return validation.split(/\r?\n/).filter((line) =>
    /^(Turn status:|Test turn status:|Verification verdict:|Commit:|Git status:|Diff stat:|LoopForge review:)/
      .test(line)
  ).slice(0, 8).map((line) => `- ${line}`);
}

function formatTextBlock(value: string): string[] {
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 8);
  return lines.length ? lines.map((line) => line.startsWith("-") ? line : `- ${line}`) : ["- none"];
}

function compactValidation(validation: string): string {
  const lines = formatValidation(validation);
  return lines.length ? lines.join("\n") : "- validation recorded in task";
}

function nextAction(task: Task): string {
  switch (task.status) {
    case "ready":
    case "inbox":
      return "start task";
    case "in_progress":
      return "finish implementation and validation";
    case "review":
      return "review and merge";
    case "merging":
      return "finish the merge";
    case "blocked":
      return task.blockedReason ?? "needs input";
    case "done":
      return "absorbed into project memory";
  }
}

function safeRead(target: string): string {
  try {
    return Deno.readTextFileSync(target);
  } catch {
    return "";
  }
}
