import { BoardStore } from "./board/store.ts";
import { TASK_STATUS_LABELS } from "./board/types.ts";
import { normalizeRoot } from "./paths.ts";
import { startServer } from "./web/server.ts";
import { gitMergeBranch } from "./workers/git_utils.ts";
import { GoalForgeWorker } from "./workers/goalforge_worker.ts";

const root = normalizeRoot(Deno.cwd());
const [command, ...args] = Deno.args;

try {
  switch (command) {
    case "init":
      initCommand();
      break;
    case "goal":
      goalCommand(args);
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
    case "merge":
      await mergeCommand(args);
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

function initCommand(): void {
  usingStore((store) => {
    store.initProject();
    console.log(`GoalForge initialized at ${root}/.goalforge`);
  });
}

function goalCommand(args: string[]): void {
  const text = args.join(" ").trim();
  usingStore((store) => {
    store.initProject();
    const { goal, task } = store.createGoal(text);
    console.log(`${goal.id} created.`);
    console.log(`${task.id} ${TASK_STATUS_LABELS[task.status]} ${task.title}`);
  });
}

async function runCommand(args: string[]): Promise<void> {
  const taskId = args[0];
  const store = new BoardStore(root);
  store.initProject();
  const worker = new GoalForgeWorker(root, store, {
    onEvent: (event) => {
      const task = event.taskId ?? "system";
      console.log(`[${event.role}:${task}] ${event.kind} ${event.message}`);
    },
  });
  try {
    const task = taskId ? await worker.runTask(taskId) : await worker.runNext();
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
    if (task.status !== "review" && task.status !== "done") {
      throw new Error(`${task.id} must be in Review or Done before merge.`);
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
    if (task.status === "review") {
      store.requestTransition(task.id, "done", "merger", `Merged ${task.branchName}.`);
    }
    console.log(`${task.id} is now Done.`);
  } finally {
    store.close();
  }
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
  goalforge serve [--port 4733]
  goalforge board [--port 4733]
  goalforge merge TASK-ID
  goalforge status
`);
}
