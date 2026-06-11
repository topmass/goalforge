import { assert, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { buildProjectMemory } from "../src/workers/project_memory.ts";

Deno.test("project memory summarizes board state, validation, and recent events", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Remember this goal");
    store.updateTaskValidation(task.id, "deno test passed\nbrowser smoke passed");
    store.appendEvent(task.id, null, "worker", "handoff", "Changed src/example.ts");

    const memory = buildProjectMemory(store);
    assertStringIncludes(memory, "LoopForge project memory");
    assertStringIncludes(memory, "Current goal:");
    assertStringIncludes(memory, "GOAL-1 Ready 0/1 done");
    assertStringIncludes(memory, "Evidence: 0 missing validation, 0 missing approved review");
    assertStringIncludes(memory, "Completion verdict: Ready To Run");
    assertStringIncludes(memory, "Contract:");
    assertStringIncludes(memory, "Remember this goal");
    assertStringIncludes(memory, "TASK-1 [ready/queued]");
    assertStringIncludes(memory, "deno test passed browser smoke passed");
    assertStringIncludes(memory, "worker/handoff TASK-1");
    assert(memory.length <= 8000);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("project memory keeps recently closed goals", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Remember closed work");
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
        "LoopForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");
    store.closeGoal(goal.id, "Closed with durable proof.");

    const memory = buildProjectMemory(store);

    assertStringIncludes(memory, "Current goal:");
    assertStringIncludes(memory, "- none planned");
    assertStringIncludes(memory, "Recently closed goals:");
    assertStringIncludes(memory, "Remember closed work");
    assertStringIncludes(memory, "Closed with durable proof.");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
