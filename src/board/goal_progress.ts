import { BoardSnapshot, Goal } from "./types.ts";
import { parseValidationEvidence } from "./validation_evidence.ts";

export interface GoalProgress {
  goal: Goal;
  total: number;
  ready: number;
  working: number;
  needsInput: number;
  review: number;
  done: number;
  missingValidation: number;
  missingApprovedReview: number;
  missingHandoff: number;
  contractGaps: string[];
  evidenceGaps: string[];
  percentDone: number;
  status: string;
  completionVerdict: string;
  completionReady: boolean;
  completionReason: string;
  nextAction: string;
  probesTotal: number;
  probesPassed: number;
}

export interface ClosedGoalSummary {
  id: string;
  text: string;
  closedAt: string | null;
  closureSummary: string;
}

export function summarizeGoalProgress(
  board: BoardSnapshot,
  goalId?: string,
): GoalProgress | null {
  const goal = activeGoal(board, goalId);
  if (!goal) {
    return null;
  }
  const tasks = board.tasks.filter((task) => task.goalId === goal.id);
  const ready = tasks.filter((task) => task.status === "ready" || task.status === "inbox").length;
  const working =
    tasks.filter((task) => task.status === "in_progress" || task.status === "merging").length;
  const needsInput = tasks.filter((task) => task.status === "blocked").length;
  const review = tasks.filter((task) => task.status === "review").length;
  const done = tasks.filter((task) => task.status === "done").length;
  const total = tasks.length;
  const missingValidation =
    tasks.filter((task) =>
      (task.status === "review" || task.status === "done") && !task.validation.trim()
    ).length;
  const missingApprovedReview =
    tasks.filter((task) =>
      task.status === "done" && !parseValidationEvidence(task.validation).reviewApproved
    ).length;
  const missingHandoff =
    tasks.filter((task) =>
      task.status === "done" && !task.handoffSummary.trim() && !task.taskCard.trim()
    ).length;
  const probes = (board.probes ?? []).filter((probe) => probe.goalId === goal.id);
  const probeGaps = tasks.length && tasks.every((task) => task.status === "done")
    ? probes
      .filter((probe) => probe.lastStatus !== "passed")
      .map((probe) =>
        probe.lastStatus === "failed"
          ? `Win condition failing: ${probe.label}.`
          : `Win condition not yet checked: ${probe.label}. Run loopforge check.`
      )
    : [];
  // Executable probes supersede prose contract token-matching when present.
  const contractGaps = probes.length ? probeGaps : goalContractGaps(goal, tasks);
  const evidenceGaps = [...goalEvidenceGaps(tasks), ...contractGaps];
  const status = goalStatus({
    total,
    ready,
    working,
    needsInput,
    review,
    done,
    evidenceGaps: evidenceGaps.length,
  });
  const completion = goalCompletionVerdict({
    total,
    ready,
    working,
    needsInput,
    review,
    done,
    evidenceGaps: evidenceGaps.length,
  });
  const nextTask = tasks.find((task) => task.status === "blocked") ??
    tasks.find((task) => task.status === "in_progress") ??
    tasks.find((task) => task.status === "review") ??
    tasks.find((task) => task.status === "ready" || task.status === "inbox") ??
    tasks.at(-1);

  return {
    goal,
    total,
    ready,
    working,
    needsInput,
    review,
    done,
    missingValidation,
    missingApprovedReview,
    missingHandoff,
    contractGaps,
    evidenceGaps,
    percentDone: total ? Math.round((done / total) * 100) : 0,
    status,
    completionVerdict: completion.verdict,
    completionReady: completion.ready,
    completionReason: completion.reason,
    nextAction: nextTask?.nextAction || "No next action recorded.",
    probesTotal: probes.length,
    probesPassed: probes.filter((probe) => probe.lastStatus === "passed").length,
  };
}

export function summarizeClosedGoals(board: BoardSnapshot, limit = 3): ClosedGoalSummary[] {
  return [...board.goals]
    .filter((goal) => goal.status === "closed")
    .sort((left, right) => (right.closedAt ?? "").localeCompare(left.closedAt ?? ""))
    .slice(0, limit)
    .map((goal) => ({
      id: goal.id,
      text: goal.text,
      closedAt: goal.closedAt,
      closureSummary: goal.closureSummary,
    }));
}

function activeGoal(board: BoardSnapshot, goalId?: string): Goal | null {
  if (goalId) {
    return board.goals.find((goal) => goal.id === goalId) ?? null;
  }
  return [...board.goals].reverse().find((goal) =>
    goal.status === "open" &&
    board.tasks.some((task) => task.goalId === goal.id && task.status !== "done")
  ) ?? [...board.goals].reverse().find((goal) => goal.status === "open") ?? null;
}

function goalStatus(counts: {
  total: number;
  ready: number;
  working: number;
  needsInput: number;
  review: number;
  done: number;
  evidenceGaps: number;
}): string {
  if (!counts.total) return "No tasks planned";
  if (counts.done === counts.total && counts.evidenceGaps) return "Evidence Missing";
  if (counts.done === counts.total) return "Complete";
  if (counts.needsInput) return "Needs Input";
  if (counts.working) return "Working";
  if (counts.review) return "Needs Review";
  if (counts.ready) return "Ready";
  return "Waiting";
}

function goalCompletionVerdict(counts: {
  total: number;
  ready: number;
  working: number;
  needsInput: number;
  review: number;
  done: number;
  evidenceGaps: number;
}): { verdict: string; ready: boolean; reason: string } {
  if (!counts.total) {
    return {
      verdict: "Not Planned",
      ready: false,
      reason: "No tasks exist for this goal yet.",
    };
  }
  if (counts.done === counts.total && counts.evidenceGaps === 0) {
    return {
      verdict: "Ready To Close",
      ready: true,
      reason:
        "All tasks are done and required validation, review, git, and handoff evidence is present.",
    };
  }
  if (counts.done === counts.total) {
    return {
      verdict: "Evidence Missing",
      ready: false,
      reason: "All tasks are done, but completion evidence is incomplete.",
    };
  }
  if (counts.needsInput) {
    return {
      verdict: "Needs Input",
      ready: false,
      reason: `${counts.needsInput} task${
        counts.needsInput === 1 ? "" : "s"
      } need direction before the goal can finish.`,
    };
  }
  if (counts.review) {
    return {
      verdict: "Needs Review",
      ready: false,
      reason: `${counts.review} task${
        counts.review === 1 ? "" : "s"
      } are waiting for review or merge.`,
    };
  }
  if (counts.working) {
    return {
      verdict: "In Progress",
      ready: false,
      reason: `${counts.working} task${counts.working === 1 ? "" : "s"} are currently running.`,
    };
  }
  return {
    verdict: "Ready To Run",
    ready: false,
    reason: `${counts.ready} task${counts.ready === 1 ? " is" : "s are"} ready to start.`,
  };
}

function goalEvidenceGaps(tasks: BoardSnapshot["tasks"]): string[] {
  if (!tasks.length) {
    return ["No tasks have been planned for this goal."];
  }
  return tasks.flatMap((task) => {
    const gaps: string[] = [];
    if ((task.status === "review" || task.status === "done") && !task.validation.trim()) {
      const gap = `${task.id} has no validation evidence.`;
      if (!evidenceGapHasRepairProof(gap, tasks)) {
        gaps.push(gap);
      }
    }
    if (task.status === "done") {
      const evidence = parseValidationEvidence(task.validation);
      for (const gap of evidence.gaps) {
        const taskGap = `${task.id} evidence gap: ${gap}.`;
        if (!evidenceGapHasRepairProof(taskGap, tasks)) {
          gaps.push(taskGap);
        }
      }
    }
    if (task.status === "done" && !task.handoffSummary.trim() && !task.taskCard.trim()) {
      const gap = `${task.id} is done but has no compact handoff or task card.`;
      if (!evidenceGapHasRepairProof(gap, tasks)) {
        gaps.push(gap);
      }
    }
    return gaps;
  });
}

function evidenceGapHasRepairProof(gap: string, tasks: BoardSnapshot["tasks"]): boolean {
  const proofText = tasks.map((task) =>
    [
      task.validation,
      task.handoffSummary,
      task.verificationSummary,
    ].join(" ")
  ).join(" ").toLowerCase();
  return proofText.includes(gap.toLowerCase());
}

function goalContractGaps(goal: Goal, tasks: BoardSnapshot["tasks"]): string[] {
  const clauses = contractClauses(goal.completionContract);
  if (!clauses.length || tasks.some((task) => task.status !== "done")) {
    return [];
  }
  const evidenceText = tasks.map((task) =>
    [
      task.validation,
      task.handoffSummary,
      task.verificationSummary,
    ].join(" ")
  ).join(" ").toLowerCase();
  return clauses
    .filter((clause) => !contractClauseHasEvidence(clause, evidenceText))
    .map((clause) => `Goal contract gap: no recorded evidence for "${shortClause(clause)}".`);
}

function contractClauses(contract: string): string[] {
  return contract
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter((line) => line.length >= 12)
    .filter((line) => !isGeneratedContractBoilerplate(line));
}

function isGeneratedContractBoilerplate(line: string): boolean {
  const normalized = line.toLowerCase();
  return normalized.startsWith("goal:") ||
    normalized.includes("planned task") && normalized.includes("done") ||
    normalized.includes("every done task") && normalized.includes("validation") ||
    normalized.includes("project memory") && normalized.includes("remaining risk") ||
    normalized.includes("loopforge may close") ||
    normalized.includes("complete every planned task") ||
    normalized.includes("validate, review, commit") && normalized.includes("handoff evidence");
}

function contractClauseHasEvidence(clause: string, evidenceText: string): boolean {
  const tokens = significantTokens(clause);
  if (!tokens.length) {
    return true;
  }
  const required = Math.min(tokens.length, Math.max(2, Math.ceil(tokens.length * 0.6)));
  const matched = tokens.filter((token) => evidenceText.includes(token)).length;
  return matched >= required;
}

function significantTokens(value: string): string[] {
  const stopwords = new Set([
    "able",
    "about",
    "after",
    "again",
    "against",
    "before",
    "being",
    "build",
    "check",
    "done",
    "each",
    "every",
    "from",
    "goal",
    "have",
    "into",
    "must",
    "only",
    "pass",
    "show",
    "that",
    "their",
    "then",
    "this",
    "through",
    "user",
    "when",
    "with",
    "work",
  ]);
  return [
    ...new Set(
      value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) ?? [],
    ),
  ].filter((token) => !stopwords.has(token));
}

function shortClause(clause: string): string {
  const text = clause.replace(/\s+/g, " ").trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
