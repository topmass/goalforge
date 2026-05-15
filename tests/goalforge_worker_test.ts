import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import {
  CodexClient,
  CodexSession,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";
import { GoalForgeWorker } from "../src/workers/goalforge_worker.ts";

Deno.test("worker assigns worktree, streams Codex events, and moves task to review", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await Deno.writeTextFile(`${root}/seed.txt`, "seed\n");
  await git(root, ["add", "seed.txt"]);
  await git(root, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    "seed",
  ]);

  const store = new BoardStore(root);
  const streamed: string[] = [];
  try {
    store.initProject();
    const { task } = store.createGoal("Exercise the Codex worker");
    const worker = new GoalForgeWorker(root, store, {
      onEvent: (event) => streamed.push(`${event.kind}:${event.message}`),
      createCodexClient: (onEvent) => new TestCodexClient(onEvent),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "review");
    assert(updated.branchName?.startsWith("goalforge/task-1"));
    assert(updated.worktreePath?.includes(".goalforge/worktrees/TASK-1"));
    assertStringIncludes(updated.validation, "Codex App Server turn completed");
    assertStringIncludes(updated.validation, "Commit:");
    assertStringIncludes(updated.validation, "Test turn:");
    assert(streamed.some((line) => line.includes("test Codex implementation output")));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker queue processes dispatchable tasks one at a time", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  try {
    store.initProject();
    store.createGoal("First queued task");
    store.createGoal("Second queued task");
    const worker = new GoalForgeWorker(root, store, {
      createCodexClient: (onEvent) => new TestCodexClient(onEvent),
    });
    const completed = await worker.runQueue();
    assertEquals(completed.length, 2);
    assertEquals(store.getTask("TASK-1").status, "review");
    assertEquals(store.getTask("TASK-2").status, "review");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

async function seedGitRepo(root: string): Promise<void> {
  await git(root, ["init", "-b", "main"]);
  await Deno.writeTextFile(`${root}/seed.txt`, "seed\n");
  await git(root, ["add", "seed.txt"]);
  await git(root, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test",
    "commit",
    "-m",
    "seed",
  ]);
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
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "thread",
      message: "test Codex thread started",
    });
    return Promise.resolve({ threadId: "thread-test", cwd });
  }

  async runTurn(session: CodexSession, _input: CodexTurnInput): Promise<CodexTurnResult> {
    if (_input.title === "GoalForge scheduler") {
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: JSON.stringify({
          taskIds: ["TASK-1", "TASK-2"],
          notes: "Both tasks are independent in this test.",
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
      assertStringIncludes(_input.prompt, "Project AGENTS.md context");
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

    await Deno.writeTextFile(
      `${session.cwd}/codex-output.txt`,
      "test Codex implementation output\n",
    );
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "output",
      message: "test Codex implementation output",
    });
    return {
      threadId: session.threadId,
      turnId: "turn-test",
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
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
}
