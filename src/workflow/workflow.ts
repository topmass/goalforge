import { workflowPath } from "../paths.ts";
import type { ReasoningEffort } from "../board/store.ts";

export type WorkflowHookStage = "after_create" | "before_run" | "after_run" | "before_remove";

export interface WorkflowHook {
  command: string;
  timeoutMs: number;
}

export interface WorkflowAuthority {
  publish: boolean;
  maxTriageRetries: number;
}

export interface WorkflowRuntime {
  version: number;
  trackerKind: "goalforge-local";
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetries: number;
  retryBackoffMs: number;
  model: string;
  reasoningEffort: ReasoningEffort;
  fastMode: boolean;
  githubPrReview: boolean;
  worktreesDir: string;
  hooks: Record<WorkflowHookStage, WorkflowHook[]>;
  authority: WorkflowAuthority;
  instructions: string;
}

type ParsedValue = string | number | boolean | string[] | ParsedRecord;

interface ParsedRecord {
  [key: string]: ParsedValue;
}

const HOOK_STAGES: WorkflowHookStage[] = [
  "after_create",
  "before_run",
  "after_run",
  "before_remove",
];

export function ensureWorkflow(root: string): void {
  const target = workflowPath(root);
  try {
    Deno.statSync(target);
  } catch {
    Deno.writeTextFileSync(target, defaultWorkflow());
  }
}

export function readWorkflow(root: string): WorkflowRuntime {
  ensureWorkflow(root);
  return parseWorkflow(Deno.readTextFileSync(workflowPath(root)));
}

export function parseWorkflow(source: string): WorkflowRuntime {
  const { frontmatter, body } = splitFrontmatter(source);
  const data = parseSimpleYaml(frontmatter);
  const agent = record(data.agent);
  const codex = record(data.codex);
  const tracker = record(data.tracker);
  const workspace = record(data.workspace);
  const github = record(data.github);
  const hooks = record(workspace.hooks);
  const authority = record(data.authority);

  return {
    version: numberValue(data.version, 1),
    trackerKind: tracker.kind === "goalforge-local" ? "goalforge-local" : "goalforge-local",
    maxConcurrentAgents: positiveInt(agent.max_concurrent_agents, 2),
    maxTurns: positiveInt(agent.max_turns, 3),
    maxRetries: positiveInt(agent.max_retries, 1),
    retryBackoffMs: positiveInt(agent.retry_backoff_ms, 1000),
    model: stringValue(codex.model, "gpt-5.5"),
    reasoningEffort: reasoningValue(codex.reasoning_effort, "high"),
    fastMode: booleanValue(codex.fast_mode, true),
    githubPrReview: booleanValue(github.pr_review, false),
    worktreesDir: stringValue(workspace.worktrees_dir, ".goalforge/worktrees"),
    hooks: normalizeHooks(hooks),
    authority: {
      publish: booleanValue(authority.publish, true),
      maxTriageRetries: nonNegativeInt(authority.max_triage_retries, 2),
    },
    instructions: body.trim() || defaultInstructions(),
  };
}

export function defaultWorkflow(): string {
  return `---
version: 1
tracker:
  kind: goalforge-local
agent:
  max_concurrent_agents: 2
	  max_turns: 3
  max_retries: 1
  retry_backoff_ms: 1000
codex:
  model: gpt-5.5
  reasoning_effort: high
  fast_mode: true
github:
  pr_review: false
authority:
  publish: true
  max_triage_retries: 2
workspace:
  worktrees_dir: .goalforge/worktrees
  hooks:
    after_create: []
    before_run: []
    after_run: []
    before_remove: []
---
${defaultInstructions()}
`;
}

function defaultInstructions(): string {
  return `# GoalForge Workflow

GoalForge is a local Codex orchestration layer backed by this repository's Kanban board.
Use this file as the repo-owned contract for how agents should plan, implement, test, review,
and merge work.

## Board Contract
- Inbox is for raw or paused work that needs user input.
- Ready is dispatchable work.
- Started is work currently owned by a Codex worker.
- Review means implementation and validation evidence exist.
- Inbox also holds work that needs user direction or a resolved blocker.
- Done means the reviewer approved the work and GoalForge merged it.

## Loop Contract
Every task moves through a durable loop:
Queued -> Planning -> Working -> Testing -> Repairing -> Reviewing -> Remembering -> Done.
Blocked means GoalForge has a concrete blocker or user decision to show in the TUI.
Each phase should preserve the current gate, next action, verification summary, and any needed input.

## Workpad Contract
Every worker handoff should preserve:
- The task objective and any narrowed assumptions.
- Files or surfaces inspected.
- Files changed.
- Validation commands and observed results.
- Blockers, confusions, or follow-up tasks.

	## Agent Contract
	- Work in the assigned worktree only.
	- Keep edits scoped to the task acceptance criteria.
	- Follow the task verification plan and any discovered verification gates.
	- Use subagents only for independent investigation, verification, or implementation slices.
- Do not mutate .goalforge runtime state directly.
- Do not create commits; GoalForge records commits, reviews, and merges.
- If blocked, state the blocker and the exact user decision or repo change needed.

## Authority Contract
- Repo-level operations such as committing the root working tree and pushing to the remote are
  GoalForge harness actions, never agent actions. The authority frontmatter controls them:
  publish allows the harness publish action, max_triage_retries bounds triage-driven retries.
- When a worker blocks with a concrete question, the GoalForge main agent triages it first:
  resolve it with an allowed harness action, retry the worker once with corrected instructions,
  or escalate to the user with one clear ask.
- Hard external blockers (missing credentials, third-party accounts, user-only decisions) always
  escalate immediately. The same blocker appearing twice always escalates.
`;
}

function splitFrontmatter(source: string): { frontmatter: string; body: string } {
  if (!source.startsWith("---\n")) {
    return { frontmatter: "", body: source };
  }
  const end = source.indexOf("\n---", 4);
  if (end < 0) {
    return { frontmatter: "", body: source };
  }
  return {
    frontmatter: source.slice(4, end).trim(),
    body: source.slice(end + 4).replace(/^\r?\n/, ""),
  };
}

function parseSimpleYaml(source: string): Record<string, ParsedValue> {
  const root: Record<string, ParsedValue> = {};
  const stack: Array<{
    indent: number;
    value: Record<string, ParsedValue> | string[];
    parent?: Record<string, ParsedValue>;
    key?: string;
  }> = [
    { indent: -1, value: root },
  ];
  for (const rawLine of source.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith("#")) {
      continue;
    }
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const line = rawLine.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    if (line.startsWith("- ")) {
      let current = stack[stack.length - 1];
      if (!Array.isArray(current.value) && current.parent && current.key) {
        const items: string[] = [];
        current.parent[current.key] = items;
        current = { ...current, value: items };
        stack[stack.length - 1] = current;
      }
      if (Array.isArray(current.value)) {
        current.value.push(String(parseScalar(line.slice(2))));
      }
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+):(?:\s*(.*))?$/);
    if (!match) {
      continue;
    }
    const parent = stack[stack.length - 1].value;
    if (Array.isArray(parent)) {
      continue;
    }
    const key = match[1];
    const rest = match[2] ?? "";
    if (!rest) {
      const child: Record<string, ParsedValue> = {};
      parent[key] = child;
      stack.push({ indent, value: child, parent, key });
    } else {
      parent[key] = parseScalar(rest);
    }
  }
  return root;
}

function parseScalar(value: string): ParsedValue {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === "[]") return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => item.trim()).filter(Boolean);
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

function normalizeHooks(
  hooks: Record<string, ParsedValue>,
): Record<WorkflowHookStage, WorkflowHook[]> {
  const result: Record<WorkflowHookStage, WorkflowHook[]> = {
    after_create: [],
    before_run: [],
    after_run: [],
    before_remove: [],
  };
  for (const stage of HOOK_STAGES) {
    const value = hooks[stage];
    if (Array.isArray(value)) {
      result[stage] = value.map((command) => ({ command, timeoutMs: 120000 }));
    } else if (typeof value === "string" && value.trim()) {
      result[stage] = [{ command: value.trim(), timeoutMs: 120000 }];
    }
  }
  return result;
}

function record(value: ParsedValue | undefined): Record<string, ParsedValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stringValue(value: ParsedValue | undefined, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: ParsedValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInt(value: ParsedValue | undefined, fallback: number): number {
  const number = numberValue(value, fallback);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInt(value: ParsedValue | undefined, fallback: number): number {
  const number = numberValue(value, fallback);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function booleanValue(value: ParsedValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function reasoningValue(
  value: ParsedValue | undefined,
  fallback: ReasoningEffort,
): ReasoningEffort {
  return typeof value === "string" && ["low", "medium", "high", "xhigh"].includes(value)
    ? value as ReasoningEffort
    : fallback;
}
