import { assertEquals } from "@std/assert";
import { parseValidationEvidence } from "../src/board/validation_evidence.ts";

Deno.test("validation evidence parser extracts successful LoopForge task proof", () => {
  const evidence = parseValidationEvidence([
    "Codex App Server turn completed.",
    "Turn: turn-1",
    "Turn status: completed",
    "Test turn: turn-test",
    "Test turn status: completed",
    "Discovered verification gates:",
    "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
    "",
    "Verification verdict:",
    "VERIFICATION_PASSED",
    "- Focused validation passed with recorded proof.",
    "Commit: abc123",
    "Git status:",
    "clean",
    "",
    "LoopForge review: APPROVED",
  ].join("\n"));

  assertEquals(evidence.implementationCompleted, true);
  assertEquals(evidence.testCompleted, true);
  assertEquals(evidence.verificationGatesRecorded, true);
  assertEquals(evidence.verificationGates, [
    "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
  ]);
  assertEquals(evidence.verificationPassed, true);
  assertEquals(evidence.verificationHasProofDetails, true);
  assertEquals(evidence.verificationProofDetails, [
    "- Focused validation passed with recorded proof.",
  ]);
  assertEquals(evidence.commitCreated, true);
  assertEquals(evidence.reviewApproved, true);
  assertEquals(evidence.finalGitClean, true);
  assertEquals(evidence.gaps, []);
});

Deno.test("validation evidence parser rejects bare verification pass", () => {
  const evidence = parseValidationEvidence([
    "Turn status: completed",
    "Test turn status: completed",
    "Discovered verification gates:",
    "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
    "",
    "Verification verdict:",
    "VERIFICATION_PASSED",
    "Commit: abc123",
    "Git status:",
    "clean",
    "LoopForge review: APPROVED",
  ].join("\n"));

  assertEquals(evidence.verificationPassed, true);
  assertEquals(evidence.verificationHasProofDetails, false);
  assertEquals(evidence.gaps, ["verification verdict missing proof details"]);
});

Deno.test("validation evidence parser accepts pass token followed by same-line prose", () => {
  const evidence = parseValidationEvidence([
    "Turn status: completed",
    "Test turn status: completed",
    "Discovered verification gates:",
    "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
    "",
    "Verification verdict:",
    "VERIFICATION_PASSEDTask acceptance criteria are satisfied.",
    "- Inspected marker file and confirmed exact content.",
    "Commit: abc123",
    "Git status:",
    "clean",
    "LoopForge review: APPROVED",
  ].join("\n"));

  assertEquals(evidence.verificationPassed, true);
  assertEquals(evidence.verificationHasProofDetails, true);
  assertEquals(evidence.gaps, []);
});

Deno.test("validation evidence parser counts same-line pass prose as proof", () => {
  const evidence = parseValidationEvidence([
    "Turn status: completed",
    "Test turn status: completed",
    "Discovered verification gates:",
    "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
    "",
    "Verification verdict:",
    "VERIFICATION_PASSEDVerified marker file bytes with cmp.",
    "Commit: abc123",
    "Git status:",
    "clean",
    "LoopForge review: APPROVED",
  ].join("\n"));

  assertEquals(evidence.verificationPassed, true);
  assertEquals(evidence.verificationHasProofDetails, true);
  assertEquals(evidence.verificationProofDetails, ["Verified marker file bytes with cmp."]);
  assertEquals(evidence.gaps, []);
});

Deno.test("validation evidence parser reports missing completion proof", () => {
  const evidence = parseValidationEvidence(
    "LoopForge review: CHANGES_REQUESTED\nCommit: not created",
  );

  assertEquals(evidence.implementationCompleted, false);
  assertEquals(evidence.testCompleted, false);
  assertEquals(evidence.commitCreated, false);
  assertEquals(evidence.reviewApproved, false);
  assertEquals(evidence.finalGitClean, false);
  assertEquals(evidence.gaps, [
    "missing implementation turn status",
    "missing test turn status",
    "missing discovered verification gates",
    "missing verification verdict",
    "commit not created: not created",
    "review CHANGES_REQUESTED",
    "missing final git status",
  ]);
});

Deno.test("evidence accepts commit not needed for evidence-only tasks", () => {
  const evidence = parseValidationEvidence([
    "Turn status: completed",
    "Test turn status: completed",
    "Discovered verification gates:",
    "- Diff inspection: git diff --stat - sanity check.",
    "Verification verdict:",
    "VERIFICATION_PASSED",
    "- Contract clauses proved with recorded curl transcripts.",
    "Commit: not needed (no file changes)",
    "Git status:",
    "clean",
    "LoopForge review: APPROVED",
  ].join("\n"));
  assertEquals(evidence.commitCreated, true);
  assertEquals(evidence.gaps, []);
});
