import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore, updateConfig } from "../src/board/store.ts";
import type { Task } from "../src/board/types.ts";
import {
  CodexClient,
  CodexSession,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";
import { PullRequestGate, PullRequestInfo } from "../src/workers/github_pr.ts";
import { GoalForgeWorker } from "../src/workers/goalforge_worker.ts";

Deno.test("worker assigns worktree, streams Codex events, reviews, and merges", async () => {
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
    await Deno.writeTextFile(
      `${root}/WORKFLOW.md`,
      `---
version: 1
tracker:
  kind: goalforge-local
agent:
  max_concurrent_agents: 2
  max_turns: 1
  max_retries: 1
  retry_backoff_ms: 1000
codex:
  model: gpt-5.5
  reasoning_effort: high
  fast_mode: true
workspace:
  worktrees_dir: .goalforge/custom-worktrees
  hooks:
    before_run:
      - printf before > workflow-before.txt
    after_run:
      - printf after > workflow-after.txt
---
# Custom Workflow

Custom workflow instruction.
`,
    );
    const { task } = store.createGoal("Exercise the Codex worker");
    const worker = new GoalForgeWorker(root, store, {
      onEvent: (event) => streamed.push(`${event.kind}:${event.message}`),
      createCodexClient: (onEvent) => new TestCodexClient(onEvent),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assert(updated.branchName?.startsWith("goalforge/task-1"));
    assert(updated.worktreePath?.includes(".goalforge/custom-worktrees/TASK-1"));
    assertEquals(updated.threadId, "thread-test");
    assertStringIncludes(updated.validation, "Codex App Server turn completed");
    assertStringIncludes(updated.validation, "Commit:");
    assertStringIncludes(updated.validation, "Test turn:");
    assertStringIncludes(updated.validation, "GoalForge review: APPROVED");
    assert(streamed.some((line) => line.includes("test Codex implementation output")));
    assert(streamed.some((line) => line.includes("Review approved. Merging branch.")));
    assertEquals(
      await Deno.readTextFile(`${root}/task-1-codex-output.txt`),
      "test Codex implementation output\n",
    );
    assertEquals(await Deno.readTextFile(`${root}/workflow-before.txt`), "before");
    assertEquals(await Deno.readTextFile(`${root}/workflow-after.txt`), "after");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker resumes blocked task thread for continuation turns", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const resumed: string[] = [];
  const prompts: string[] = [];
  try {
    store.initProject();
    const { task } = store.createGoal("Continue reviewed work");
    const worker = new GoalForgeWorker(root, store, {
      createCodexClient: (onEvent) => new ChangesRequestedCodexClient(onEvent, resumed, prompts),
    });
    await worker.runTask(task.id);
    const first = store.getTask(task.id);
    assertEquals(first.status, "blocked");
    store.enqueueMessage(task.id, "user", "Please refine the result.");
    await worker.runTask(task.id);
    assertEquals(resumed, ["thread-test"]);
    assertEquals(store.listPendingMessages(task.id).length, 0);
    assert(prompts.some((prompt) => prompt.includes("Please refine the result.")));
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
    assertEquals(store.getTask("TASK-1").status, "done");
    assertEquals(store.getTask("TASK-2").status, "done");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker retries transient workflow hook failures", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const streamed: string[] = [];
  try {
    store.initProject();
    await Deno.writeTextFile(
      `${root}/WORKFLOW.md`,
      `---
version: 1
tracker:
  kind: goalforge-local
agent:
  max_concurrent_agents: 1
  max_turns: 1
  max_retries: 2
  retry_backoff_ms: 1
codex:
  model: gpt-5.5
  reasoning_effort: high
  fast_mode: true
workspace:
  worktrees_dir: .goalforge/worktrees
  hooks:
    before_run:
      - test -f retry-once || (touch retry-once && exit 1)
---
# Retry Workflow
`,
    );
    const { task } = store.createGoal("Retry transient hook failure");
    const worker = new GoalForgeWorker(root, store, {
      onEvent: (event) => streamed.push(`${event.kind}:${event.message}`),
      createCodexClient: (onEvent) => new TestCodexClient(onEvent),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assert(streamed.some((line) => line.includes("Retrying TASK-1 after failure")));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker can gate approved review through a GitHub PR", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const pullRequestGate = new TestPullRequestGate();
  try {
    store.initProject();
    updateConfig(root, { githubPrReview: true });
    const { task } = store.createGoal("Exercise PR gate");
    const worker = new GoalForgeWorker(root, store, {
      createCodexClient: (onEvent) => new TestCodexClient(onEvent),
      pullRequestGate,
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assertEquals(pullRequestGate.opened.length, 1);
    assertEquals(pullRequestGate.merged.length, 1);
    assertStringIncludes(updated.validation, "GitHub PR: https://github.test/pr/1");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker blocks task when GoalForge cannot create commit", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Exercise failed commit handling");
    const worker = new GoalForgeWorker(root, store, {
      createCodexClient: (onEvent) => new CommitFailingCodexClient(onEvent),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "blocked");
    assertStringIncludes(updated.validation, "Commit: commit failed:");
    assertStringIncludes(
      updated.blockedReason ?? "",
      "GoalForge could not create a commit",
    );
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
    protected readonly onEvent: (
      event: {
        taskId: string | null;
        runId: string | null;
        role: string;
        kind: string;
        message: string;
      },
    ) => void,
    private readonly resumed: string[] = [],
    protected readonly prompts: string[] = [],
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

  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    this.resumed.push(threadId);
    return Promise.resolve({ threadId, cwd });
  }

  async runTurn(session: CodexSession, _input: CodexTurnInput): Promise<CodexTurnResult> {
    this.prompts.push(_input.prompt);
    if (_input.title === "GoalForge scheduler") {
      assertStringIncludes(_input.prompt, "Current GoalForge board memory");
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

    assertStringIncludes(_input.prompt, "Current GoalForge board memory");
    assertStringIncludes(_input.prompt, "Codex-native subagents");
    assertStringIncludes(_input.prompt, "Repo WORKFLOW.md instructions");
    const taskId = _input.title.split(":")[0].toLowerCase();
    await Deno.writeTextFile(
      `${session.cwd}/${taskId}-codex-output.txt`,
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

class ChangesRequestedCodexClient extends TestCodexClient {
  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    if (input.title.endsWith(": review")) {
      this.prompts.push(input.prompt);
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "CHANGES_REQUESTED\n- More work is needed.",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-review-test",
        status: "completed",
        completed: true,
      };
    }
    return await super.runTurn(session, input);
  }
}

class CommitFailingCodexClient extends TestCodexClient {
  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    const result = await super.runTurn(session, input);
    if (!input.title.endsWith(": test-engineer")) {
      const lockPath = await gitOutput(session.cwd, ["rev-parse", "--git-path", "index.lock"]);
      await Deno.writeTextFile(lockPath.trim(), "locked\n");
    }
    return result;
  }
}

class TestPullRequestGate implements PullRequestGate {
  opened: string[] = [];
  merged: string[] = [];

  open(task: Task, _body: string): Promise<PullRequestInfo> {
    this.opened.push(task.id);
    return Promise.resolve({ url: "https://github.test/pr/1" });
  }

  merge(task: Task, pullRequest: PullRequestInfo): Promise<string> {
    this.merged.push(task.id);
    return Promise.resolve(`Merged ${pullRequest.url}`);
  }
}

async function git(root: string, args: string[]): Promise<void> {
  await gitOutput(root, args);
}

async function gitOutput(root: string, args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
  return new TextDecoder().decode(output.stdout);
}
