import { ActivityEventInput } from "../board/types.ts";

const HIDDEN_KINDS = new Set([
  "agent",
  "reasoning",
  "thread/tokenUsage/updated",
  "mcpServer/startupStatus/updated",
]);

export function shouldRecordActivity(event: ActivityEventInput): boolean {
  const message = event.message.trim();
  if (!message) {
    return false;
  }
  if (HIDDEN_KINDS.has(event.kind)) {
    return false;
  }
  if (message === "Token usage updated.") {
    return false;
  }
  if (message.startsWith("Codex event: mcpServer/")) {
    return false;
  }
  return true;
}
