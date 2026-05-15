import { assertEquals } from "@std/assert";
import { Task } from "../src/board/types.ts";
import { parseSchedulerResponse } from "../src/workers/goal_scheduler.ts";

Deno.test("scheduler parser keeps allowed task ids up to concurrency", () => {
  const tasks = [task("TASK-1"), task("TASK-2"), task("TASK-3")];
  const decision = parseSchedulerResponse(
    JSON.stringify({
      taskIds: ["TASK-1", "TASK-3", "TASK-404"],
      notes: "TASK-1 and TASK-3 do not overlap.",
    }),
    tasks,
    2,
  );

  assertEquals(decision.taskIds, ["TASK-1", "TASK-3"]);
  assertEquals(decision.notes, "TASK-1 and TASK-3 do not overlap.");
});

function task(id: string): Task {
  return {
    id,
    goalId: "GOAL-1",
    title: id,
    description: id,
    status: "ready",
    priority: 100,
    branchName: null,
    worktreePath: null,
    workpad: "",
    acceptanceCriteria: "",
    validation: "",
    blockedReason: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
