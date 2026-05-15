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

Deno.test("planner parser accepts one compiled prompt object", () => {
  const tasks = parsePlannerResponse(JSON.stringify({
    title: "Build activity feed",
    prompt: "Implement an activity feed and validate it.",
    acceptanceCriteria: "- Feed renders.\n- Validation passes.",
    priority: 900,
    workpad: "Independent feature.",
  }));

  assertEquals(tasks.length, 1);
  assertEquals(tasks[0].description, "Implement an activity feed and validate it.");
  assertEquals(tasks[0].workpad, "Independent feature.");
});
