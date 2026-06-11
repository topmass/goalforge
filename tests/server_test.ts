import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CodexClient,
  CodexSession,
  CodexThreadReadResult,
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
      body: JSON.stringify({
        model: "gpt-5.4",
        reasoningEffort: "medium",
        fastMode: false,
        githubPrReview: true,
      }),
    });
    assertEquals(configResponse.ok, true);
    const config = await configResponse.json();
    assertEquals(config.model, "gpt-5.4");
    assertEquals(config.reasoningEffort, "medium");
    assertEquals(config.fastMode, false);
    assertEquals(config.githubPrReview, true);

    const runtime = await fetch(`${server.url}/api/runtime`).then((response) => response.json());
    assertEquals(runtime.queueRunning, false);
    assertEquals(runtime.workflow.trackerKind, "goalforge-local");
    assertEquals(runtime.runningRuns.length, 0);

    await fetch(`${server.url}/api/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ githubPrReview: false }),
    });

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
    assert(board.agentStatuses.some((status) => status.phase === "done"));

    const threadRead = await fetch(`${server.url}/api/tasks/TASK-1/thread`).then((response) =>
      response.json()
    );
    assertEquals(threadRead.thread.threadId, "thread-server-test");
    assertEquals(threadRead.thread.turnCount, 1);

    const compactTask = await fetch(`${server.url}/api/tasks/TASK-1/compact-thread`, {
      method: "POST",
    });
    assertEquals(compactTask.ok, true);

    const compactMain = await fetch(`${server.url}/api/main/compact`, {
      method: "POST",
    });
    assertEquals(compactMain.ok, true);

    const planned = await fetch(`${server.url}/api/goals/plan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Plan through the GUI path" }),
    }).then((response) => response.json());
    assertEquals(planned.tasks.length, 1);
    assertStringIncludes(planned.goal.completionContract, "Complete every planned task.");

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

Deno.test("server requests a running task stop", async () => {
  const root = Deno.makeTempDirSync();
  const port = 49133 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const store = new BoardStore(root);
    try {
      const { task } = store.createGoal("Stop from the TUI");
      store.createRun(task.id, "worker");
    } finally {
      store.close();
    }

    const stopResponse = await fetch(`${server.url}/api/tasks/TASK-1/stop`, {
      method: "POST",
    });
    assertEquals(stopResponse.ok, true);
    await stopResponse.json();
    const board = await fetch(`${server.url}/api/board`).then((response) => response.json());
    assertEquals(Boolean(board.runs[0].stopRequestedAt), true);
    assertStringIncludes(board.tasks[0].nextAction, "stopping");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server clears completed tasks from the board", async () => {
  const root = Deno.makeTempDirSync();
  const port = 49203 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const store = new BoardStore(root);
    try {
      const { tasks } = store.createGoalWithTasks("Clear finished cards", [
        {
          title: "Done card",
          description: "Finish this card.",
          acceptanceCriteria: "Done.",
          priority: 100,
        },
        {
          title: "Ready card",
          description: "Keep this card.",
          acceptanceCriteria: "Still ready.",
          priority: 90,
        },
      ]);
      store.updateTaskValidation(tasks[0].id, "Validated.");
      store.requestTransition(tasks[0].id, "in_progress", "test", "started");
      store.requestTransition(tasks[0].id, "review", "test", "ready");
      store.requestTransition(tasks[0].id, "done", "test", "complete");
    } finally {
      store.close();
    }

    const response = await fetch(`${server.url}/api/tasks/done`, { method: "DELETE" });
    assertEquals(response.ok, true);
    const cleared = await response.json();
    assertEquals(cleared.count, 1);
    const board = await fetch(`${server.url}/api/board`).then((item) => item.json());
    assertEquals(board.tasks.length, 1);
    assertEquals(board.tasks[0].title, "Ready card");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server creates a manual task without Codex planning", async () => {
  const root = Deno.makeTempDirSync();
  const port = 49233 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const response = await fetch(`${server.url}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Click-created task",
        description: "Created from the command center.",
        acceptanceCriteria: "Visible on the board.",
      }),
    });
    assertEquals(response.ok, true);
    const created = await response.json();
    assertEquals(created.tasks.length, 1);
    assertEquals(created.tasks[0].title, "Click-created task");
    assertEquals(created.tasks[0].acceptanceCriteria, "Visible on the board.");

    const board = await fetch(`${server.url}/api/board`).then((item) => item.json());
    assertEquals(board.tasks.length, 1);
    assertEquals(board.tasks[0].title, "Click-created task");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server builds a goal by planning tasks and starting the queue", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, ["commit", "--allow-empty", "-m", "seed"]);
  const port = 49333 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  try {
    const response = await fetch(`${server.url}/api/goals/build`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Build the requested feature completely" }),
    });
    assertEquals(response.ok, true);
    const created = await response.json();
    assertEquals(created.tasks.length, 1);
    assertEquals(created.running, true);
    assertEquals(created.tasks[0].id, "TASK-1");

    const board = await waitForClosedGoal(server.url);
    assertEquals(board.tasks[0].status, "done");
    assertEquals(board.goals[0].status, "closed");
    assertStringIncludes(board.goals[0].closureSummary, "1/1 tasks done.");
    assertStringIncludes(board.tasks[0].validation, "Codex App Server turn completed");
    assertEquals(await Deno.readTextFile(`${root}/server-test.txt`), "server worker output\n");
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server ensures and reuses the persistent main Codex thread", async () => {
  const root = Deno.makeTempDirSync();
  let starts = 0;
  const port = 49533 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent, () => starts++),
  });
  try {
    const first = await fetch(`${server.url}/api/main/ensure`, { method: "POST" }).then((item) =>
      item.json()
    );
    assertEquals(first.mainThreadId, "thread-server-test");
    assertEquals(starts, 1);

    const second = await fetch(`${server.url}/api/main/ensure`, { method: "POST" }).then((item) =>
      item.json()
    );
    assertEquals(second.mainThreadId, "thread-server-test");
    assertEquals(starts, 1);
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
  }

  const reopened = startServer(root, port + 1000, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent, () => starts++),
  });
  try {
    const state = await fetch(`${reopened.url}/api/main/ensure`, { method: "POST" }).then((item) =>
      item.json()
    );
    assertEquals(state.mainThreadId, "thread-server-test");
    assertEquals(starts, 1);
  } finally {
    reopened.shutdown();
    await reopened.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server updates planner routing and max concurrent agents", async () => {
  const root = Deno.makeTempDirSync();
  const port = 50133 + Math.floor(Math.random() * 300);
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
  });
  const patchJson = (path: string, body: unknown) =>
    fetch(`${server.url}${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const planner = await patchJson("/api/planner", { enabled: true, backend: "claude" })
      .then((response) => response.json());
    assertEquals(planner, { enabled: true, backend: "claude" });

    const agents = await patchJson("/api/workflow/agents", { maxConcurrentAgents: 4 })
      .then((response) => response.json());
    assertEquals(agents.maxConcurrentAgents, 4);
    assertStringIncludes(
      await Deno.readTextFile(`${root}/WORKFLOW.md`),
      "max_concurrent_agents: 4",
    );

    const runtime = await fetch(`${server.url}/api/runtime`).then((response) => response.json());
    assertEquals(runtime.planner, { enabled: true, backend: "claude" });
    assertEquals(runtime.workflow.maxConcurrentAgents, 4);

    const rejected = await patchJson("/api/workflow/agents", { maxConcurrentAgents: 0 });
    assertEquals(rejected.status, 400);
    await rejected.json();
  } finally {
    await patchJson("/api/planner", { enabled: false }).then((response) => response.json());
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server runs the scout and gatekeeps ideas through approve and reject", async () => {
  const root = Deno.makeTempDirSync();
  const port = 50533 + Math.floor(Math.random() * 300);
  const scoutJson = JSON.stringify({
    ideas: [
      {
        title: "Add a changelog page",
        pitch: "**What:** changelog. **Why it's cool:** visibility. **Why now:** momentum.",
        sources: [],
        buildsOn: "",
      },
      {
        title: "Add release tagging",
        pitch: "**What:** tags. **Why it's cool:** traceability. **Why now:** pairs.",
        sources: [],
        buildsOn: "Add a changelog page",
      },
    ],
    order: ["Add a changelog page", "Add release tagging"],
  });
  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new TestCodexClient(onEvent),
    createScoutClient: (onEvent) => new ScoutStubClient(onEvent, scoutJson),
  });
  try {
    const scoutPatch = await fetch(`${server.url}/api/scout`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, backend: "codex" }),
    }).then((response) => response.json());
    assertEquals(scoutPatch, { enabled: true, backend: "codex" });

    const report = await fetch(`${server.url}/api/scout/run`, { method: "POST" })
      .then((response) => response.json());
    assertEquals(report.ran, true);
    assertEquals(report.added.length, 2);

    const ideas = await fetch(`${server.url}/api/ideas`).then((response) => response.json());
    assertEquals(ideas.length, 2);
    assertEquals(ideas[0].title, "Add a changelog page");

    const rejected = await fetch(`${server.url}/api/ideas/${ideas[1].id}/reject`, {
      method: "POST",
    }).then((response) => response.json());
    assertEquals(rejected.status, "rejected");

    const approved = await fetch(`${server.url}/api/ideas/${ideas[0].id}/approve`, {
      method: "POST",
    }).then((response) => response.json());
    assertEquals(approved.idea.status, "approved");
    assert(approved.goal.id.startsWith("GOAL-"));
    assert(approved.tasks.length >= 1);

    const board = await fetch(`${server.url}/api/board`).then((response) => response.json());
    assertEquals(board.ideas.length, 0);
    assert(board.goals.some((goal: { text: string }) => goal.text.includes("changelog")));
  } finally {
    await fetch(`${server.url}/api/scout`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    }).then((response) => response.json());
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});

class ScoutStubClient implements CodexClient {
  constructor(
    private readonly onEvent: (event: {
      taskId: string | null;
      runId: string | null;
      role: string;
      kind: string;
      message: string;
    }) => void,
    private readonly response: string,
  ) {}

  startSession(cwd: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: "thread-scout-stub", cwd });
  }

  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  readThread(session: CodexSession): Promise<CodexThreadReadResult> {
    return Promise.resolve({
      threadId: session.threadId,
      name: "scout",
      status: "idle",
      turnCount: 0,
      raw: {},
    });
  }

  compactThread(_session: CodexSession): Promise<void> {
    return Promise.resolve();
  }

  runTurn(session: CodexSession, _input: CodexTurnInput): Promise<CodexTurnResult> {
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "agent",
      message: this.response,
    });
    return Promise.resolve({
      threadId: session.threadId,
      turnId: "turn-scout-stub",
      status: "completed",
      completed: true,
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

interface BoardResponse {
  goals: Array<{ id: string; status: string; closureSummary: string; completionContract: string }>;
  tasks: Array<{ status: string; validation: string }>;
  events: Array<{ message: string }>;
  agentStatuses: Array<{ phase: string }>;
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
    private readonly onStartSession: () => void = () => {},
  ) {}

  startSession(cwd: string): Promise<CodexSession> {
    this.onStartSession();
    return Promise.resolve({ threadId: "thread-server-test", cwd });
  }

  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  readThread(session: CodexSession, includeTurns = false): Promise<CodexThreadReadResult> {
    return Promise.resolve({
      threadId: session.threadId,
      name: "GoalForge test thread",
      status: "idle",
      turnCount: includeTurns ? 1 : 0,
      raw: { id: session.threadId, name: "GoalForge test thread" },
    });
  }

  compactThread(_session: CodexSession): Promise<void> {
    return Promise.resolve();
  }

  async runTurn(session: CodexSession, _input: CodexTurnInput): Promise<CodexTurnResult> {
    if (_input.title === "GoalForge main thread seed") {
      assertStringIncludes(_input.prompt, "persistent GoalForge main thread");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "main thread seed acknowledged",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-main-seed",
        status: "completed",
        completed: true,
      };
    }

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

    if (_input.title.endsWith(": absorb")) {
      assertStringIncludes(_input.prompt, "Absorb this completed GoalForge task");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "absorbed task memory",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-absorb-test",
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
        message: "VERIFICATION_PASSED\n- Test engineer validation output.",
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

async function waitForClosedGoal(url: string): Promise<BoardResponse> {
  for (let index = 0; index < 80; index++) {
    const board = await fetch(`${url}/api/board`).then((response) => response.json());
    if (board.tasks[0]?.status === "done" && board.goals[0]?.status === "closed") {
      return board;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Goal did not close after Build Goal completed.");
}
