import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseVerificationResponse } from "../src/workers/goal_test_engineer.ts";

Deno.test("verification parser requires explicit pass verdict", () => {
  const result = parseVerificationResponse("VERIFICATION_PASSED\n- deno test passed.");

  assertEquals(result.verdict, "passed");
  assertStringIncludes(result.notes, "deno test passed");
});

Deno.test("verification parser fails closed on empty response", () => {
  const result = parseVerificationResponse("");

  assertEquals(result.verdict, "failed");
  assertStringIncludes(result.notes, "no explicit verification verdict");
});

Deno.test("verification parser fails closed on pass without proof details", () => {
  const result = parseVerificationResponse("VERIFICATION_PASSED");

  assertEquals(result.verdict, "failed");
  assertStringIncludes(result.notes, "without proof details");
});

Deno.test("verification parser fails closed on ambiguous response", () => {
  const result = parseVerificationResponse("Looks fine to me.");

  assertEquals(result.verdict, "failed");
  assertStringIncludes(result.notes, "did not start with VERIFICATION_PASSED");
  assertStringIncludes(result.notes, "Looks fine to me.");
});

Deno.test("verification parser keeps needs input verdict", () => {
  const result = parseVerificationResponse("NEEDS_INPUT\n- Which repo should receive the commit?");

  assertEquals(result.verdict, "needs_input");
  assertStringIncludes(result.notes, "Which repo");
});

Deno.test("verification accepts a single-line pass verdict with same-line proof", () => {
  const singleLine = parseVerificationResponse(
    "VERIFICATION_PASSED**Test Handoff** 1. curl /api/notes -> [] PASS 2. POST -> 201 PASS",
  );
  assertEquals(singleLine.verdict, "passed");

  const bare = parseVerificationResponse("VERIFICATION_PASSED");
  assertEquals(bare.verdict, "failed");
});
