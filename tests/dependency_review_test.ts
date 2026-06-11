import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDependencyReviewPrompt,
  parseDependencyReview,
} from "../src/workers/dependency_review.ts";
import type { Task } from "../src/board/types.ts";

function task(id: string, status: string, deps: string[] = []): Task {
  return {
    id,
    status,
    title: `Title ${id}`,
    description: `Description ${id}`,
    dependencyIds: deps,
  } as unknown as Task;
}

Deno.test("dependency review prompt lists the board and the rewritable ids", () => {
  const gated = [task("TASK-3", "ready", ["TASK-2"])];
  const unfinished = [task("TASK-2", "in_progress"), gated[0]];
  const prompt = buildDependencyReviewPrompt(gated, unfinished);
  assertStringIncludes(prompt, "PARALLELISM IS THE DEFAULT");
  assertStringIncludes(prompt, "TASK-2 [in_progress]");
  assertStringIncludes(prompt, "Re-judge dependsOn for these tasks only: TASK-3");
  assertStringIncludes(prompt, '{"dependencies"');
});

Deno.test("dependency review parser accepts fenced JSON and filters unknown ids", () => {
  const current = new Map([["TASK-3", ["TASK-2"]], ["TASK-2", []]]);
  const reviewed = parseDependencyReview(
    '```json\n{"dependencies": {"TASK-3": ["TASK-9", "TASK-2", "TASK-3"], "TASK-2": []}}\n```',
    ["TASK-3"],
    ["TASK-2", "TASK-3"],
    current,
  );
  assert(reviewed);
  assertEquals(reviewed.size, 1);
  assertEquals(reviewed.get("TASK-3"), ["TASK-2"]);
});

Deno.test("dependency review parser fails closed on garbage and cycles", () => {
  const current = new Map([["TASK-2", ["TASK-3"]], ["TASK-3", ["TASK-2"]]]);
  assertEquals(
    parseDependencyReview("I think they look fine.", ["TASK-3"], ["TASK-2", "TASK-3"], current),
    null,
  );
  assertEquals(
    parseDependencyReview(
      '{"dependencies": {"TASK-3": ["TASK-2"]}}',
      ["TASK-3"],
      ["TASK-2", "TASK-3"],
      current,
    ),
    null,
  );
});

Deno.test("dependency review parser unchains a stale sequential plan", () => {
  const current = new Map<string, string[]>([
    ["TASK-2", []],
    ["TASK-3", ["TASK-2"]],
    ["TASK-4", ["TASK-3"]],
    ["TASK-5", ["TASK-4"]],
  ]);
  const reviewed = parseDependencyReview(
    '{"dependencies": {"TASK-3": [], "TASK-4": [], "TASK-5": ["TASK-2", "TASK-3", "TASK-4"]}}',
    ["TASK-3", "TASK-4", "TASK-5"],
    ["TASK-2", "TASK-3", "TASK-4", "TASK-5"],
    current,
  );
  assert(reviewed);
  assertEquals(reviewed.get("TASK-3"), []);
  assertEquals(reviewed.get("TASK-4"), []);
  assertEquals(reviewed.get("TASK-5"), ["TASK-2", "TASK-3", "TASK-4"]);
});
