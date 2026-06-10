import { QueuedMessage, Task } from "../board/types.ts";
import { parseValidationEvidence } from "../board/validation_evidence.ts";

export interface TaskRecommendation {
  heading: string;
  summary: string;
  action: string;
}

export function taskRecommendation(
  task: Pick<
    Task,
    | "status"
    | "blockedReason"
    | "needsInputPrompt"
    | "nextAction"
    | "dependencyIds"
    | "validation"
    | "touchedPaths"
  >,
  messages: Pick<QueuedMessage, "taskId" | "processed">[] = [],
): TaskRecommendation {
  const hasQueuedInput = messages.some((message) => !message.processed);
  if (task.status === "blocked") {
    const explanation = blockedExplanation(task.blockedReason);
    if (hasQueuedInput) {
      return {
        heading: "Recommended Action",
        summary: "Guidance is queued for this task.",
        action:
          "GoalForge will restart it with that guidance. Wait for the task to move to Working.",
      };
    }
    return {
      heading: "Recommended Action",
      summary: explanation.summary,
      action: task.needsInputPrompt || explanation.action,
    };
  }
  if (task.status === "in_progress") {
    return {
      heading: "Recommended Action",
      summary: "GoalForge is actively working this task.",
      action: "Watch Active Agents. Use Stop Task only if the run is stuck or going the wrong way.",
    };
  }
  if (task.status === "review") {
    const gaps = task.validation.trim() ? parseValidationEvidence(task.validation).gaps : [
      "missing validation evidence",
    ];
    if (gaps.length) {
      return {
        heading: "Recommended Action",
        summary: `Validation evidence is incomplete: ${gaps[0]}.`,
        action:
          "Do not review or merge yet. Restart the task or add input so GoalForge can repair the evidence.",
      };
    }
    return {
      heading: "Recommended Action",
      summary: "The implementation has validation evidence and is waiting for review.",
      action:
        "Review the changed files and validation evidence, then merge when the result is approved.",
    };
  }
  if (task.status === "merging") {
    return {
      heading: "Recommended Action",
      summary: "Review approved. GoalForge is merging this task.",
      action: "No action needed. The task moves to Done when the merge completes.",
    };
  }
  if (task.status === "done") {
    const gaps = task.validation.trim() ? parseValidationEvidence(task.validation).gaps : [
      "missing validation evidence",
    ];
    if (gaps.length) {
      return {
        heading: "Recommended Action",
        summary: `This task is marked done, but proof is incomplete: ${gaps[0]}.`,
        action: "Do not clear it yet. Run the goal evidence repair path before closing the goal.",
      };
    }
    return {
      heading: "Recommended Action",
      summary: "This task is complete and absorbed into project memory.",
      action: "Leave it for history or use Clear Done when you want a clean board.",
    };
  }
  if (task.dependencyIds.length) {
    return {
      heading: "Recommended Action",
      summary: `This task is waiting on ${task.dependencyIds.join(", ")}.`,
      action: "Run or finish the dependency tasks first.",
    };
  }
  return {
    heading: "Recommended Action",
    summary: task.nextAction || "This task is ready to start.",
    action:
      "Click Start Task to run this task, or Run Ready Tasks to let GoalForge continue the queue.",
  };
}

export function blockedExplanation(reason: string | null): { summary: string; action: string } {
  const text = extractErrorMessage(reason);
  if (text.includes("no rollout found for thread id") || text.includes("thread not found")) {
    return {
      summary: "GoalForge could not reopen a saved Codex session for this task.",
      action: "Click Start Task to retry with a fresh Codex session. No project input is needed.",
    };
  }
  if (!text) {
    return {
      summary: "GoalForge needs direction before this task can continue.",
      action: "Use Reply to send guidance. GoalForge will restart the task.",
    };
  }
  return {
    summary: text.replace(/^GoalForge needs input:\s*/i, ""),
    action: "Use Reply to send guidance. GoalForge will restart the task.",
  };
}

function extractErrorMessage(reason: string | null): string {
  const text = (reason ?? "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  const jsonStart = text.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      if (typeof parsed.message === "string") {
        return parsed.message.replace(/\s+/g, " ").trim();
      }
    } catch {
      // Fall through to text cleanup.
    }
  }
  return text.split('"traceback"')[0].replace(/[{}"\\]/g, " ").replace(/\s+/g, " ").trim();
}
