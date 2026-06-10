import { assertEquals } from "@std/assert";
import { normalizeCodexEvent } from "../src/workers/codex_event_normalizer.ts";

Deno.test("codex event normalizer maps native notifications to agent phases", () => {
  const started = normalizeCodexEvent({
    taskId: null,
    runId: null,
    role: "codex",
    kind: "turn/started",
    message: "Started Codex turn turn-1.",
    raw: { params: { turn: { id: "turn-1" } } },
  });
  assertEquals(started.phase, "starting");
  assertEquals(started.turnId, "turn-1");
  assertEquals(started.interruptible, true);

  const failure = normalizeCodexEvent({
    taskId: null,
    runId: null,
    role: "codex",
    kind: "item/commandExecution/outputDelta",
    message: "deno test failed with AssertionError",
    raw: { params: { path: "src/example.ts" } },
  });
  assertEquals(failure.phase, "testing");
  assertEquals(failure.risk, "test_failed");
  assertEquals(failure.shouldSteer, true);
  assertEquals(failure.paths, ["src/example.ts"]);

  const edit = normalizeCodexEvent({
    taskId: null,
    runId: null,
    role: "codex",
    kind: "item/fileChange/patchUpdated",
    message: "",
    raw: { params: { filePath: "src/app.ts" } },
  });
  assertEquals(edit.phase, "editing");
  assertEquals(edit.paths, ["src/app.ts"]);
});
