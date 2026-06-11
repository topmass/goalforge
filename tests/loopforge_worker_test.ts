import { assert, assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { BoardStore, updateConfig } from "../src/board/store.ts";
import { summarizeGoalProgress } from "../src/board/goal_progress.ts";
import type { Task } from "../src/board/types.ts";
import {
  CodexClient,
  CodexSession,
  CodexSessionOptions,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";
import { PullRequestGate, PullRequestInfo } from "../src/workers/github_pr.ts";
import { LoopForgeWorker } from "../src/workers/loopforge_worker.ts";

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
  kind: loopforge-local
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
  worktrees_dir: .loopforge/custom-worktrees
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
    const worker = new LoopForgeWorker(root, store, {
      onEvent: (event) => streamed.push(`${event.kind}:${event.message}`),
      createCodexClient: (onEvent) => new TestCodexClient(onEvent),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assert(updated.branchName?.startsWith("loopforge/task-1"));
    assert(updated.worktreePath?.includes(".loopforge/custom-worktrees/TASK-1"));
    assertEquals(updated.threadId, "thread-test");
    assertEquals(updated.parentThreadId, "thread-test");
    assertStringIncludes(
      updated.contextManifestPath ?? "",
      ".loopforge/tasks/TASK-1/context-manifest.json",
    );
    assertStringIncludes(updated.taskCard, "TASK-1 status: done");
    assertStringIncludes(updated.handoffSummary, "LoopForge Task Handoff");
    assertStringIncludes(updated.touchedPaths.join("\n"), "task-1-codex-output.txt");
    assertStringIncludes(updated.validation, "Codex App Server turn completed");
    assertStringIncludes(updated.validation, "Commit:");
    assertStringIncludes(updated.validation, "Test turn:");
    assertStringIncludes(updated.validation, "LoopForge review: APPROVED");
    assertEquals(updated.loopPhase, "done");
    assertEquals(updated.currentGate, "complete");
    assertStringIncludes(updated.nextAction, "project memory");
    assertStringIncludes(updated.verificationSummary, "Diff inspection");
    assertStringIncludes(updated.validation, "Discovered verification gates");
    assert(streamed.some((line) => line.includes("test Codex implementation output")));
    assert(streamed.some((line) => line.includes("Review approved. Merging branch.")));
    assertEquals(
      await Deno.readTextFile(`${root}/task-1-codex-output.txt`),
      "test Codex implementation output\n",
    );
    assertEquals(await Deno.readTextFile(`${root}/workflow-before.txt`), "before");
    assertEquals(await Deno.readTextFile(`${root}/workflow-after.txt`), "after");
    assertStringIncludes(await Deno.readTextFile(`${root}/AGENTS.md`), "project-specsheet.md");
    assertStringIncludes(await Deno.readTextFile(`${root}/project-specsheet.md`), "TASK-1");
    assertEquals(store.getGoal(task.goalId).status, "closed");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker recovers when the saved project Codex session is missing", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const streamed: string[] = [];
  try {
    store.initProject();
    store.setMainThread("stale-main-thread", "Old session.");
    const { task } = store.createGoal("Recover missing Codex session");
    const worker = new LoopForgeWorker(root, store, {
      onEvent: (event) => streamed.push(event.message),
      createCodexClient: (onEvent) => new MissingThreadCodexClient(onEvent),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assertEquals(updated.parentThreadId, "fresh-main-thread");
    assertEquals(updated.threadId, "thread-recovered");
    assertEquals(store.getProjectState().mainThreadId, "fresh-main-thread");
    assert(streamed.some((message) => message.includes("Saved Codex session was unavailable")));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker names main and task Codex threads with LoopForge project context", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const names: string[] = [];
  const developerInstructions: string[] = [];
  try {
    store.initProject();
    const { task } = store.createGoal("Name the task thread");
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) =>
        new NameRecordingCodexClient(onEvent, names, developerInstructions),
    });
    await worker.runTask(task.id);
    assert(names.some((name) => name.endsWith(" - main")));
    assert(names.some((name) => name.includes("TASK-1")));
    assert(developerInstructions.some((text) => text.includes("persistent LoopForge main thread")));
    assert(developerInstructions.some((text) => text.includes("LoopForge task worker")));
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
    await Deno.writeTextFile(
      `${root}/WORKFLOW.md`,
      "---\nversion: 1\nauthority:\n  publish: true\n  max_triage_retries: 0\n---\n# Test workflow\n",
    );
    const { task } = store.createGoal("Continue reviewed work");
    const worker = new LoopForgeWorker(root, store, {
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
    const first = store.createGoal("First queued task");
    const second = store.createGoal("Second queued task");
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new TestCodexClient(onEvent),
    });
    const completed = await worker.runQueue();
    assertEquals(completed.length, 2);
    assertEquals(store.getTask("TASK-1").status, "done");
    assertEquals(store.getTask("TASK-2").status, "done");
    assertEquals(store.getGoal(first.goal.id).status, "closed");
    assertEquals(store.getGoal(second.goal.id).status, "closed");
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
  kind: loopforge-local
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
  worktrees_dir: .loopforge/worktrees
  hooks:
    before_run:
      - test -f retry-once || (touch retry-once && exit 1)
---
# Retry Workflow
`,
    );
    const { task } = store.createGoal("Retry transient hook failure");
    const worker = new LoopForgeWorker(root, store, {
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
    const worker = new LoopForgeWorker(root, store, {
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

Deno.test("worker steers an active task after live failure output", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const steers: string[] = [];
  try {
    store.initProject();
    const { task } = store.createGoal("React to failing live output");
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new FailingOutputCodexClient(onEvent, steers),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assertEquals(steers.length, 1);
    assertStringIncludes(steers[0], "LoopForge live supervisor");
    assert(
      store.getBoard().events.some((event) =>
        event.role === "supervisor" && event.kind === "steer"
      ),
    );
    assert(
      store.getBoard().agentStatuses.some((status) =>
        status.phase === "done" &&
        status.lastSupervisorAction?.includes("LoopForge live supervisor")
      ),
    );
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker records supervisor gap when goal contract proof is missing", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  try {
    store.initProject();
    const { tasks } = store.createGoalWithTasks("Prove contract evidence", [
      {
        title: "Build telemetry export",
        description: "Implement telemetry export.",
        acceptanceCriteria: "- Export works.",
        priority: 100,
      },
    ], {
      completionContract: "- Quasar zettabyte audit ledger reconciles.",
    });
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new TestCodexClient(onEvent),
    });
    const updated = await worker.runTask(tasks[0].id);

    assertEquals(updated.status, "done");
    assertStringIncludes(updated.supervisorDecision, "Goal contract still needs evidence");
    const board = store.getBoard();
    const repairTask = board.tasks.find((task) => task.title === "Prove Goal Contract Evidence");
    assertEquals(repairTask?.status, "ready");
    assertStringIncludes(repairTask?.description ?? "", "Quasar zettabyte audit ledger");
    assert(
      board.events.some((event) =>
        event.role === "supervisor" && event.kind === "contract-repair-task"
      ),
    );
    assert(
      board.events.some((event) => event.role === "supervisor" && event.kind === "contract-gap"),
    );
    assertThrows(
      () => store.closeGoal(updated.goalId),
      Error,
      "not ready to close",
    );
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker queue runs automatic contract repair tasks", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  try {
    store.initProject();
    const created = store.createGoalWithTasks("Run repair task from queue", [
      {
        title: "Build telemetry export",
        description: "Implement telemetry export.",
        acceptanceCriteria: "- Export works.",
        priority: 100,
      },
    ], {
      completionContract: "- Quasar zettabyte audit ledger reconciles.",
    });
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new ContractRepairProofCodexClient(onEvent),
    });

    const completed = await worker.runQueue();
    const board = store.getBoard();
    const progress = summarizeGoalProgress(board, created.goal.id);

    assertEquals(completed.length, 2);
    assertEquals(board.tasks.map((task) => task.title), [
      "Build telemetry export",
      "Prove Goal Contract Evidence",
    ]);
    assertEquals(board.tasks.every((task) => task.status === "done"), true);
    assertEquals(progress?.contractGaps, []);
    assertEquals(progress?.completionVerdict, "Ready To Close");
    assertEquals(store.getGoal(created.goal.id).status, "closed");
    assert(
      board.events.some((event) =>
        event.role === "supervisor" && event.kind === "contract-repair-task"
      ),
    );
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker queue runs automatic completion evidence repair tasks", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Repair missing validation gate evidence");
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "LoopForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");

    const before = summarizeGoalProgress(store.getBoard(), goal.id);
    assertEquals(before?.evidenceGaps, [
      "TASK-1 evidence gap: missing discovered verification gates.",
    ]);

    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new EvidenceRepairProofCodexClient(onEvent),
    });
    const completed = await worker.runQueue();
    const board = store.getBoard();
    const progress = summarizeGoalProgress(board, goal.id);

    assertEquals(completed.length, 1);
    assertEquals(board.tasks.map((candidate) => candidate.title), [
      "Repair missing validation gate evidence",
      "Repair Goal Evidence",
    ]);
    assertEquals(board.tasks.every((candidate) => candidate.status === "done"), true);
    assertEquals(progress?.evidenceGaps, []);
    assertEquals(progress?.completionVerdict, "Ready To Close");
    assertEquals(store.getGoal(goal.id).status, "closed");
    assert(
      board.events.some((event) =>
        event.role === "supervisor" && event.kind === "evidence-repair-task"
      ),
    );
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker blocks task when LoopForge cannot create commit", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Exercise failed commit handling");
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new CommitFailingCodexClient(onEvent),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "blocked");
    assertStringIncludes(updated.validation, "Commit: commit failed:");
    assertStringIncludes(
      updated.blockedReason ?? "",
      "LoopForge could not create a commit",
    );
    assertEquals(updated.loopPhase, "blocked");
    assertEquals(updated.currentGate, "needs-input");
    assertStringIncludes(updated.needsInputPrompt ?? "", "LoopForge could not create a commit");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker stops an active task through the running Codex client", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const implementationStarted = deferred<void>();
  let interruptCalled = false;
  try {
    store.initProject();
    const { task } = store.createGoal("Stop active worker turn");
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) =>
        new InterruptibleCodexClient(onEvent, () => implementationStarted.resolve(), () => {
          interruptCalled = true;
        }),
    });
    const running = worker.runTask(task.id);
    await implementationStarted.promise;
    store.requestTaskStop(task.id, "User stopped this task.");

    const updated = await running;
    const finishedRun = store.getBoard().runs[0];
    assertEquals(interruptCalled, true);
    assertEquals(updated.status, "blocked");
    assertEquals(updated.activeTurnId, null);
    assertEquals(finishedRun.status, "failed");
    assertEquals(Boolean(finishedRun.stopRequestedAt), true);
    assertStringIncludes(updated.blockedReason ?? "", "Task stopped by request");
    assertStringIncludes(updated.needsInputPrompt ?? "", "Task stopped by request");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker pauses ready tasks that conflict with completed work", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  try {
    store.initProject();
    const { tasks } = store.createGoalWithTasks("Handle conflicting tasks", [
      {
        title: "Touch shared output",
        description: "Touch shared output.",
        acceptanceCriteria: "- Output exists.",
        priority: 200,
      },
      {
        title: "Use shared output",
        description: "Use shared output.",
        acceptanceCriteria: "- Output is used.",
        priority: 100,
      },
    ]);
    store.updateTaskTouchedPaths(tasks[1].id, ["task-1-codex-output.txt"]);
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new TestCodexClient(onEvent),
    });
    const updated = await worker.runTask(tasks[0].id);
    assertEquals(updated.status, "done");
    const paused = store.getTask(tasks[1].id);
    assertEquals(paused.status, "blocked");
    assertStringIncludes(paused.supervisorDecision, "TASK-1 touched task-1-codex-output.txt");
    assertStringIncludes(paused.conflictSignals.join("\n"), "TASK-1 also touches");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker repairs failed verification before review", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const prompts: string[] = [];
  try {
    store.initProject();
    await writeWorkflow(root, { maxTurns: 2 });
    const { task } = store.createGoal("Repair after failed verification");
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new RepairingVerificationCodexClient(onEvent, prompts),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assertEquals(updated.loopPhase, "done");
    assertStringIncludes(updated.validation, "VERIFICATION_PASSED");
    assert(prompts.some((prompt) => prompt.includes("Repair evidence from failed verification")));
    assert(
      store.getBoard().events.some((event) =>
        event.role === "test-engineer" && event.kind === "repair"
      ),
    );
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("worker blocks when verification repair budget is exhausted", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  try {
    store.initProject();
    await writeWorkflow(root, { maxTurns: 1 });
    const { task } = store.createGoal("Block after failed verification");
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new AlwaysFailingVerificationCodexClient(onEvent),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "blocked");
    assertEquals(updated.loopPhase, "blocked");
    assertEquals(updated.currentGate, "needs-input");
    assertStringIncludes(updated.needsInputPrompt ?? "", "Verification failed after 1 attempt");
    assertStringIncludes(updated.needsInputPrompt ?? "", "Latest failure:");
    assertStringIncludes(updated.needsInputPrompt ?? "", "Required behavior is still missing");
    // The concise prompt points at the full dump, which stays in the verification summary.
    assertStringIncludes(updated.verificationSummary, "VERIFICATION_FAILED");
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

async function writeWorkflow(root: string, options: { maxTurns: number }): Promise<void> {
  await Deno.writeTextFile(
    `${root}/WORKFLOW.md`,
    `---
version: 1
tracker:
  kind: loopforge-local
agent:
  max_concurrent_agents: 1
  max_turns: ${options.maxTurns}
  max_retries: 1
  retry_backoff_ms: 1
codex:
  model: gpt-5.5
  reasoning_effort: high
  fast_mode: true
workspace:
  worktrees_dir: .loopforge/worktrees
  hooks:
    before_run: []
    after_run: []
---
# Test Workflow
`,
  );
}

Deno.test("worker runs ops publish tasks deterministically without Codex", async () => {
  const root = Deno.makeTempDirSync();
  const origin = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    await git(origin, ["init", "--bare", "-b", "main"]);
    await git(root, ["init", "-b", "main"]);
    await git(root, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "--allow-empty",
      "-m",
      "seed",
    ]);
    await git(root, ["remote", "add", "origin", origin]);
    store.initProject();
    await Deno.writeTextFile(`${root}/current-state.txt`, "publish this\n");
    const { goal, tasks } = store.createGoalWithTasks("Publish current work to the remote", [{
      title: "Commit and push the current repository state",
      description: "Commit the root working tree and push it to origin.",
      acceptanceCriteria: "- The remote head matches the local head.",
      priority: 100,
      kind: "ops",
      opsAction: "publish",
    }]);
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: () => {
        throw new Error("Ops tasks must not start a Codex client.");
      },
    });
    const updated = await worker.runTask(tasks[0].id);
    assertEquals(updated.status, "done");
    assertEquals(updated.kind, "ops");
    assertEquals(updated.loopPhase, "done");
    assertEquals(updated.currentGate, "complete");
    assertStringIncludes(updated.validation, "LoopForge publish action completed.");
    assertStringIncludes(updated.validation, "VERIFICATION_PASSED");
    assertStringIncludes(updated.validation, "LoopForge review: APPROVED");
    assertStringIncludes(updated.handoffSummary, "Published main to origin");
    const board = store.getBoard();
    assertEquals(board.goals.find((item) => item.id === goal.id)?.status, "closed");
    assertEquals(summarizeGoalProgress(board, goal.id)?.evidenceGaps.length, 0);
    const remoteSubject = await gitOutput(origin, ["log", "-1", "--format=%s"]);
    assertStringIncludes(remoteSubject, "Commit and push the current repository state");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
    await Deno.remove(origin, { recursive: true });
  }
});

Deno.test("worker blocks ops publish tasks when authority disables publishing", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "--allow-empty",
      "-m",
      "seed",
    ]);
    store.initProject();
    await Deno.writeTextFile(
      `${root}/WORKFLOW.md`,
      `---
version: 1
authority:
  publish: false
---
# Test Workflow
`,
    );
    const { tasks } = store.createGoalWithTasks("Publish without authority", [{
      title: "Push current state",
      description: "Push the repository.",
      acceptanceCriteria: "- Remote matches local.",
      priority: 100,
      kind: "ops",
      opsAction: "publish",
    }]);
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: () => {
        throw new Error("Ops tasks must not start a Codex client.");
      },
    });
    const updated = await worker.runTask(tasks[0].id);
    assertEquals(updated.status, "blocked");
    assertStringIncludes(
      updated.needsInputPrompt ?? "",
      "disabled by the WORKFLOW.md authority policy",
    );
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main agent triage retries a worker with corrected instructions", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "--allow-empty",
      "-m",
      "seed",
    ]);
    store.initProject();
    const { task } = store.createGoal("Retry after corrected instructions");
    const script: TriageScript = {
      testEngineer: [
        "NEEDS_INPUT\nThe verification command was not found. Which test runner does this repo use?",
      ],
      triage: ["TRIAGE_RETRY\nUse deno task test as the verification command."],
      testEngineerCalls: 0,
      triageCalls: 0,
    };
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new TriageScriptedCodexClient(onEvent, script),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assertEquals(script.triageCalls, 1);
    assertEquals(script.testEngineerCalls, 2);
    assertEquals(updated.triageAttempts, 1);
    const board = store.getBoard();
    assert(
      board.messages.some((message) =>
        message.role === "core" &&
        message.message.includes("deno task test") &&
        message.processed
      ),
    );
    assertStringIncludes(updated.supervisorDecision, "Main agent triage: retry");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main agent triage escalates hard external blockers with one clear ask", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "--allow-empty",
      "-m",
      "seed",
    ]);
    store.initProject();
    const { task } = store.createGoal("Set up Clerk end to end");
    const script: TriageScript = {
      testEngineer: [
        "NEEDS_INPUT\nClerk setup requires CLERK_SECRET_KEY and it is not configured anywhere.",
      ],
      triage: ["TRIAGE_ESCALATE\nProvide CLERK_SECRET_KEY via Reply, then restart this task."],
      testEngineerCalls: 0,
      triageCalls: 0,
    };
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new TriageScriptedCodexClient(onEvent, script),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "blocked");
    assertEquals(script.triageCalls, 1);
    assertEquals(
      updated.needsInputPrompt,
      "Provide CLERK_SECRET_KEY via Reply, then restart this task.",
    );
    assertEquals(updated.triageAttempts, 1);
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("triage escalates immediately when the same blocker repeats", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "--allow-empty",
      "-m",
      "seed",
    ]);
    store.initProject();
    const { task } = store.createGoal("Loop guard against repeated blockers");
    const blocker = "NEEDS_INPUT\nThe deployment target is ambiguous and the task cannot proceed.";
    const script: TriageScript = {
      testEngineer: [blocker, blocker],
      triage: [
        "TRIAGE_RETRY\nAssume the staging deployment target and proceed.",
        "TRIAGE_RETRY\nThis second retry must never be used.",
      ],
      testEngineerCalls: 0,
      triageCalls: 0,
    };
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new TriageScriptedCodexClient(onEvent, script),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "blocked");
    assertEquals(script.triageCalls, 1);
    assertEquals(updated.triageAttempts, 1);
    assertStringIncludes(updated.needsInputPrompt ?? "", "deployment target is ambiguous");
    const events = store.getBoard().events;
    assert(
      events.some((event) =>
        event.kind === "triage" && event.message.includes("same blocker repeated")
      ),
    );
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("main agent triage resolves publish blockers with the harness action", async () => {
  const root = Deno.makeTempDirSync();
  const origin = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    await git(origin, ["init", "--bare", "-b", "main"]);
    await git(root, ["init", "-b", "main"]);
    await git(root, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      "commit",
      "--allow-empty",
      "-m",
      "seed",
    ]);
    await git(root, ["remote", "add", "origin", origin]);
    store.initProject();
    await Deno.writeTextFile(`${root}/dirty-state.txt`, "uncommitted work\n");
    const { goal, task } = store.createGoal("Commit and push the current state to GitHub");
    const script: TriageScript = {
      testEngineer: [
        "NEEDS_INPUT\nThis task asks to push the repository, but the worktree is clean and workers cannot create commits or push.",
      ],
      triage: ["TRIAGE_RESOLVE publish\nThe harness publish action satisfies this task directly."],
      testEngineerCalls: 0,
      triageCalls: 0,
    };
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new TriageScriptedCodexClient(onEvent, script),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assertEquals(updated.kind, "ops");
    assertEquals(updated.opsAction, "publish");
    assertEquals(script.triageCalls, 1);
    assertStringIncludes(updated.validation, "LoopForge publish action completed.");
    const board = store.getBoard();
    assertEquals(board.goals.find((item) => item.id === goal.id)?.status, "closed");
    const remoteFiles = await gitOutput(origin, ["ls-tree", "--name-only", "HEAD"]);
    assertStringIncludes(remoteFiles, "dirty-state.txt");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
    await Deno.remove(origin, { recursive: true });
  }
});

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

  startSession(cwd: string, _options: CodexSessionOptions = {}): Promise<CodexSession> {
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "thread",
      message: "test Codex thread started",
    });
    return Promise.resolve({ threadId: "thread-test", cwd });
  }

  resumeSession(
    cwd: string,
    threadId: string,
    _options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    this.resumed.push(threadId);
    return Promise.resolve({ threadId, cwd });
  }

  async runTurn(session: CodexSession, _input: CodexTurnInput): Promise<CodexTurnResult> {
    this.prompts.push(_input.prompt);
    if (_input.title === "LoopForge main thread seed") {
      assertStringIncludes(_input.prompt, "persistent LoopForge main thread");
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

    if (_input.title === "LoopForge scheduler") {
      assertStringIncludes(_input.prompt, "Current LoopForge board memory");
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
      assertStringIncludes(_input.prompt, "Current LoopForge board memory");
      assertStringIncludes(_input.prompt, "Discovered verification gates");
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

    if (_input.title.endsWith(": review")) {
      assertStringIncludes(_input.prompt, "Current LoopForge board memory");
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
      assertStringIncludes(_input.prompt, "Absorb this completed LoopForge task");
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

    assertStringIncludes(_input.prompt, "Current LoopForge board memory");
    assertStringIncludes(_input.prompt, "LoopForge owns scheduling and concurrency");
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

class ContractRepairProofCodexClient extends TestCodexClient {
  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    if (input.title === "TASK-2: test-engineer") {
      assertStringIncludes(input.prompt, "contract-evidence or completion-evidence repair task");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message:
          "VERIFICATION_PASSED\n- Quasar zettabyte audit ledger reconciles via focused smoke proof.",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-test-engineer",
        status: "completed",
        completed: true,
      };
    }
    return await super.runTurn(session, input);
  }
}

class EvidenceRepairProofCodexClient extends TestCodexClient {
  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    if (input.title === "TASK-2: test-engineer") {
      assertStringIncludes(input.prompt, "completion-evidence repair task");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: [
          "VERIFICATION_PASSED",
          "- TASK-1 evidence gap: missing discovered verification gates. Proved by inspecting the completed task validation and recording the missing gate evidence here.",
        ].join("\n"),
      });
      return {
        threadId: session.threadId,
        turnId: "turn-test-engineer",
        status: "completed",
        completed: true,
      };
    }
    return await super.runTurn(session, input);
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

class ReviewRetryThenApproveCodexClient extends TestCodexClient {
  constructor(
    onEvent: ConstructorParameters<typeof TestCodexClient>[0],
    readonly seenPrompts: string[],
    // Shared across client instances: the worker creates a fresh client per attempt.
    readonly counters: { reviews: number },
  ) {
    super(onEvent, [], seenPrompts);
  }

  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    if (input.title.endsWith(": review")) {
      this.counters.reviews++;
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: this.counters.reviews === 1
          ? "CHANGES_REQUESTED\n- Rename the helper to match repo conventions."
          : "APPROVED\n- Findings addressed.",
      });
      return {
        threadId: session.threadId,
        turnId: `turn-review-${this.counters.reviews}`,
        status: "completed",
        completed: true,
      };
    }
    return await super.runTurn(session, input);
  }
}

class ManualVerificationCodexClient extends TestCodexClient {
  constructor(
    onEvent: ConstructorParameters<typeof TestCodexClient>[0],
    readonly seenPrompts: string[] = [],
  ) {
    super(onEvent, [], seenPrompts);
  }

  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    if (input.title.endsWith(": test-engineer")) {
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: [
          "VERIFICATION_PASSED",
          "- deno check: passed in the worktree.",
          "Remaining risks: needs manual verification: confirm the dialog renders in-app.",
        ].join("\n"),
      });
      return {
        threadId: session.threadId,
        turnId: "turn-test-engineer",
        status: "completed",
        completed: true,
      };
    }
    return await super.runTurn(session, input);
  }
}

class ParallelTrackingCodexClient extends TestCodexClient {
  constructor(
    onEvent: ConstructorParameters<typeof TestCodexClient>[0],
    // Shared across instances: the worker creates one client per task run.
    readonly load: { active: number; peak: number },
  ) {
    super(onEvent);
  }

  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    const isImplementationTurn = /^TASK-\d+: (?!test-engineer|review|absorb)/.test(input.title);
    if (isImplementationTurn) {
      this.load.active++;
      this.load.peak = Math.max(this.load.peak, this.load.active);
      await new Promise((resolve) => setTimeout(resolve, 200));
      this.load.active--;
    }
    return await super.runTurn(session, input);
  }
}

class FakePlannerClient implements CodexClient {
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
    private readonly reply: string,
    readonly prompts: string[],
  ) {}

  startSession(cwd: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: "planner-thread", cwd });
  }

  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    this.prompts.push(input.prompt);
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "agent",
      message: this.reply,
    });
    return Promise.resolve({
      threadId: session.threadId,
      turnId: "turn-planner",
      status: "completed",
      completed: true,
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

class MissingThreadCodexClient extends TestCodexClient {
  private forkAttempts = 0;
  private readonly seededThreads = new Set<string>();

  override startSession(cwd: string, _options: CodexSessionOptions = {}): Promise<CodexSession> {
    return Promise.resolve({ threadId: "fresh-main-thread", cwd });
  }

  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    if (input.title === "LoopForge main thread seed") {
      this.seededThreads.add(session.threadId);
    }
    return await super.runTurn(session, input);
  }

  forkSession(
    cwd: string,
    threadId: string,
    _options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    this.forkAttempts++;
    if (this.forkAttempts === 1) {
      throw new Error(
        JSON.stringify({
          message: `JSON-RPC error -32600: no rollout found for thread id ${threadId}`,
        }),
      );
    }
    assertEquals(threadId, "fresh-main-thread");
    assert(this.seededThreads.has("fresh-main-thread"));
    return Promise.resolve({ threadId: "thread-recovered", cwd });
  }
}

class NameRecordingCodexClient extends TestCodexClient {
  constructor(
    onEvent: ConstructorParameters<typeof TestCodexClient>[0],
    private readonly names: string[],
    private readonly developerInstructions: string[],
  ) {
    super(onEvent);
  }

  override startSession(
    cwd: string,
    options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    if (options.name) {
      this.names.push(options.name);
    }
    if (options.developerInstructions) {
      this.developerInstructions.push(options.developerInstructions);
    }
    return super.startSession(cwd, options);
  }

  override resumeSession(
    cwd: string,
    threadId: string,
    options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    if (options.name) {
      this.names.push(options.name);
    }
    if (options.developerInstructions) {
      this.developerInstructions.push(options.developerInstructions);
    }
    return super.resumeSession(cwd, threadId, options);
  }
}

class CommitFailingCodexClient extends TestCodexClient {
  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    const result = await super.runTurn(session, input);
    if (/^TASK-\d+: /.test(input.title) && !input.title.endsWith(": test-engineer")) {
      const lockPath = await gitOutput(session.cwd, ["rev-parse", "--git-path", "index.lock"]);
      await Deno.writeTextFile(lockPath.trim(), "locked\n");
    }
    return result;
  }
}

class FailingOutputCodexClient extends TestCodexClient {
  constructor(
    onEvent: ConstructorParameters<typeof TestCodexClient>[0],
    private readonly steers: string[],
  ) {
    super(onEvent);
  }

  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    if (!input.title.endsWith(": review") && !input.title.endsWith(": test-engineer")) {
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "process/outputDelta",
        message: "stderr: test failed with assertion error",
      });
    }
    return await super.runTurn(session, input);
  }

  steerTurn(_session: CodexSession, message: string): Promise<void> {
    this.steers.push(message);
    return Promise.resolve();
  }
}

class InterruptibleCodexClient extends TestCodexClient {
  private interrupted = false;

  constructor(
    onEvent: ConstructorParameters<typeof TestCodexClient>[0],
    private readonly onImplementationStarted: () => void,
    private readonly onInterrupt: () => void,
  ) {
    super(onEvent);
  }

  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    if (/^TASK-\d+: /.test(input.title) && !input.title.endsWith(": test-engineer")) {
      this.onImplementationStarted();
      while (!this.interrupted) {
        await delay(10);
      }
      return {
        threadId: session.threadId,
        turnId: "turn-interrupted",
        status: "interrupted",
        completed: false,
      };
    }
    return await super.runTurn(session, input);
  }

  interruptTurn(_session: CodexSession): Promise<void> {
    this.interrupted = true;
    this.onInterrupt();
    return Promise.resolve();
  }
}

class RepairingVerificationCodexClient extends TestCodexClient {
  private testTurns = 0;

  constructor(
    onEvent: ConstructorParameters<typeof TestCodexClient>[0],
    prompts: string[],
  ) {
    super(onEvent, [], prompts);
  }

  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    if (input.title.endsWith(": test-engineer")) {
      this.prompts.push(input.prompt);
      this.testTurns++;
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: this.testTurns === 1
          ? "VERIFICATION_FAILED\n- Output still says first pass."
          : "VERIFICATION_PASSED\n- Repair output is correct.",
      });
      return {
        threadId: session.threadId,
        turnId: `turn-test-engineer-${this.testTurns}`,
        status: "completed",
        completed: true,
      };
    }
    if (/^TASK-\d+: repair /.test(input.title)) {
      this.prompts.push(input.prompt);
      const taskId = input.title.split(":")[0].toLowerCase();
      await Deno.writeTextFile(`${session.cwd}/${taskId}-codex-output.txt`, "repaired output\n");
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "output",
        message: "repaired output",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-repair",
        status: "completed",
        completed: true,
      };
    }
    return await super.runTurn(session, input);
  }
}

class AlwaysFailingVerificationCodexClient extends TestCodexClient {
  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    if (input.title.endsWith(": test-engineer")) {
      this.onEvent({
        taskId: null,
        runId: null,
        role: "codex",
        kind: "agent",
        message: "VERIFICATION_FAILED\n- Required behavior is still missing.",
      });
      return {
        threadId: session.threadId,
        turnId: "turn-test-engineer-failed",
        status: "completed",
        completed: true,
      };
    }
    return await super.runTurn(session, input);
  }
}

interface TriageScript {
  testEngineer: string[];
  triage: string[];
  testEngineerCalls: number;
  triageCalls: number;
}

class TriageScriptedCodexClient extends TestCodexClient {
  constructor(
    onEvent: ConstructorParameters<typeof TestCodexClient>[0],
    private readonly script: TriageScript,
  ) {
    super(onEvent);
  }

  override async runTurn(
    session: CodexSession,
    input: CodexTurnInput,
  ): Promise<CodexTurnResult> {
    if (input.title.endsWith(": test-engineer")) {
      const message = this.script.testEngineer[this.script.testEngineerCalls] ??
        "VERIFICATION_PASSED\n- Verified after the triage retry.";
      this.script.testEngineerCalls++;
      this.onEvent({ taskId: null, runId: null, role: "codex", kind: "agent", message });
      return {
        threadId: session.threadId,
        turnId: `turn-test-engineer-${this.script.testEngineerCalls}`,
        status: "completed",
        completed: true,
      };
    }
    if (input.title.endsWith(": triage")) {
      assertStringIncludes(input.prompt, "triaging a blocked sub-agent task");
      assertStringIncludes(input.prompt, "Blocker reported by the worker");
      const message = this.script.triage[this.script.triageCalls] ??
        "TRIAGE_ESCALATE\nNo scripted triage response remained.";
      this.script.triageCalls++;
      this.onEvent({ taskId: null, runId: null, role: "codex", kind: "agent", message });
      return {
        threadId: session.threadId,
        turnId: `turn-triage-${this.script.triageCalls}`,
        status: "completed",
        completed: true,
      };
    }
    return await super.runTurn(session, input);
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

Deno.test("review findings trigger one bounded repair pass before blocking", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const prompts: string[] = [];
  const events: string[] = [];
  try {
    store.initProject();
    const { task } = store.createGoal("Address review findings automatically");
    const counters = { reviews: 0 };
    const worker = new LoopForgeWorker(root, store, {
      onEvent: (event) => events.push(`${event.role}/${event.kind}: ${event.message}`),
      createCodexClient: (onEvent) =>
        new ReviewRetryThenApproveCodexClient(onEvent, prompts, counters),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assert(prompts.some((prompt) => prompt.includes("Address exactly these findings")));
    assert(prompts.some((prompt) => prompt.includes("Rename the helper")));
    assert(events.some((line) => line.includes("reviewer/retry")));
    assertEquals(store.getTask(task.id).triageAttempts, 1);
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("attended mode holds unverifiable work in Review and restart merges it", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const prompts: string[] = [];
  const events: string[] = [];
  try {
    store.initProject();
    const { task } = store.createGoal("Ship the dialog change");
    const worker = new LoopForgeWorker(root, store, {
      onEvent: (event) => events.push(`${event.role}/${event.kind}: ${event.message}`),
      createCodexClient: (onEvent) => new ManualVerificationCodexClient(onEvent, prompts),
    });
    const held = await worker.runTask(task.id);
    assertEquals(held.status, "review");
    assertEquals(held.currentGate, "manual-verification");
    assertStringIncludes(held.needsInputPrompt ?? "", "needs manual verification");
    assertStringIncludes(held.needsInputPrompt ?? "", "restart this task");
    assert(events.some((line) => line.includes("merger/hold")));
    assert(prompts.some((prompt) => prompt.includes("Run mode: ATTENDED")));

    const engineerTurnsBefore = prompts.filter((p) => p.includes("test engineer")).length;
    const merged = await worker.runTask(task.id);
    assertEquals(merged.status, "done");
    assertEquals(
      prompts.filter((p) => p.includes("test engineer")).length,
      engineerTurnsBefore,
    );
    assert(events.some((line) => line.includes("merger/resume")));
    assertEquals(store.getGoal(task.goalId).status, "closed");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("unattended mode merges unverifiable work with the note recorded", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const prompts: string[] = [];
  try {
    store.initProject();
    const { task } = store.createGoal("Ship the dialog change overnight");
    const worker = new LoopForgeWorker(root, store, {
      runMode: "unattended",
      createCodexClient: (onEvent) => new ManualVerificationCodexClient(onEvent, prompts),
    });
    const updated = await worker.runTask(task.id);
    assertEquals(updated.status, "done");
    assertStringIncludes(updated.validation, "needs manual verification");
    assert(prompts.some((prompt) => prompt.includes("Run mode: UNATTENDED")));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("queue keeps all agent slots busy and refills as tasks finish", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const load = { active: 0, peak: 0 };
  try {
    store.initProject();
    store.createGoalWithTasks("Three independent fixes", [
      { title: "Fix A", description: "Touch a.txt only.", acceptanceCriteria: "- done", priority: 100 },
      { title: "Fix B", description: "Touch b.txt only.", acceptanceCriteria: "- done", priority: 90 },
      { title: "Fix C", description: "Touch c.txt only.", acceptanceCriteria: "- done", priority: 80 },
    ]);
    const worker = new LoopForgeWorker(root, store, {
      createCodexClient: (onEvent) => new ParallelTrackingCodexClient(onEvent, load),
    });
    const completed = await worker.runQueue(Number.POSITIVE_INFINITY, 2);
    assertEquals(completed.length, 3);
    assertEquals(store.getTask("TASK-1").status, "done");
    assertEquals(store.getTask("TASK-2").status, "done");
    assertEquals(store.getTask("TASK-3").status, "done");
    assertEquals(load.peak, 2, `expected two concurrent implementation turns, saw peak ${load.peak}`);
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("stuck queue revalidates dependencies and unchains independent tasks", async () => {
  const root = Deno.makeTempDirSync();
  await seedGitRepo(root);

  const store = new BoardStore(root);
  const plannerPrompts: string[] = [];
  const events: string[] = [];
  try {
    store.initProject();
    store.createGoalWithTasks("Two mod fixes", [
      { title: "Fix shop rebuy", description: "Patch shop.", acceptanceCriteria: "- done", priority: 100 },
      {
        title: "Fix soil planting",
        description: "Patch soil.",
        acceptanceCriteria: "- done",
        priority: 90,
        dependsOn: ["Fix shop rebuy"],
      },
    ]);
    store.requestTransition("TASK-1", "blocked", "test", "Stuck on purpose.");
    const worker = new LoopForgeWorker(root, store, {
      onEvent: (event) => events.push(`${event.role}/${event.kind}: ${event.message}`),
      createCodexClient: (onEvent) => new TestCodexClient(onEvent),
      createPlannerClient: (onEvent) =>
        new FakePlannerClient(onEvent, '{"dependencies": {"TASK-2": []}}', plannerPrompts),
    });
    const completed = await worker.runQueue();
    assertEquals(completed.length, 1);
    assertEquals(store.getTask("TASK-2").status, "done");
    assertEquals(store.getTask("TASK-2").dependencyIds, []);
    assertEquals(store.getTask("TASK-1").status, "blocked");
    assert(plannerPrompts[0].includes("Re-judge dependsOn for these tasks only: TASK-2"));
    assert(events.some((line) => line.includes("planner/dependencies")));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
