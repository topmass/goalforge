import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { updateGlobalConfig } from "../src/board/global_config.ts";
import {
  CodexClient,
  CodexSession,
  CodexSessionOptions,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";
import { GoalForgeWorker } from "../src/workers/goalforge_worker.ts";
import { buildRescuePrompt } from "../src/workers/rescue.ts";

function withTempHome(fn: () => Promise<void>): Promise<void> {
  const home = Deno.makeTempDirSync();
  const previous = Deno.env.get("GOALFORGE_HOME");
  Deno.env.set("GOALFORGE_HOME", home);
  return fn().finally(() => {
    if (previous === undefined) {
      Deno.env.delete("GOALFORGE_HOME");
    } else {
      Deno.env.set("GOALFORGE_HOME", previous);
    }
    Deno.removeSync(home, { recursive: true });
  });
}

// Worker fake: verification fails until the rescue guidance is present in the
// repair prompt, proving the diagnosis reached the local model.
class StuckUntilRescuedCodexClient implements CodexClient {
  constructor(
    private readonly onEvent: (event: {
      taskId: string | null;
      runId: string | null;
      role: string;
      kind: string;
      message: string;
    }) => void,
    private readonly seen: { rescueGuidanceInPrompt: boolean; testRuns: number },
  ) {}

  startSession(cwd: string, _options: CodexSessionOptions = {}): Promise<CodexSession> {
    return Promise.resolve({ threadId: "thread-stuck", cwd });
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
    return Promise.resolve({ threadId: `thread-${crypto.randomUUID().slice(0, 6)}`, cwd });
  }

  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    const reply = (message: string) =>
      this.onEvent({ taskId: null, runId: null, role: "codex", kind: "agent", message });
    if (input.title.endsWith(": test-engineer")) {
      this.seen.testRuns++;
      reply(
        this.seen.rescueGuidanceInPrompt
          ? "VERIFICATION_PASSED\n- Fixed after rescue guidance; proof recorded."
          : "VERIFICATION_FAILED\n- The endpoint still returns 500 on POST.",
      );
    } else if (input.title.includes("review")) {
      reply("APPROVED\n- Looks right.");
    } else if (input.title.includes("seed") || input.title.includes("absorb")) {
      reply("Acknowledged.");
    } else {
      if (input.prompt.includes("Rescue model diagnosis")) {
        this.seen.rescueGuidanceInPrompt = true;
      }
      await Deno.writeTextFile(`${session.cwd}/work.txt`, "attempt\n");
      reply("Implementation attempt recorded.");
    }
    return {
      threadId: session.threadId,
      turnId: `turn-${this.seen.testRuns}`,
      status: "completed",
      completed: true,
    };
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

class RescueAdvisorCodexClient implements CodexClient {
  constructor(
    private readonly onEvent: (event: {
      taskId: string | null;
      runId: string | null;
      role: string;
      kind: string;
      message: string;
    }) => void,
    private readonly counters: { consultations: number },
  ) {}

  startSession(cwd: string, _options: CodexSessionOptions = {}): Promise<CodexSession> {
    return Promise.resolve({ threadId: "thread-rescue", cwd });
  }

  resumeSession(
    cwd: string,
    threadId: string,
    _options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    this.counters.consultations++;
    assertStringIncludes(input.prompt, "senior engineer reviewing a stuck task");
    assertStringIncludes(input.prompt, "endpoint still returns 500");
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "agent",
      message:
        "Diagnosis: the handler never parses the request body, so POST always 500s. Fix: read and json-parse the body in handle_post before appending. Verify with: curl -X POST localhost:8080/api/notes.",
    });
    return Promise.resolve({
      threadId: session.threadId,
      turnId: "turn-rescue",
      status: "completed",
      completed: true,
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

Deno.test("rescue model diagnoses a stuck task and the guidance unsticks the worker", async () => {
  await withTempHome(async () => {
    updateGlobalConfig({ rescue: { enabled: true, backend: "codex", afterAttempts: 2 } });
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
    const seen = { rescueGuidanceInPrompt: false, testRuns: 0 };
    const counters = { consultations: 0 };
    const events: string[] = [];
    try {
      store.initProject();
      const { task } = store.createGoal("Fix the POST handler");
      const worker = new GoalForgeWorker(root, store, {
        onEvent: (event) => events.push(`${event.role}/${event.kind}`),
        createCodexClient: (onEvent) => new StuckUntilRescuedCodexClient(onEvent, seen),
        createRescueClient: (onEvent) => new RescueAdvisorCodexClient(onEvent, counters),
      });
      const updated = await worker.runTask(task.id);
      assertEquals(updated.status, "done");
      assertEquals(counters.consultations, 1);
      assertEquals(seen.rescueGuidanceInPrompt, true);
      assert(events.some((line) => line === "rescue/consult"));
      assert(events.some((line) => line === "rescue/diagnosis"));
      assert(
        store.getBoard().lessons.some((lesson) => lesson.text.includes("rescue")),
      );
    } finally {
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  });
});

Deno.test("rescue stays quiet when disabled and prompt shape is diagnosis-only", async () => {
  await withTempHome(async () => {
    const prompt = buildRescuePrompt(
      {
        id: "TASK-9",
        title: "T",
        description: "D",
        acceptanceCriteria: "- done",
      } as Parameters<typeof buildRescuePrompt>[0],
      "VERIFICATION_FAILED - x",
      "diff text",
      2,
    );
    assertStringIncludes(prompt, "Do NOT edit");
    assertStringIncludes(prompt, "No code blocks");

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
    const seen = { rescueGuidanceInPrompt: false, testRuns: 0 };
    try {
      store.initProject();
      const { task } = store.createGoal("Stuck without rescue");
      const worker = new GoalForgeWorker(root, store, {
        createCodexClient: (onEvent) => new StuckUntilRescuedCodexClient(onEvent, seen),
        createRescueClient: () => {
          throw new Error("Rescue must not be consulted when disabled.");
        },
      });
      const updated = await worker.runTask(task.id);
      assertEquals(updated.status, "blocked");
      assertEquals(seen.rescueGuidanceInPrompt, false);
    } finally {
      store.close();
      await Deno.remove(root, { recursive: true });
    }
  });
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
