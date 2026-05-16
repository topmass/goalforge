import { BoardStore } from "./board/store.ts";
import { TASK_STATUS_LABELS } from "./board/types.ts";
import { normalizeRoot, workflowPath } from "./paths.ts";
import { startServer } from "./web/server.ts";
import { ensureGitRepository, gitMergeBranch } from "./workers/git_utils.ts";
import { GoalPlanner } from "./workers/goal_planner.ts";
import { GoalReviewer } from "./workers/goal_reviewer.ts";
import { GoalForgeWorker } from "./workers/goalforge_worker.ts";
import { buildProjectMemory } from "./workers/project_memory.ts";
import { readWorkflow } from "./workflow/workflow.ts";

const root = normalizeRoot(Deno.cwd());
const [command, ...args] = Deno.args;

try {
  switch (command) {
    case "init":
      await initCommand();
      break;
    case "goal":
      await goalCommand(args);
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
    case "status":
      statusCommand();
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
    const drafts = await planner.plan(text);
    const { goal, tasks } = store.createGoalWithTasks(text, drafts);
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

function statusCommand(): void {
  usingStore((store) => {
    const board = store.getBoard();
    for (const status of board.statuses) {
      const count = board.tasks.filter((task) => task.status === status.id).length;
      console.log(`${status.label}: ${count}`);
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
  goalforge init
  goalforge goal "<goal text>"
  goalforge run [TASK-ID]
  goalforge run --all [--limit N]
  goalforge review TASK-ID
  goalforge delete TASK-ID
  goalforge message TASK-ID "<message>"
  goalforge serve [--port 4733]
  goalforge board [--port 4733]
  goalforge merge TASK-ID
  goalforge status
`);
}
