import { assertEquals, assertStringIncludes } from "@std/assert";
import { GoalTestEngineer, parseVerificationResponse } from "../src/workers/goal_test_engineer.ts";
import type { CodexSession, CodexTurnResult } from "../src/workers/codex_app_server.ts";
import type { Task } from "../src/board/types.ts";

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

Deno.test("verification accepts narrated and emphasized verdicts but fails closed on conflicts", () => {
  const narrated = parseVerificationResponse(
    "Files exist, 109 lines total. Let me run the full verification.**VERIFICATION_PASSED**All 4 acceptance tests passed with curl transcripts recorded.",
  );
  assertEquals(narrated.verdict, "passed");

  const failedNarrated = parseVerificationResponse(
    "The build broke.\n\n**VERIFICATION_FAILED**\n- deno check reports TS2304.",
  );
  assertEquals(failedNarrated.verdict, "failed");

  const conflicting = parseVerificationResponse(
    "I will answer VERIFICATION_PASSED or VERIFICATION_FAILED. VERIFICATION_PASSED maybe.",
  );
  assertEquals(conflicting.verdict, "failed");
});

Deno.test("test engineer prompt reserves NEEDS_INPUT for absolute blockers", async () => {
  const engineer = new GoalTestEngineer("", "", "", "");
  let captured = "";
  const client = {
    runTurn: (_session: CodexSession, input: { title: string; prompt: string }) => {
      captured = input.prompt;
      return Promise.resolve({} as CodexTurnResult);
    },
  };
  await engineer.run(
    client,
    {} as CodexSession,
    {
      id: "TASK-9",
      title: "Fix shop rebuy",
      description: "Patch the rebuy handler.",
      riskLevel: "low",
      dependencyIds: [],
      acceptanceCriteria: "",
      verificationPlan: "",
    } as unknown as Task,
  );
  assertStringIncludes(captured, "Autonomous Operation");
  assertStringIncludes(captured, "never NEEDS_INPUT");
  assertStringIncludes(captured, "needs manual verification");
});

Deno.test("test engineer prompt states the unattended run mode", async () => {
  const engineer = new GoalTestEngineer("", "", "", "", { runMode: "unattended" });
  let captured = "";
  const client = {
    runTurn: (_session: CodexSession, input: { title: string; prompt: string }) => {
      captured = input.prompt;
      return Promise.resolve({} as CodexTurnResult);
    },
  };
  await engineer.run(
    client,
    {} as CodexSession,
    { id: "TASK-9", title: "t", description: "d", riskLevel: "low", dependencyIds: [] } as unknown as Task,
  );
  assertStringIncludes(captured, "Run mode: UNATTENDED");
});
