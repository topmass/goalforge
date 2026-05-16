import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseWorkflow } from "../src/workflow/workflow.ts";

Deno.test("workflow parser normalizes Symphony-style local kanban config", () => {
  const workflow = parseWorkflow(`---
version: 1
tracker:
  kind: goalforge-local
agent:
  max_concurrent_agents: 3
  max_turns: 2
  max_retries: 4
  retry_backoff_ms: 2500
codex:
  model: gpt-5.5
  reasoning_effort: xhigh
  fast_mode: false
workspace:
  worktrees_dir: .goalforge/worktrees
  hooks:
    before_run:
      - printf ready
    after_run: [printf done]
---
# Custom Workflow

Keep the local Kanban as the tracker.
`);

  assertEquals(workflow.trackerKind, "goalforge-local");
  assertEquals(workflow.maxConcurrentAgents, 3);
  assertEquals(workflow.maxTurns, 2);
  assertEquals(workflow.maxRetries, 4);
  assertEquals(workflow.retryBackoffMs, 2500);
  assertEquals(workflow.reasoningEffort, "xhigh");
  assertEquals(workflow.fastMode, false);
  assertEquals(workflow.hooks.before_run[0].command, "printf ready");
  assertEquals(workflow.hooks.after_run[0].command, "printf done");
  assertStringIncludes(workflow.instructions, "Custom Workflow");
});
