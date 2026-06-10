import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { summarizeGoalProgress } from "../src/board/goal_progress.ts";
import { probeLights, runGoalProbes } from "../src/workers/goal_probes.ts";

Deno.test("probes run real commands and record pass/fail with expectations", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal } = store.createGoal("Probe this goal");
    store.addProbes(goal.id, [
      { label: "marker file exists", command: "test -f marker.txt" },
      { label: "greets", command: "echo hello-world", expectContains: "hello-world" },
      { label: "wrong output", command: "echo nope", expectContains: "expected-text" },
    ]);
    const first = await runGoalProbes(root, store, goal.id);
    assertEquals(first.total, 3);
    assertEquals(first.passed, 1);
    assertEquals(probeLights(store.listProbes(goal.id)), "○●○");

    await Deno.writeTextFile(`${root}/marker.txt`, "here\n");
    const second = await runGoalProbes(root, store, goal.id);
    assertEquals(second.passed, 2);
    const failing = store.listProbes(goal.id).find((probe) => probe.lastStatus === "failed");
    assertStringIncludes(failing?.lastOutput ?? "", "nope");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("failing probes hold a goal open and supersede prose contract matching", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Win-condition gated goal");
    store.addProbes(goal.id, [{ label: "always passes", command: "true" }]);
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat - sanity.",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Proof recorded for the change.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "GoalForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "card");
    store.updateTaskHandoff(task.id, "handoff");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");

    const pending = summarizeGoalProgress(store.getBoard(), goal.id);
    assertEquals(pending?.completionReady, false);
    assert(pending?.evidenceGaps.some((gap) => gap.includes("not yet checked")));

    await runGoalProbes(root, store, goal.id);
    const ready = summarizeGoalProgress(store.getBoard(), goal.id);
    assertEquals(ready?.completionReady, true);
    assertEquals(ready?.probesPassed, 1);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("lessons store dedupes and caps text", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.addLesson("Always run deno task test before handing off.", "repair");
    store.addLesson("Always run deno task test before handing off.", "repair");
    store.addLesson("Use .env.test for integration credentials.", "triage");
    const lessons = store.listLessons(10);
    assertEquals(lessons.length, 2);
    assertStringIncludes(
      store.getBoard().lessons.map((lesson) => lesson.text).join("\n"),
      ".env.test",
    );
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
