import { assertEquals } from "@std/assert";
import { parseReviewResponse } from "../src/workers/goal_reviewer.ts";

Deno.test("review parser detects requested changes", () => {
  const result = parseReviewResponse("CHANGES_REQUESTED\n- Missing validation.");
  assertEquals(result.verdict, "changes_requested");
});

Deno.test("review parser treats approved reviews as approved", () => {
  const result = parseReviewResponse("APPROVED\n- Validation covers the task.");
  assertEquals(result.verdict, "approved");
});
