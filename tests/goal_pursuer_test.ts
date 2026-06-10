import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import {
  CodexClient,
  CodexSession,
  CodexSessionOptions,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";
import { GoalPursuer } from "../src/workers/goal_pursuer.ts";

// Scripted agent for the pursue loop: worker turns create the file named in
// the task title (when asked), the replan turn plans exactly that task from
// the failing probe output, and verification/review always approve.
class PursueScriptedCodexClient implements CodexClient {
  constructor(
    private readonly onEvent: (event: {
      taskId: string | null;
      runId: string | null;
      role: string;
      kind: string;
      message: string;
    }) => void,
    private readonly counters: { replans: number; implementations: number },
  ) {}

  startSession(cwd: string, _options: CodexSessionOptions = {}): Promise<CodexSession> {
    return Promise.resolve({ threadId: "thread-pursue", cwd });
  }

  resumeSession(
    cwd: string,
    threadId: string,
    _options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  forkSession(
    cwd: string,
    _threadId: string,
    _options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    return Promise.resolve({ threadId: `thread-${crypto.randomUUID().slice(0, 8)}`, cwd });
  }

  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    const reply = (message: string) =>
      this.onEvent({ taskId: null, runId: null, role: "codex", kind: "agent", message });
    if (input.title.endsWith(": replan")) {
      this.counters.replans++;
      assertStringIncludes(input.prompt, "Failing win-condition probes");
      assertStringIncludes(input.prompt, "win.txt");
      reply(JSON.stringify([{
        title: "Create win.txt marker",
        prompt: "Create the win.txt file the probe requires.",
        acceptanceCriteria: "- win.txt exists.",
        priority: 200,
        workpad: "Planned by pursue replan.",
        dependsOn: [],
        riskLevel: "low",
        verificationPlan: "- test -f win.txt",
      }]));
    } else if (input.title.endsWith(": test-engineer")) {
      reply("VERIFICATION_PASSED\n- Scripted verification proof recorded.");
    } else if (input.title.includes("review")) {
      reply("APPROVED\n- Scripted review.");
    } else if (input.title.includes("seed") || input.title.includes("absorb")) {
      reply("Acknowledged.");
    } else {
      this.counters.implementations++;
      if (input.title.includes("Create win.txt marker")) {
        await Deno.writeTextFile(`${session.cwd}/win.txt`, "win\n");
      } else {
        await Deno.writeTextFile(`${session.cwd}/notes.txt`, "initial work\n");
      }
      reply("Implemented. Handoff: changed files recorded.");
    }
    return {
      threadId: session.threadId,
      turnId: `turn-${this.counters.implementations}-${this.counters.replans}`,
      status: "completed",
      completed: true,
    };
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("pursue loop replans from failing probes until the goal closes", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=T",
    "commit",
    "--allow-empty",
    "-m",
    "seed",
  ]);
  const store = new BoardStore(root);
  const counters = { replans: 0, implementations: 0 };
  try {
    store.initProject();
    const { goal } = store.createGoalWithTasks("Reach the win marker", [{
      title: "Do initial unrelated work",
      description: "Write notes.txt only.",
      acceptanceCriteria: "- notes.txt exists.",
      priority: 100,
    }]);
    store.addProbes(goal.id, [{ label: "win.txt exists", command: "test -f win.txt" }]);
    const events: string[] = [];
    const pursuer = new GoalPursuer(root, store, {
      hours: 1,
      maxIterations: 6,
      onEvent: (event) => events.push(`${event.role}/${event.kind}: ${event.message}`),
      createCodexClient: (onEvent) => new PursueScriptedCodexClient(onEvent, counters),
    });
    const report = await pursuer.pursue(goal.id);
    assertEquals(report.closed, true, report.reason + "\n" + events.join("\n"));
    assertEquals(counters.replans, 1);
    assert(counters.implementations >= 2);
    assertEquals(store.getGoal(goal.id).status, "closed");
    assertEquals(store.listProbes(goal.id)[0].lastStatus, "passed");
    assert(events.some((line) => line.includes("pursuer/replan")));
    assert(events.some((line) => line.includes("Win conditions 1/1")));
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("pursue loop stops with a clear ask when the same failure repeats", async () => {
  const root = Deno.makeTempDirSync();
  await git(root, ["init", "-b", "main"]);
  await git(root, [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=T",
    "commit",
    "--allow-empty",
    "-m",
    "seed",
  ]);
  const store = new BoardStore(root);
  const counters = { replans: 0, implementations: 0 };
  try {
    store.initProject();
    const { goal } = store.createGoalWithTasks("Impossible win", [{
      title: "Do initial unrelated work",
      description: "Write notes.txt only.",
      acceptanceCriteria: "- notes.txt exists.",
      priority: 100,
    }]);
    // The replanned task creates win.txt, but this probe demands a file the
    // scripted agent never creates, so the failure fingerprint repeats.
    store.addProbes(goal.id, [{
      label: "win.txt has impossible content",
      command: "grep -q impossible-content win.txt",
    }]);
    const pursuer = new GoalPursuer(root, store, {
      hours: 1,
      maxIterations: 8,
      createCodexClient: (onEvent) => new PursueScriptedCodexClient(onEvent, counters),
    });
    const report = await pursuer.pursue(goal.id);
    assertEquals(report.closed, false);
    assertStringIncludes(report.reason, "kept failing");
    assert(report.asks.length >= 1);
    assert(counters.replans >= 1);
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});

async function git(root: string, args: string[]): Promise<void> {
  const output = await new Deno.Command("git", {
    args,
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
}
