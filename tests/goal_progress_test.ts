import { assertEquals } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { summarizeClosedGoals, summarizeGoalProgress } from "../src/board/goal_progress.ts";

Deno.test("goal progress summarizes the active unfinished goal", () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-progress-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.createGoalWithTasks("Already shipped", [{
      title: "Finished task",
      description: "Already complete.",
      acceptanceCriteria: "Done.",
      priority: 1,
    }]);
    store.requestTransition("TASK-1", "in_progress");
    store.updateTaskValidation("TASK-1", "validation passed");
    store.requestTransition("TASK-1", "review");
    store.requestTransition("TASK-1", "done");

    const { tasks } = store.createGoalWithTasks("Build the command center", [
      {
        title: "Ready work",
        description: "Ready task.",
        acceptanceCriteria: "Ready.",
        priority: 10,
      },
      {
        title: "Blocked work",
        description: "Blocked task.",
        acceptanceCriteria: "Blocked.",
        priority: 9,
      },
    ]);
    store.requestTransition(tasks[1].id, "blocked", "daemon", "Need user decision.");

    const progress = summarizeGoalProgress(store.getBoard());

    assertEquals(progress?.goal.text, "Build the command center");
    assertEquals(progress?.status, "Needs Input");
    assertEquals(progress?.completionVerdict, "Needs Input");
    assertEquals(progress?.completionReady, false);
    assertEquals(progress?.total, 2);
    assertEquals(progress?.ready, 1);
    assertEquals(progress?.needsInput, 1);
    assertEquals(progress?.done, 0);
    assertEquals(progress?.evidenceGaps, []);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("goal progress reports completion evidence gaps", () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-progress-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Ship without proof");
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(task.id, "deno test passed");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");

    const progress = summarizeGoalProgress(store.getBoard());

    assertEquals(progress?.status, "Evidence Missing");
    assertEquals(progress?.completionVerdict, "Evidence Missing");
    assertEquals(progress?.completionReady, false);
    assertEquals(progress?.missingValidation, 0);
    assertEquals(progress?.missingApprovedReview, 1);
    assertEquals(progress?.missingHandoff, 1);
    assertEquals(progress?.evidenceGaps, [
      "TASK-1 evidence gap: missing implementation turn status.",
      "TASK-1 evidence gap: missing test turn status.",
      "TASK-1 evidence gap: missing discovered verification gates.",
      "TASK-1 evidence gap: missing verification verdict.",
      "TASK-1 evidence gap: missing commit.",
      "TASK-1 evidence gap: missing approved review.",
      "TASK-1 evidence gap: missing final git status.",
      "TASK-1 is done but has no compact handoff or task card.",
    ]);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("goal progress marks fully proven completed goals ready to close", () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-progress-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Ship with proof");
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
        "",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "GoalForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");

    const progress = summarizeGoalProgress(store.getBoard());

    assertEquals(progress?.status, "Complete");
    assertEquals(progress?.completionVerdict, "Ready To Close");
    assertEquals(progress?.completionReady, true);
    assertEquals(progress?.evidenceGaps, []);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("goal progress blocks closure when custom contract proof is missing", () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-progress-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, tasks } = store.createGoalWithTasks("Ship contract-gated goal", [
      {
        title: "Build mouse command center",
        description: "Implement the command center.",
        acceptanceCriteria: "- Command center works.",
        priority: 100,
      },
    ], {
      completionContract: "- OpenTUI smoke validates mouse-controlled Build Goal.",
    });
    const task = tasks[0];
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
        "",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "GoalForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");

    const missing = summarizeGoalProgress(store.getBoard(), goal.id);

    assertEquals(missing?.completionVerdict, "Evidence Missing");
    assertEquals(missing?.completionReady, false);
    assertEquals(missing?.contractGaps, [
      'Goal contract gap: no recorded evidence for "OpenTUI smoke validates mouse-controlled Build Goal.".',
    ]);

    store.updateTaskHandoff(
      task.id,
      "OpenTUI smoke validates mouse-controlled Build Goal.",
    );
    const proven = summarizeGoalProgress(store.getBoard(), goal.id);

    assertEquals(proven?.contractGaps, []);
    assertEquals(proven?.completionVerdict, "Ready To Close");
    assertEquals(proven?.completionReady, true);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("goal contract proof ignores task-card echoes", () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-progress-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, tasks } = store.createGoalWithTasks("Avoid false proof", [
      {
        title: "Echo missing proof",
        description: "Echo missing proof.",
        acceptanceCriteria: "- Echo recorded.",
        priority: 100,
      },
    ], {
      completionContract: "- Nebula checksum replay audit passes.",
    });
    const task = tasks[0];
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
        "",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "GoalForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "Nebula checksum replay audit passes.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");

    const missing = summarizeGoalProgress(store.getBoard(), goal.id);

    assertEquals(missing?.completionReady, false);
    assertEquals(missing?.contractGaps, [
      'Goal contract gap: no recorded evidence for "Nebula checksum replay audit passes.".',
    ]);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("closed goal summaries keep recent closure history", () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-progress-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Archive this goal");
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
        "",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "GoalForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");
    store.closeGoal(goal.id, "Closed with proof.");

    const closed = summarizeClosedGoals(store.getBoard());

    assertEquals(closed.length, 1);
    assertEquals(closed[0].id, "GOAL-1");
    assertEquals(closed[0].text, "Archive this goal");
    assertEquals(closed[0].closureSummary, "Closed with proof.");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
