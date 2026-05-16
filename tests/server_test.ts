import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  CodexClient,
  CodexSession,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";
import { startServer } from "../src/web/server.ts";
import { BoardStore } from "../src/board/store.ts";

Deno.test("server exposes board, creates goals, and runs Codex worker", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const port = 48733 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const html = await fetch(`${server.url}/`).then((response) => response.text());
    assertStringIncludes(html, "GoalForge");

    const configResponse = await fetch(`${server.url}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.4", reasoningEffort: "medium", fastMode: false }),
    });
    assertEquals(configResponse.ok, true);
    const config = await configResponse.json();
    assertEquals(config.model, "gpt-5.4");
    assertEquals(config.reasoningEffort, "medium");
    assertEquals(config.fastMode, false);

    const create = await fetch(`${server.url}/api/goals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Run through the GUI path" }),
    }).then((response) => response.json());
    assertEquals(create.tasks.length, 1);
    assertEquals(create.tasks[0].id, "TASK-1");

    const runResponse = await fetch(`${server.url}/api/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assertEquals(runResponse.ok, true);
    await runResponse.json();

    const board = await waitForDone(server.url);
    assertEquals(board.tasks[0].status, "done");
    assertStringIncludes(board.tasks[0].validation, "Codex App Server turn completed");
    assertStringIncludes(board.tasks[0].validation, "Commit:");
    assertStringIncludes(board.tasks[0].validation, "Test turn:");
    assertStringIncludes(board.tasks[0].validation, "GoalForge review: APPROVED");
    assertEquals(await Deno.readTextFile(`${root}/server-test.txt`), "server worker output\n");

    const planned = await fetch(`${server.url}/api/goals/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Plan through the GUI path" }),
    }).then((response) => response.json());
    assertEquals(planned.tasks.length, 1);

    const deleteResponse = await fetch(`${server.url}/api/tasks/${planned.tasks[0].id}`, {
      method: "DELETE",
    });
    assertEquals(deleteResponse.ok, true);
    await deleteResponse.json();
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server deletes a started task with a stale running run", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Delete stuck started task");
    store.assignWorktree(task.id, "goalforge/task-1", `${root}/.goalforge/worktrees/TASK-1`);
    store.requestTransition(task.id, "in_progress", "test", "claim");
    store.createRun(task.id, "worker");
  } finally {
    store.close();
  }

  const port = 49033 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const deleteResponse = await fetch(`${server.url}/api/tasks/TASK-1`, {
      method: "DELETE",
    });
    assertEquals(deleteResponse.ok, true);
    await deleteResponse.json();
    const board = await fetch(`${server.url}/api/board`).then((response) => response.json());
    assertEquals(board.tasks.length, 0);
    assertEquals(board.runs.length, 0);
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

interface BoardResponse {
  tasks: Array<{ status: string; validation: string }>;
  events: Array<{ message: string }>;
}

class TestCodexClient implements CodexClient {
  constructor(
    private readonly onEvent: (
      event: {
        taskId: string | null;
        runId: string | null;
        role: string;
        kind: string;
        message: string;
      },
    ) => void,
  ) {}

  startSession(cwd: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: "thread-server-test", cwd });
  }

  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  async runTurn(session: CodexSession, _input: CodexTurnInput): Promise<CodexTurnResult> {
    if (_input.title === "GoalForge goal compiler") {
      assertStringIncludes(_input.prompt, "Current GoalForge board memory");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: JSON.stringify({
          title: "Implement compiled goal",
          prompt: "Inspect the project, implement the requested goal, and validate the result.",
          acceptanceCriteria: "- Implementation is validated.",
          priority: 200,
          workpad: "Compiled prompt task.",
        }),
      });
      return {
        threadId: session.threadId,
        turnId: "turn-planner-test",
        status: "completed",
        completed: true,
      };
    }

    if (_input.title.endsWith(": review")) {
      assertStringIncludes(_input.prompt, "Current GoalForge board memory");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "APPROVED\n- Validation covers the task.",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-review-test",
        status: "completed",
        completed: true,
      };
    }

    if (_input.title === "GoalForge scheduler") {
      assertStringIncludes(_input.prompt, "Current GoalForge board memory");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: JSON.stringify({
          taskIds: ["TASK-3"],
          notes: "Run the next independent planned task.",
        }),
      });
      return {
        threadId: session.threadId,
        turnId: "turn-scheduler-test",
        status: "completed",
        completed: true,
      };
    }

    if (_input.title.endsWith(": test-engineer")) {
      assertStringIncludes(_input.prompt, "Current GoalForge board memory");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "test engineer validation output",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-test-engineer",
        status: "completed",
        completed: true,
      };
    }

    assertStringIncludes(_input.prompt, "Current GoalForge board memory");
    await Deno.writeTextFile(`${session.cwd}/server-test.txt`, "server worker output\n");
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "output",
      message: "server worker output",
    });
    return {
      threadId: session.threadId,
      turnId: "turn-server-test",
      status: "completed",
      completed: true,
    };
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

async function git(root: string, args: string[]): Promise<void> {
  const output = await new Deno.Command("git", {
    args: [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      ...args,
    ],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
}

async function waitForDone(url: string): Promise<BoardResponse> {
  for (let index = 0; index < 80; index++) {
    const board = await fetch(`${url}/api/board`).then((response) => response.json());
    if (board.tasks[0]?.status === "done") {
      return board;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Task did not reach Done.");
}
