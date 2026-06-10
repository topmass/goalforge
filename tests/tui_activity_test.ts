import { assertEquals, assertStringIncludes } from "@std/assert";
import { activityLine, displayEvents } from "../src/tui/activity.ts";

Deno.test("activity formatter explains command execution without raw protocol labels", () => {
  const line = activityLine({
    taskId: "TASK-2",
    role: "codex",
    kind: "item/started",
    message: "Started commandExecution: /bin/bash -lc 'git diff --stat'",
    createdAt: "not-a-date",
  }, [{ id: "TASK-2", title: "Fix checkout flow" }]);

  assertStringIncludes(line, "Fix checkout flow is running: git diff --stat");
});

Deno.test("activity formatter names scheduled tasks by title", () => {
  const line = activityLine({
    taskId: null,
    role: "scheduler",
    kind: "batch",
    message: "Running TASK-1, TASK-2. Independent tasks.",
    createdAt: "not-a-date",
  }, [
    { id: "TASK-1", title: "Add sign in tests" },
    { id: "TASK-2", title: "Fix checkout flow" },
  ]);

  assertStringIncludes(line, "Running ready tasks: Add sign in tests, Fix checkout flow");
});

Deno.test("activity formatter filters protocol-only events", () => {
  const visible = displayEvents([
    {
      taskId: null,
      role: "codex",
      kind: "thread/tokenUsage/updated",
      message: "Context usage updated.",
      createdAt: "not-a-date",
    },
    {
      taskId: null,
      role: "codex",
      kind: "item/completed",
      message: "Completed commandExecution: /bin/bash -lc 'deno test'",
      createdAt: "not-a-date",
    },
  ]);

  assertEquals(visible.length, 1);
  assertEquals(visible[0].kind, "item/completed");
});

Deno.test("activity formatter hides raw Codex agent text deltas", () => {
  const visible = displayEvents([
    {
      taskId: "TASK-1",
      role: "codex",
      kind: "agent",
      message: "2599: public int routeY; 2602: private static long GetAutomationAncho...",
      createdAt: "not-a-date",
    },
    {
      taskId: "TASK-1",
      role: "main-thread",
      kind: "agent",
      message: "The spec confirms there is already a SaveGameAnimationClearPatch...",
      createdAt: "not-a-date",
    },
    {
      taskId: "TASK-1",
      role: "codex",
      kind: "item/started",
      message: "Started commandExecution: /bin/bash -lc 'rg -n route DINKUM_CODE_MAP.md'",
      createdAt: "not-a-date",
    },
  ]);

  assertEquals(visible.length, 1);
  assertEquals(visible[0].kind, "item/started");
});

Deno.test("activity formatter keeps structured planner agent messages", () => {
  const visible = displayEvents([
    {
      taskId: null,
      role: "compiler",
      kind: "agent",
      message: JSON.stringify({ title: "Improve activity overview" }),
      createdAt: "not-a-date",
    },
  ]);

  assertEquals(visible.length, 1);
  assertStringIncludes(activityLine(visible[0], []), "Planner drafted: Improve activity overview");
});
