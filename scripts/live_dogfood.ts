import { BoardStore } from "../src/board/store.ts";
import { summarizeGoalProgress } from "../src/board/goal_progress.ts";
import { LoopForgeWorker } from "../src/workers/loopforge_worker.ts";
import { parseValidationEvidence } from "../src/board/validation_evidence.ts";

const KEEP = Deno.args.includes("--keep");
const TIMEOUT_MS = numberArg("--timeout-ms") ?? 10 * 60 * 1000;
const MARKER = "LOOPFORGE_LIVE_DOGFOOD_OK";

const root = await Deno.makeTempDir({ prefix: "loopforge-live-dogfood-" });
let keepRoot = KEEP;

try {
  await seedFixture(root);
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, tasks } = store.createGoalWithTasks("LoopForge live dogfood", [{
      title: "Write live dogfood marker",
      description: [
        "This is a LoopForge live dogfood task running through the production Codex bridge.",
        `Create a file named loopforge-live-marker.txt containing exactly ${MARKER} and a trailing newline.`,
        "Do not change unrelated files.",
      ].join("\n"),
      acceptanceCriteria: [
        `- loopforge-live-marker.txt exists in the project root after merge.`,
        `- loopforge-live-marker.txt contains exactly ${MARKER}.`,
        "- Validation records the file inspection and git status.",
      ].join("\n"),
      priority: 100,
      riskLevel: "low",
      verificationPlan: [
        "- Inspect loopforge-live-marker.txt.",
        `- Confirm its exact content is ${MARKER}.`,
        "- Run git diff --check.",
        "- Record the exact observed result.",
      ].join("\n"),
      workpad: "Live dogfood fixture. Keep the change scoped to the marker file.",
    }]);

    console.log(`live_project: ${root}`);
    console.log(`live_goal: ${goal.id}`);
    console.log(`live_task: ${tasks[0].id}`);

    const worker = new LoopForgeWorker(root, store, {
      onEvent: (event) => {
        if (["transition", "repair", "close", "error", "contract-gap"].includes(event.kind)) {
          console.log(`live_event: ${event.role}/${event.kind} ${event.message}`);
        }
      },
    });

    const timeout = startHardTimeout(root, TIMEOUT_MS);
    try {
      await worker.runQueue();
    } finally {
      clearTimeout(timeout);
    }

    const board = store.getBoard();
    const task = board.tasks[0];
    const progress = summarizeGoalProgress(board, goal.id);
    const evidence = parseValidationEvidence(task.validation);
    const markerText = await Deno.readTextFile(`${root}/loopforge-live-marker.txt`).catch(() => "");
    const checks = {
      live_task_done: task.status === "done",
      live_goal_closed: store.getGoal(goal.id).status === "closed",
      live_marker_file: markerText === `${MARKER}\n`,
      live_verification_passed: evidence.verificationPassed,
      live_commit_recorded: evidence.commitCreated,
      live_review_approved: evidence.reviewApproved,
      live_git_clean: evidence.finalGitClean,
      live_no_evidence_gaps: (progress?.evidenceGaps.length ?? 1) === 0,
    };

    for (const [name, ok] of Object.entries(checks)) {
      console.log(`${name}: ${ok ? "ok" : "failed"}`);
    }

    if (!Object.values(checks).every(Boolean)) {
      keepRoot = true;
      printFailureDetails(board, progress?.evidenceGaps ?? []);
      throw new Error("LoopForge live dogfood gate failed.");
    }

    console.log("live_result: passed");
  } finally {
    store.close();
  }
} catch (error) {
  keepRoot = true;
  const message = error instanceof Error ? error.message : String(error);
  console.error(`live_result: failed: ${message}`);
  Deno.exitCode = 1;
} finally {
  if (keepRoot) {
    console.log(`live_project_kept: ${root}`);
  } else {
    await Deno.remove(root, { recursive: true });
  }
}

async function seedFixture(target: string): Promise<void> {
  await Deno.writeTextFile(
    `${target}/AGENTS.md`,
    [
      "# LoopForge Live Dogfood Fixture",
      "",
      "- Keep edits scoped to the assigned task.",
      "- Do not change `.loopforge` runtime state directly.",
      "- Use `git diff --check` as the focused validation command.",
    ].join("\n"),
  );
  await Deno.writeTextFile(
    `${target}/WORKFLOW.md`,
    [
      "---",
      "version: 1",
      "tracker:",
      "  kind: loopforge-local",
      "agent:",
      "  max_concurrent_agents: 1",
      "  max_turns: 2",
      "  max_retries: 1",
      "  retry_backoff_ms: 1",
      "codex:",
      "  model: gpt-5.5",
      "  reasoning_effort: medium",
      "  fast_mode: true",
      "workspace:",
      "  worktrees_dir: .loopforge/worktrees",
      "  hooks:",
      "    before_run: []",
      "    after_run: []",
      "---",
      "# Live Dogfood Workflow",
      "",
      "Run the smallest reliable validation for the marker-file task.",
    ].join("\n"),
  );
  await Deno.writeTextFile(`${target}/README.md`, "# LoopForge live dogfood fixture\n");
  await git(target, ["init", "-b", "main"]);
  await git(target, ["add", "."]);
  await git(target, ["commit", "-m", "seed live dogfood fixture"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const output = await new Deno.Command("git", {
    args: [
      "-c",
      "user.email=loopforge-live@example.com",
      "-c",
      "user.name=LoopForge Live Dogfood",
      ...args,
    ],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
}

function startHardTimeout(projectRoot: string, timeoutMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    console.error(`live_result: failed: timed out after ${timeoutMs}ms.`);
    console.log(`live_project_kept: ${projectRoot}`);
    Deno.exit(1);
  }, timeoutMs);
}

function numberArg(name: string): number | null {
  const index = Deno.args.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = Number(Deno.args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function printFailureDetails(
  board: ReturnType<BoardStore["getBoard"]>,
  evidenceGaps: string[],
): void {
  const task = board.tasks[0];
  console.log(`live_task_status: ${task?.status ?? "missing"}`);
  console.log(`live_task_blocked: ${task?.blockedReason ?? "none"}`);
  console.log(`live_task_validation: ${short(task?.validation ?? "none")}`);
  console.log(`live_evidence_gaps: ${evidenceGaps.join(" | ") || "none"}`);
  for (const event of board.events.slice(-8)) {
    console.log(`live_recent_event: ${event.role}/${event.kind} ${short(event.message)}`);
  }
}

function short(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}
