// Merges the GoalForge status hook into coding-agent hook settings files.
// Claude Code uses ~/.claude/settings.json; Codex CLI uses ~/.codex/hooks.json.
// Both share the same event -> matcher -> command hook shape.

export const CLAUDE_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "Notification",
  "Stop",
  "SessionEnd",
] as const;

export const CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "Stop",
  "SessionEnd",
] as const;

type JsonObject = Record<string, unknown>;

interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

export function hookCommand(scriptPath: string, agent: string): string {
  return `python3 ${scriptPath} --agent ${agent}`;
}

export function mergeHookSettings(
  settings: unknown,
  events: readonly string[],
  command: string,
): { settings: JsonObject; added: string[] } {
  const base: JsonObject = isObject(settings) ? structuredClone(settings) : {};
  const hooks: JsonObject = isObject(base.hooks) ? base.hooks as JsonObject : {};
  base.hooks = hooks;
  const added: string[] = [];
  for (const event of events) {
    const entries: HookEntry[] = Array.isArray(hooks[event]) ? hooks[event] as HookEntry[] : [];
    hooks[event] = entries;
    const exists = entries.some((entry) =>
      Array.isArray(entry?.hooks) &&
      entry.hooks.some((hook) => hook?.command === command)
    );
    if (exists) {
      continue;
    }
    const entry: HookEntry = { hooks: [{ type: "command", command }] };
    if (event === "PreToolUse") {
      entry.matcher = "*";
    }
    entries.push(entry);
    added.push(event);
  }
  return { settings: base, added };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
