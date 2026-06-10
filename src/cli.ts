import { BoardStore } from "./board/store.ts";
import { TASK_STATUS_LABELS } from "./board/types.ts";
import { formatGoalLines, formatHealthLines, formatStatusLines } from "./board/status_lines.ts";
import { summarizeGoalProgress } from "./board/goal_progress.ts";
import { normalizeRoot, workflowPath } from "./paths.ts";
import { startServer } from "./web/server.ts";
import { runCommandCenterTui } from "./tui/command_center.ts";
import { ensureGitRepository, gitMergeBranch } from "./workers/git_utils.ts";
import { GoalPlanner } from "./workers/goal_planner.ts";
import { GoalReviewer } from "./workers/goal_reviewer.ts";
import { GoalForgeWorker } from "./workers/goalforge_worker.ts";
import { buildProjectMemory } from "./workers/project_memory.ts";
import { buildTaskCard, ensureProjectKnowledgeFiles } from "./workers/task_memory.ts";
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_HOOK_EVENTS,
  hookCommand,
  mergeHookSettings,
} from "./workers/agent_hooks.ts";
import { readWorkflow } from "./workflow/workflow.ts";

const root = normalizeRoot(Deno.cwd());
const [command, ...args] = normalizeArgs(Deno.args);

try {
  switch (command) {
    case "init":
      await initCommand();
      break;
    case "goal":
      await goalCommand(args);
      break;
    case "build":
      await buildCommand(args);
      break;
    case "plan":
      await planCommand(args);
      break;
    case "run":
      await runCommand(args);
      break;
    case "serve":
    case "board":
      await serveCommand(args);
      break;
    case "tui":
      await tuiCommand(args);
      break;
    case "command-center":
    case "native-tui":
      await runCommandCenterTui(root, args);
      break;
    case "opentui":
      await openTuiCommand(args);
      break;
    case "status":
      statusCommand();
      break;
    case "health":
      healthCommand();
      break;
    case "doctor":
      doctorCommand();
      break;
    case "dogfood":
      await dogfoodCommand(args);
      break;
    case "goals":
      goalsCommand();
      break;
    case "workflow":
      workflowCommand();
      break;
    case "merge":
      await mergeCommand(args);
      break;
    case "review":
      await reviewCommand(args);
      break;
    case "delete":
    case "remove":
      deleteCommand(args);
      break;
    case "message":
      messageCommand(args);
      break;
    case "main":
      await mainCommand(args);
      break;
    case "task":
      taskCommand(args);
      break;
    case "steer":
      await steerCommand(args);
      break;
    case "compact":
      compactCommand(args);
      break;
    case "close-goal":
    case "close":
      closeGoalCommand(args);
      break;
    case "hooks":
      await hooksCommand(args);
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      printHelp();
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`goalforge: ${message}`);
  Deno.exit(1);
}

async function initCommand(): Promise<void> {
  const store = new BoardStore(root);
  try {
    store.initProject();
    const actions = await ensureGitRepository(root);
    console.log(`GoalForge initialized at ${root}/.goalforge`);
    console.log(`Workflow ${workflowPath(root)}`);
    for (const action of actions) {
      console.log(action);
    }
  } finally {
    store.close();
  }
}

function workflowCommand(): void {
  const workflow = readWorkflow(root);
  console.log(`Workflow: ${workflowPath(root)}`);
  console.log(`Tracker: ${workflow.trackerKind}`);
  console.log(`Max agents: ${workflow.maxConcurrentAgents}`);
  console.log(`Max turns: ${workflow.maxTurns}`);
  console.log(`Max retries: ${workflow.maxRetries}`);
  console.log(`Retry backoff: ${workflow.retryBackoffMs}ms`);
  console.log(`Codex: ${workflow.model} ${workflow.reasoningEffort} fast=${workflow.fastMode}`);
  console.log(`GitHub PR review: ${workflow.githubPrReview ? "on" : "off"}`);
}

async function goalCommand(args: string[]): Promise<void> {
  const text = args.join(" ").trim();
  if (!text) {
    throw new Error("Goal text is required.");
  }

  const store = new BoardStore(root);
  try {
    store.initProject();
    await ensureGitRepository(root);
    const planner = new GoalPlanner(root, {
      projectMemory: buildProjectMemory(store),
      onEvent: (event) => {
        if (event.message.trim()) {
          console.log(`[compiler] ${event.kind} ${event.message}`);
        }
      },
    });
    const plan = await planner.planGoal(text);
    const { goal, tasks } = store.createGoalWithTasks(text, plan.tasks, {
      completionContract: plan.completionContract,
    });
    console.log(`${goal.id} compiled.`);
    for (const task of tasks) {
      console.log(`${task.id} P${task.priority} ${TASK_STATUS_LABELS[task.status]} ${task.title}`);
    }
  } finally {
    store.close();
  }
}

async function planCommand(args: string[]): Promise<void> {
  await goalCommand(args);
}

async function buildCommand(args: string[]): Promise<void> {
  const text = args.join(" ").trim();
  if (!text) {
    throw new Error("Goal text is required.");
  }

  const store = new BoardStore(root);
  try {
    store.initProject();
    await ensureGitRepository(root);
    const planner = new GoalPlanner(root, {
      projectMemory: buildProjectMemory(store),
      onEvent: (event) => {
        if (event.message.trim()) {
          console.log(`[compiler] ${event.kind} ${event.message}`);
        }
      },
    });
    const plan = await planner.planGoal(text);
    const { goal, tasks } = store.createGoalWithTasks(text, plan.tasks, {
      completionContract: plan.completionContract,
    });
    console.log(
      `${goal.id} compiled. Running ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`,
    );
    const worker = new GoalForgeWorker(root, store, {
      onEvent: (event) => {
        const task = event.taskId ?? "system";
        console.log(`[${event.role}:${task}] ${event.kind} ${event.message}`);
      },
    });
    const completed = await worker.runQueue();
    console.log(`Processed ${completed.length} task${completed.length === 1 ? "" : "s"}.`);
    const progress = summarizeGoalProgress(store.getBoard(), goal.id);
    if (store.getGoal(goal.id).status === "closed") {
      console.log(`${goal.id} closed.`);
    } else if (progress?.completionReady) {
      const result = store.closeGoal(
        progress.goal.id,
        `${progress.done}/${progress.total} tasks done. ${progress.completionReason}`,
      );
      console.log(`${result.goal.id} closed.`);
    } else if (progress) {
      console.log(`${progress.goal.id} is not closed: ${progress.completionReason}`);
    }
  } finally {
    store.close();
  }
}

async function runCommand(args: string[]): Promise<void> {
  const runAll = args.includes("--all") || args.includes("-a");
  const limitIndex = args.findIndex((arg) => arg === "--limit");
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : Number.POSITIVE_INFINITY;
  if (limitIndex >= 0 && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error("A valid --limit value is required.");
  }
  const positional = args.filter((arg, index) =>
    !arg.startsWith("-") && args[index - 1] !== "--limit"
  );
  const taskId = positional[0];
  if (runAll && taskId) {
    throw new Error("Use either goalforge run TASK-ID or goalforge run --all, not both.");
  }

  const store = new BoardStore(root);
  store.initProject();
  await ensureGitRepository(root);
  const worker = new GoalForgeWorker(root, store, {
    onEvent: (event) => {
      const task = event.taskId ?? "system";
      console.log(`[${event.role}:${task}] ${event.kind} ${event.message}`);
    },
  });
  try {
    if (runAll || !taskId) {
      const tasks = await worker.runQueue(limit);
      console.log(`Processed ${tasks.length} task${tasks.length === 1 ? "" : "s"}.`);
      return;
    }

    const task = await worker.runTask(taskId);
    console.log(`${task.id} is now ${TASK_STATUS_LABELS[task.status]}.`);
  } finally {
    store.close();
  }
}

async function serveCommand(args: string[]): Promise<void> {
  const portArgIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  const port = portArgIndex >= 0 ? Number(args[portArgIndex + 1]) : 4733;
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("A valid --port value is required.");
  }
  const store = new BoardStore(root);
  try {
    store.initProject();
    await ensureGitRepository(root);
  } finally {
    store.close();
  }
  const server = startServer(root, port);
  console.log(`Open ${server.url}`);
  await server.finished;
}

async function openTuiCommand(args: string[]): Promise<void> {
  const portArgIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  const port = portArgIndex >= 0 ? Number(args[portArgIndex + 1]) : 4733;
  if (!Number.isInteger(port) || port < 1) {
    throw new Error("A valid --port value is required.");
  }
  const bun = resolveExecutable("bun", [homePath(".bun/bin/bun")]);
  if (!bun) {
    console.error("goalforge: Bun was not found. Falling back to native TUI.");
    await runCommandCenterTui(root, stripPortArgs(args, portArgIndex));
    return;
  }
  const store = new BoardStore(root);
  try {
    store.initProject();
    await ensureGitRepository(root);
  } finally {
    store.close();
  }
  const server = startServer(root, port);
  const forwardedArgs = stripPortArgs(args, portArgIndex);
  const status = await new Deno.Command(bun, {
    args: [
      new URL("./tui/opentui_client.ts", import.meta.url).pathname,
      "--url",
      server.url,
      ...forwardedArgs,
    ],
    cwd: root,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  server.shutdown();
  await server.finished.catch(() => {});
  if (!status.success) {
    throw new Error(`OpenTUI exited with code ${status.code}.`);
  }
}

async function tuiCommand(args: string[]): Promise<void> {
  if (args.includes("--native")) {
    await runCommandCenterTui(root, args.filter((arg) => arg !== "--native"));
    return;
  }
  await openTuiCommand(args);
}

async function hooksCommand(args: string[]): Promise<void> {
  const scriptPath = new URL("../scripts/hooks/goalforge_agent_hook.py", import.meta.url).pathname;
  const [action, target] = args.filter((arg) => !arg.startsWith("--"));
  const settingsArgIndex = args.indexOf("--settings");
  const settingsOverride = settingsArgIndex >= 0 ? args[settingsArgIndex + 1] : null;
  if (action === "print" || action === undefined) {
    console.log(`GoalForge agent status hook script:\n  ${scriptPath}`);
    console.log("\nInstall automatically:");
    console.log("  goalforge hooks install claude   # merges into ~/.claude/settings.json");
    console.log("  goalforge hooks install codex    # merges into ~/.codex/hooks.json");
    console.log("\nManual hook command (register for lifecycle events):");
    console.log(`  ${hookCommand(scriptPath, "<agent-name>")}`);
    console.log(
      "\nReports go to http://127.0.0.1:4733 (override with GOALFORGE_URL or GOALFORGE_PORT).",
    );
    console.log("Reports from directories outside the project the server runs in are ignored.");
    return;
  }
  if (action !== "install" || (target !== "claude" && target !== "codex")) {
    throw new Error("Usage: goalforge hooks [print | install claude | install codex]");
  }
  const home = Deno.env.get("HOME") ?? "";
  const settingsPath = settingsOverride ??
    (target === "claude" ? `${home}/.claude/settings.json` : `${home}/.codex/hooks.json`);
  const command = hookCommand(scriptPath, target === "claude" ? "claude-code" : "codex");
  const events = target === "claude" ? CLAUDE_HOOK_EVENTS : CODEX_HOOK_EVENTS;
  let existing: unknown = {};
  try {
    existing = JSON.parse(await Deno.readTextFile(settingsPath));
  } catch {
    // Missing or invalid file starts from an empty settings object.
  }
  const result = mergeHookSettings(existing, events, command);
  await Deno.mkdir(settingsPath.split("/").slice(0, -1).join("/"), { recursive: true });
  await Deno.writeTextFile(settingsPath, `${JSON.stringify(result.settings, null, 2)}\n`);
  if (result.added.length) {
    console.log(`Added GoalForge status hook to ${settingsPath} for: ${result.added.join(", ")}`);
  } else {
    console.log(`GoalForge status hook already present in ${settingsPath}.`);
  }
  if (target === "codex") {
    console.log("Codex CLI loads hooks when [features] hooks = true in ~/.codex/config.toml.");
  }
}

function stripPortArgs(args: string[], portArgIndex: number): string[] {
  return portArgIndex >= 0
    ? args.filter((_, index) => index !== portArgIndex && index !== portArgIndex + 1)
    : args;
}

function normalizeArgs(args: string[]): [string | undefined, ...string[]] {
  const first = args[0];
  if (first === undefined) {
    return ["tui"];
  }
  if (first.startsWith("-") && first !== "-h" && first !== "--help") {
    return ["tui", ...args];
  }
  return [first, ...args.slice(1)];
}

function resolveExecutable(name: string, fallbacks: string[]): string | null {
  for (const directory of (Deno.env.get("PATH") ?? "").split(":")) {
    if (!directory) {
      continue;
    }
    const candidate = `${directory}/${name}`;
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  for (const fallback of fallbacks) {
    if (isExecutable(fallback)) {
      return fallback;
    }
  }
  return null;
}

function homePath(relativePath: string): string {
  const home = Deno.env.get("HOME");
  return home ? `${home}/${relativePath}` : relativePath;
}

function isExecutable(target: string): boolean {
  try {
    const stat = Deno.statSync(target);
    return stat.isFile;
  } catch {
    return false;
  }
}

async function mergeCommand(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    throw new Error("Task id is required.");
  }

  const store = new BoardStore(root);
  try {
    const task = store.getTask(taskId);
    if (!task.branchName) {
      throw new Error(`${task.id} does not have an assigned branch.`);
    }
    if (task.status !== "review" && task.status !== "merging" && task.status !== "done") {
      throw new Error(`${task.id} must be in Review, Merging, or Done before merge.`);
    }
    if (task.status === "review") {
      store.requestTransition(task.id, "merging", "merger", "Manual merge started.");
    }
    const output = await gitMergeBranch(root, task.branchName);
    const event = store.appendEvent(
      task.id,
      null,
      "merger",
      "merge",
      output.trim() || `Merged ${task.branchName}.`,
    );
    console.log(event.message);
    if (task.status === "review" || task.status === "merging") {
      store.requestTransition(task.id, "done", "merger", `Merged ${task.branchName}.`);
    }
    console.log(`${task.id} is now Done.`);
  } finally {
    store.close();
  }
}

async function reviewCommand(args: string[]): Promise<void> {
  const taskId = args[0];
  if (!taskId) {
    throw new Error("Task id is required.");
  }

  const store = new BoardStore(root);
  try {
    const task = store.getTask(taskId);
    if (task.status !== "review") {
      throw new Error(`${task.id} must be in Review before review.`);
    }
    const reviewer = new GoalReviewer(root, {
      onEvent: (event) => {
        if (event.message.trim()) {
          console.log(`[reviewer] ${event.kind} ${event.message}`);
        }
      },
    });
    const result = await reviewer.review(task);
    const reviewText = [
      task.validation,
      "",
      `GoalForge review: ${result.verdict.toUpperCase()}`,
      result.notes,
    ].filter(Boolean).join("\n");
    store.updateTaskValidation(task.id, reviewText);
    store.appendEvent(
      task.id,
      null,
      "reviewer",
      "review",
      result.verdict === "approved"
        ? "Review approved. Preparing merge."
        : "Review requested changes. Waiting for user direction.",
    );
    if (result.verdict !== "approved") {
      store.requestTransition(
        task.id,
        "blocked",
        "reviewer",
        "Review requested changes. Add a message to continue this task.",
      );
      console.log(`${task.id} review requested changes. Moved to Inbox.`);
      return;
    }
    if (!task.branchName) {
      store.requestTransition(
        task.id,
        "blocked",
        "merger",
        "GoalForge cannot merge because this task has no assigned branch.",
      );
      console.log(`${task.id} has no branch to merge. Moved to Inbox.`);
      return;
    }
    store.requestTransition(
      task.id,
      "merging",
      "merger",
      "Review approved. Merging branch.",
    );
    const output = await gitMergeBranch(root, task.branchName);
    store.appendEvent(
      task.id,
      null,
      "merger",
      "merge",
      output.trim() || `Merged ${task.branchName}.`,
    );
    store.requestTransition(
      task.id,
      "done",
      "merger",
      `Review approved and merged ${task.branchName}.`,
    );
    console.log(`${task.id} review ${result.verdict}.`);
  } finally {
    store.close();
  }
}

function deleteCommand(args: string[]): void {
  const taskId = args[0];
  if (!taskId) {
    throw new Error("Task id is required.");
  }

  usingStore((store) => {
    const event = store.deleteTask(taskId);
    console.log(event.message);
  });
}

function messageCommand(args: string[]): void {
  const taskId = args[0];
  const message = args.slice(1).join(" ").trim();
  if (!taskId || !message) {
    throw new Error('Usage: goalforge message TASK-ID "message"');
  }

  usingStore((store) => {
    const event = store.enqueueMessage(taskId, "user", message);
    console.log(event.message);
  });
}

async function mainCommand(args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  const store = new BoardStore(root);
  try {
    store.initProject();
    ensureProjectKnowledgeFiles(root);
    if (action === "status") {
      const state = store.getProjectState();
      console.log(`Main thread: ${state.mainThreadId ?? "none"}`);
      console.log(`Created: ${state.mainThreadCreatedAt ?? "none"}`);
      console.log(`Reset: ${state.mainThreadResetAt ?? "none"}`);
      console.log(state.mainThreadSummary || "No main-thread summary recorded.");
      console.log("");
      for (const line of formatHealthLines(store.getBoard())) {
        console.log(line);
      }
      return;
    }
    if (action === "ensure") {
      const worker = new GoalForgeWorker(root, store);
      const threadId = await worker.ensureMainThread();
      const state = store.getProjectState();
      console.log(`Main thread: ${threadId ?? state.mainThreadId ?? "none"}`);
      console.log(state.mainThreadSummary || "No main-thread summary recorded.");
      return;
    }
    if (action === "reset") {
      const threadId = args[1] ?? `manual-main-${crypto.randomUUID()}`;
      const state = store.resetMainThread(
        threadId,
        "Project main thread reset. Seed future child tasks from project docs and board memory.",
      );
      console.log(`Main thread reset to ${state.mainThreadId}.`);
      return;
    }
    if (action === "absorb") {
      const taskId = args[1];
      if (!taskId) {
        throw new Error("Usage: goalforge main absorb TASK-ID");
      }
      const task = store.getTask(taskId);
      const summary = [
        store.getProjectState().mainThreadSummary,
        `${task.id} absorbed manually: ${task.title}`,
      ].filter(Boolean).join("\n");
      store.updateMainThreadSummary(summary);
      console.log(`${task.id} absorbed into main-thread summary.`);
      return;
    }
    throw new Error(`Unknown main command: ${action}`);
  } finally {
    store.close();
  }
}

function taskCommand(args: string[]): void {
  const taskId = args[0];
  const action = args[1] ?? "card";
  if (!taskId) {
    throw new Error("Usage: goalforge task TASK-ID [card|threads]");
  }
  usingStore((store) => {
    const task = store.getTask(taskId);
    if (action === "card") {
      console.log(task.taskCard || buildTaskCard(task));
      return;
    }
    if (action === "threads") {
      console.log(`Parent: ${task.parentThreadId ?? "none"}`);
      console.log(`Child: ${task.threadId ?? "none"}`);
      console.log(`Active turn: ${task.activeTurnId ?? "none"}`);
      console.log(`Manifest: ${task.contextManifestPath ?? "none"}`);
      return;
    }
    throw new Error(`Unknown task command: ${action}`);
  });
}

async function steerCommand(args: string[]): Promise<void> {
  const taskId = args[0];
  const message = args.slice(1).join(" ").trim();
  if (!taskId || !message) {
    throw new Error('Usage: goalforge steer TASK-ID "message"');
  }
  const store = new BoardStore(root);
  try {
    const worker = new GoalForgeWorker(root, store);
    const event = await worker.steerTask(taskId, message);
    console.log(event.message);
  } finally {
    store.close();
  }
}

function compactCommand(args: string[]): void {
  const taskId = args[0];
  if (!taskId) {
    throw new Error("Usage: goalforge compact TASK-ID");
  }
  usingStore((store) => {
    const task = store.getTask(taskId);
    const updated = store.updateTaskCard(task.id, buildTaskCard(task));
    console.log(updated.taskCard);
  });
}

function closeGoalCommand(args: string[]): void {
  const goalId = args[0];
  usingStore((store) => {
    const board = store.getBoard();
    const progress = goalId ? summarizeGoalProgress(board, goalId) : summarizeGoalProgress(board);
    if (!progress) {
      throw new Error(goalId ? `Goal not found: ${goalId}` : "No open goal is ready to close.");
    }
    const result = store.closeGoal(
      progress.goal.id,
      `${progress.done}/${progress.total} tasks done. ${progress.completionReason}`,
    );
    console.log(`${result.goal.id} closed.`);
    console.log(result.goal.closureSummary);
  });
}

function statusCommand(): void {
  usingStore((store) => {
    for (const line of formatStatusLines(store.getBoard())) {
      console.log(line);
    }
  });
}

function healthCommand(): void {
  usingStore((store) => {
    for (const line of formatHealthLines(store.getBoard())) {
      console.log(line);
    }
  });
}

async function dogfoodCommand(args: string[]): Promise<void> {
  if (args.includes("--live")) {
    await liveDogfoodCommand(args);
    return;
  }
  const python = resolveExecutable("python3", []);
  if (!python) {
    throw new Error("python3 is required to run the GoalForge dogfood gate.");
  }
  const script = new URL("../scripts/smoke_opentui_tui.py", import.meta.url).pathname;
  const goalforgeBin = new URL("../goalforge", import.meta.url).pathname;
  const repo = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
  console.log("Running GoalForge dogfood readiness gate...");
  const status = await new Deno.Command(python, {
    args: [script, "--dogfood-only"],
    cwd: repo,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      GOALFORGE_REPO: repo,
      GOALFORGE_BIN: goalforgeBin,
    },
  }).spawn().status;
  if (!status.success) {
    throw new Error(`GoalForge dogfood gate failed with code ${status.code}.`);
  }
  console.log("GoalForge dogfood readiness gate passed.");
}

async function liveDogfoodCommand(args: string[]): Promise<void> {
  const forwarded = args.filter((arg) => arg !== "--live");
  const script = new URL("../scripts/live_dogfood.ts", import.meta.url).pathname;
  console.log("Running GoalForge live dogfood readiness gate...");
  const status = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-net",
      "--allow-env",
      script,
      ...forwarded,
    ],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (!status.success) {
    throw new Error(`GoalForge live dogfood gate failed with code ${status.code}.`);
  }
  console.log("GoalForge live dogfood readiness gate passed.");
}

function doctorCommand(): void {
  const checks = [
    {
      label: "Deno runtime",
      path: Deno.execPath(),
      ok: true,
      note: "running this CLI",
    },
    {
      label: "Git",
      path: resolveExecutable("git", []),
      okNote: "worktrees, commits, and merges enabled",
      missingNote: "install git before running task worktrees",
    },
    {
      label: "Bun",
      path: resolveExecutable("bun", [homePath(".bun/bin/bun")]),
      okNote: "OpenTUI command center enabled",
      missingNote: "native fallback TUI will be used",
    },
    {
      label: "uv",
      path: resolveExecutable("uv", [homePath(".local/bin/uv"), homePath(".cargo/bin/uv")]),
      okNote: "Codex Python bridge can launch",
      missingNote: "install uv for Codex SDK-backed workers",
    },
    {
      label: "Python 3",
      path: resolveExecutable("python3", []),
      okNote: "smoke tests and bridge scripts can run",
      missingNote: "install python3 for smoke tests and bridge scripts",
    },
  ];
  const missingRequired = checks.filter((check) => check.label === "Git" && !check.path);
  for (const check of checks) {
    const ok = check.ok ?? Boolean(check.path);
    const status = ok ? "ok" : check.label === "Bun" ? "fallback" : "missing";
    const detail = ok
      ? `${check.path ?? "available"} - ${check.note ?? check.okNote}`
      : check.missingNote;
    console.log(`${status}: ${check.label}: ${detail}`);
  }
  if (missingRequired.length) {
    console.log("Doctor: action needed before running task agents.");
    return;
  }
  console.log("Doctor: GoalForge can start. Check `goalforge health` for project state.");
}

function goalsCommand(): void {
  usingStore((store) => {
    for (const line of formatGoalLines(store.getBoard())) {
      console.log(line);
    }
  });
}

function usingStore<T>(fn: (store: BoardStore) => T): T {
  const store = new BoardStore(root);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function printHelp(): void {
  console.log(`GoalForge

Usage:
  goalforge
  goalforge init
  goalforge goal "<goal text>"
  goalforge build "<goal text>"
  goalforge run [TASK-ID]
  goalforge run --all [--limit N]
  goalforge review TASK-ID
  goalforge delete TASK-ID
  goalforge message TASK-ID "<message>"
  goalforge serve [--port 4733]
  goalforge tui [--native]
  goalforge opentui [--port 4733]
  goalforge board [--port 4733]
  goalforge merge TASK-ID
  goalforge main status|ensure|reset|absorb
  goalforge task TASK-ID [card|threads]
  goalforge steer TASK-ID "<message>"
  goalforge compact TASK-ID
  goalforge close-goal [GOAL-ID]
  goalforge goals
  goalforge health
  goalforge dogfood [--live] [--keep]
  goalforge doctor
  goalforge status
  goalforge hooks [print | install claude | install codex]

Running goalforge with no command opens the TUI.
`);
}
