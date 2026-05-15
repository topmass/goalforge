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
    assertStringIncludes(memory, "GoalForge project memory");
    assertStringIncludes(memory, "TASK-1 [ready]");
    assertStringIncludes(memory, "deno test passed browser smoke passed");
    assertStringIncludes(memory, "worker/handoff TASK-1");
    assert(memory.length <= 8000);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
