import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { fingerprintBlocker, parseTriageResponse } from "../src/workers/blocker_triage.ts";

Deno.test("triage parser accepts resolve with an allowed action", () => {
  const decision = parseTriageResponse(
    "TRIAGE_RESOLVE publish\nThe task only needs the harness to push.",
    ["publish"],
  );
  assertEquals(decision.verdict, "resolve");
  assertEquals(decision.action, "publish");
  assertEquals(decision.message, "The task only needs the harness to push.");
});

Deno.test("triage parser escalates resolve with a disallowed action", () => {
  const decision = parseTriageResponse("TRIAGE_RESOLVE deploy\nShip it.", ["publish"]);
  assertEquals(decision.verdict, "escalate");
  assertEquals(decision.action, null);
});

Deno.test("triage parser accepts retry with instructions and rejects empty retry", () => {
  const retry = parseTriageResponse(
    "TRIAGE_RETRY\nThe test command is deno task test, not npm test.",
    [],
  );
  assertEquals(retry.verdict, "retry");
  assertEquals(retry.message, "The test command is deno task test, not npm test.");

  const empty = parseTriageResponse("TRIAGE_RETRY\n", []);
  assertEquals(empty.verdict, "escalate");
});

Deno.test("triage parser escalates with the compressed ask and fails closed on garbage", () => {
  const escalate = parseTriageResponse(
    "Some preamble the model added.\nTRIAGE_ESCALATE\nProvide CLERK_SECRET_KEY via Reply.",
    ["publish"],
  );
  assertEquals(escalate.verdict, "escalate");
  assertEquals(escalate.message, "Provide CLERK_SECRET_KEY via Reply.");

  const garbage = parseTriageResponse("I think we should probably retry this task.", ["publish"]);
  assertEquals(garbage.verdict, "escalate");
  assertEquals(garbage.message, "");
});

Deno.test("blocker fingerprints ignore volatile details but track real differences", () => {
  const first = fingerprintBlocker(
    "NEEDS_INPUT branch goalforge/task-1 is 6 commits behind origin/main at abc1234.\nPath /tmp/x1/repo has no changes.",
  );
  const second = fingerprintBlocker(
    "NEEDS_INPUT branch goalforge/task-1 is 9 commits behind origin/main at ffe9921.\nPath /tmp/zz9/repo has no changes.",
  );
  assertEquals(first, second);

  const different = fingerprintBlocker("NEEDS_INPUT missing CLERK_SECRET_KEY for Clerk setup.");
  assertNotEquals(first, different);
  assert(first.length <= 240);
});
