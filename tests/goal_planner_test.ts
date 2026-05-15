import { assertEquals } from "@std/assert";
import { parsePlannerResponse } from "../src/workers/goal_planner.ts";

Deno.test("planner parser accepts fenced JSON task lists", () => {
  const tasks = parsePlannerResponse(`Here is the plan:
\`\`\`json
[
  {
    "title": "Add queue controls",
    "description": "Add controls for sequential task execution.",
    "acceptanceCriteria": "- Queue button is visible.\\n- Queue route runs tasks.",
    "priority": 250,
    "workpad": "Can run before review automation."
  }
]
\`\`\`
`);

  assertEquals(tasks.length, 1);
  assertEquals(tasks[0].title, "Add queue controls");
  assertEquals(tasks[0].priority, 250);
});
