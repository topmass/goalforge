import { assert, assertEquals } from "@std/assert";
import { CLAUDE_HOOK_EVENTS, hookCommand, mergeHookSettings } from "../src/workers/agent_hooks.ts";

Deno.test("mergeHookSettings adds the hook to every event once", () => {
  const command = hookCommand("/repo/scripts/hooks/goalforge_agent_hook.py", "claude-code");
  const first = mergeHookSettings({}, CLAUDE_HOOK_EVENTS, command);
  assertEquals(first.added, [...CLAUDE_HOOK_EVENTS]);
  const hooks = first.settings.hooks as Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>
  >;
  assertEquals(hooks.SessionStart[0].hooks[0], { type: "command", command });
  assertEquals(hooks.PreToolUse[0].matcher, "*");
  assertEquals(hooks.SessionStart[0].matcher, undefined);

  const second = mergeHookSettings(first.settings, CLAUDE_HOOK_EVENTS, command);
  assertEquals(second.added, []);
  const again = second.settings.hooks as Record<string, unknown[]>;
  assertEquals(again.SessionStart.length, 1);
});

Deno.test("mergeHookSettings preserves existing unrelated hooks", () => {
  const existing = {
    permissions: { allow: ["Bash(ls:*)"] },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
  };
  const command = hookCommand("/repo/hook.py", "claude-code");
  const result = mergeHookSettings(existing, ["Stop"], command);
  assertEquals(result.added, ["Stop"]);
  const stop = (result.settings.hooks as Record<string, Array<{ hooks: unknown[] }>>).Stop;
  assertEquals(stop.length, 2);
  assertEquals(result.settings.permissions, { allow: ["Bash(ls:*)"] });
  assert(JSON.stringify(stop[0]).includes("say done"));
});
