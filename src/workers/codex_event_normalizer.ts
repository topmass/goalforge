import { ActivityEventInput, AgentPhase, AgentRisk } from "../board/types.ts";

export interface NormalizedCodexEvent {
  phase: AgentPhase;
  headline: string;
  detail: string;
  risk: AgentRisk;
  turnId: string | null;
  interruptible: boolean;
  needsInputPrompt: string | null;
  shouldSteer: boolean;
  paths: string[];
}

export function normalizeCodexEvent(event: ActivityEventInput): NormalizedCodexEvent {
  const kind = event.kind;
  const message = clean(event.message);
  const turnId = extractTurnId(event.raw);
  const paths = extractPaths(event.raw);
  const failure = isFailureSignal(kind, message);

  if (kind === "turn/started") {
    return normalized("starting", "Codex turn started.", message, "none", turnId, true, paths);
  }
  if (kind === "turn/plan/updated" || kind === "item/plan/delta") {
    return normalized("planning", "Planning next steps.", message, "none", turnId, true, paths);
  }
  if (kind === "item/fileChange/patchUpdated" || kind === "turn/diff/updated") {
    return normalized(
      "editing",
      "Editing files.",
      message || formatPaths(paths),
      "none",
      turnId,
      true,
      paths,
    );
  }
  if (kind === "item/commandExecution/outputDelta" || kind === "process/outputDelta") {
    return normalized(
      inferCommandPhase(message),
      failure ? "Command output shows a failure." : "Command is running.",
      message,
      failure ? "test_failed" : "none",
      turnId,
      true,
      paths,
      failure,
    );
  }
  if (kind === "item/started") {
    return normalized(
      inferItemPhase(message),
      friendlyStartedHeadline(message),
      message,
      "none",
      turnId,
      true,
      paths,
    );
  }
  if (kind === "item/completed") {
    return normalized(
      inferItemPhase(message),
      friendlyCompletedHeadline(message),
      message,
      "none",
      turnId,
      true,
      paths,
    );
  }
  if (kind === "item/agentMessage/delta" || kind === "agent") {
    return normalized(
      "running",
      "Codex is reporting progress.",
      message,
      "none",
      turnId,
      true,
      paths,
    );
  }
  if (kind === "thread/tokenUsage/updated") {
    return normalized("running", "Context usage updated.", message, "none", turnId, true, paths);
  }
  if (kind === "turn/completed") {
    return normalized("done", "Codex turn completed.", message, "none", turnId, false, paths);
  }
  if (kind === "error" || event.role === "codex" && event.kind === "stderr") {
    return normalized(
      "blocked",
      "Codex reported an error.",
      message,
      isMissingCodexThreadText(message) ? "session" : "needs_user",
      turnId,
      false,
      paths,
      false,
      message || "Codex reported an error.",
    );
  }
  return normalized(
    "running",
    message ? "Codex is working." : "Worker is active.",
    message,
    "none",
    turnId,
    true,
    paths,
  );
}

export function isFailureSignal(kind: string, message: string): boolean {
  if (
    ![
      "output",
      "item/commandExecution/outputDelta",
      "command/exec/outputDelta",
      "process/outputDelta",
    ].includes(kind)
  ) {
    return false;
  }
  const text = message.toLowerCase();
  return /\b(failed|failure|error|exception|traceback|panic|test failed|tests failed)\b/.test(
    text,
  ) ||
    /\b(ts\d{4}|assertionerror|deno check.*error)\b/.test(text);
}

export function buildFailureSteerMessage(message: string): string {
  return [
    "GoalForge live supervisor:",
    "Recent command output looks like a real failure.",
    "Pause broad implementation. Inspect the failing output, fix the smallest relevant cause, then rerun the exact failing command before final handoff.",
    `Signal: ${message.replace(/\s+/g, " ").trim().slice(0, 500)}`,
  ].join("\n");
}

export function extractTurnId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.turnId === "string") {
    return record.turnId;
  }
  const params = record.params;
  if (params && typeof params === "object") {
    const paramsRecord = params as Record<string, unknown>;
    if (typeof paramsRecord.turnId === "string") {
      return paramsRecord.turnId;
    }
    const turn = paramsRecord.turn;
    if (turn && typeof turn === "object") {
      const turnRecord = turn as Record<string, unknown>;
      if (typeof turnRecord.id === "string") {
        return turnRecord.id;
      }
    }
  }
  return null;
}

export function isMissingCodexThreadText(message: string): boolean {
  return message.includes("no rollout found for thread id") ||
    message.includes("no thread found") ||
    message.includes("thread not found");
}

function normalized(
  phase: AgentPhase,
  headline: string,
  detail: string,
  risk: AgentRisk,
  turnId: string | null,
  interruptible: boolean,
  paths: string[],
  shouldSteer = false,
  needsInputPrompt: string | null = null,
): NormalizedCodexEvent {
  return {
    phase,
    headline,
    detail: detail || headline,
    risk,
    turnId,
    interruptible,
    paths,
    shouldSteer,
    needsInputPrompt,
  };
}

function inferCommandPhase(message: string): AgentPhase {
  const text = message.toLowerCase();
  if (/\b(test|spec|pytest|vitest|jest|deno test|pnpm test|npm test)\b/.test(text)) {
    return "testing";
  }
  return "running";
}

function inferItemPhase(message: string): AgentPhase {
  const text = message.toLowerCase();
  if (/\b(read|open|list|search|rg|grep|inspect)\b/.test(text)) {
    return "reading";
  }
  if (/\b(test|check|build|lint)\b/.test(text)) {
    return "testing";
  }
  if (/\b(write|edit|patch|apply)\b/.test(text)) {
    return "editing";
  }
  return "running";
}

function friendlyStartedHeadline(message: string): string {
  if (message.toLowerCase().includes("command")) {
    return "Started a command.";
  }
  return "Started work item.";
}

function friendlyCompletedHeadline(message: string): string {
  if (message.toLowerCase().includes("command")) {
    return "Command completed.";
  }
  return "Completed work item.";
}

function extractPaths(raw: unknown): string[] {
  const paths = new Set<string>();
  collectPaths(raw, paths);
  return [...paths].slice(0, 20);
}

function collectPaths(value: unknown, paths: Set<string>): void {
  if (!value || paths.size >= 20) {
    return;
  }
  if (typeof value === "string") {
    if (looksLikePath(value)) {
      paths.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPaths(item, paths);
    }
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (["path", "file", "filename", "filePath", "relativePath"].includes(key)) {
        collectPaths(item, paths);
      } else if (typeof item === "object") {
        collectPaths(item, paths);
      }
    }
  }
}

function looksLikePath(value: string): boolean {
  const text = value.trim();
  return /^[\w./-]+\.[\w]+$/.test(text) && !text.startsWith("http");
}

function formatPaths(paths: string[]): string {
  return paths.length ? `Files changed: ${paths.join(", ")}` : "";
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
