import { assertEquals, assertStringIncludes } from "@std/assert";
import { Task } from "../src/board/types.ts";
import { taskRecommendation } from "../src/tui/task_recommendation.ts";

const baseTask: Pick<
  Task,
  | "status"
  | "blockedReason"
  | "needsInputPrompt"
  | "nextAction"
  | "dependencyIds"
  | "validation"
  | "touchedPaths"
> = {
  status: "ready",
  blockedReason: null,
  needsInputPrompt: null,
  nextAction: "Start this task when its dependencies are done.",
  dependencyIds: [],
  validation: "",
  touchedPaths: [],
};

Deno.test("task recommendation explains ready work in user actions", () => {
  const recommendation = taskRecommendation(baseTask);

  assertEquals(recommendation.heading, "Recommended Action");
  assertStringIncludes(recommendation.action, "Click Start Task");
  assertStringIncludes(recommendation.action, "Run Ready Tasks");
});

Deno.test("task recommendation hides raw missing session errors", () => {
  const recommendation = taskRecommendation({
    ...baseTask,
    status: "blocked",
    blockedReason:
      '{"message":"JSON-RPC error -32600: no rollout found for thread id abc","traceback":"secret"}',
  });

  assertEquals(
    recommendation.summary,
    "GoalForge could not reopen a saved Codex session for this task.",
  );
  assertStringIncludes(recommendation.action, "fresh Codex session");
});

Deno.test("task recommendation tells users how to resume queued guidance", () => {
  const recommendation = taskRecommendation(
    {
      ...baseTask,
      status: "blocked",
      blockedReason: "GoalForge needs input: which repo should receive the commit?",
    },
    [{ taskId: "TASK-1", processed: false }],
  );

  assertEquals(recommendation.summary, "Guidance is queued for this task.");
  assertStringIncludes(recommendation.action, "will restart");
});

Deno.test("task recommendation blocks review when validation proof is incomplete", () => {
  const recommendation = taskRecommendation({
    ...baseTask,
    status: "review",
    validation: "GoalForge review: APPROVED",
  });

  assertStringIncludes(recommendation.summary, "Validation evidence is incomplete");
  assertStringIncludes(recommendation.action, "Do not review or merge yet");
});

Deno.test("task recommendation warns when done task has evidence gaps", () => {
  const recommendation = taskRecommendation({
    ...baseTask,
    status: "done",
    validation: "GoalForge review: APPROVED",
  });

  assertStringIncludes(recommendation.summary, "marked done, but proof is incomplete");
  assertStringIncludes(recommendation.action, "Do not clear it yet");
});
