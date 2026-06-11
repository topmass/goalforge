import { startServer } from "../src/web/server.ts";
import {
  CodexClient,
  CodexSession,
  CodexSessionOptions,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";

const root = Deno.args[0];
const port = Number(Deno.args[1]);

if (!root || !Number.isInteger(port)) {
  throw new Error("Usage: smoke_dogfood_server.ts <root> <port>");
}

class DogfoodCodexClient implements CodexClient {
  private static nextThread = 1;
  private static testTurnsByTask = new Map<string, number>();

  constructor(
    private readonly onEvent: (event: {
      taskId: string | null;
      runId: string | null;
      role: string;
      kind: string;
      message: string;
      raw?: unknown;
    }) => void,
  ) {}

  startSession(cwd: string, _options: CodexSessionOptions = {}): Promise<CodexSession> {
    console.log(`DOGFOOD_CODEX start ${cwd}`);
    return Promise.resolve({ threadId: this.nextThreadId(), cwd });
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
    return Promise.resolve({ threadId: this.nextThreadId(), cwd });
  }

  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    console.log(`DOGFOOD_CODEX turn ${input.title}`);
    if (input.title === "LoopForge main thread seed") {
      this.emit("agent", "Dogfood main thread seeded.");
      return this.completed(session, "turn-main-seed");
    }

    if (input.title === "LoopForge goal compiler") {
      this.emit(
        "agent",
        JSON.stringify({
          completionContract: "- Dogfood marker file contains repaired output.",
          tasks: [{
            title: "Write dogfood marker",
            prompt:
              "Create dogfood-marker.txt. The first implementation may be incomplete; repair it when verification asks.",
            acceptanceCriteria: "- dogfood-marker.txt contains repaired output.",
            priority: 100,
            workpad: "Dogfood smoke task created by deterministic Codex stand-in.",
            dependsOn: [],
            riskLevel: "medium",
            verificationPlan:
              "- Inspect dogfood-marker.txt.\n- Confirm it contains repaired output.\n- Record the observed result.",
          }],
        }),
      );
      return this.completed(session, "turn-plan");
    }

    if (input.title.endsWith(": review")) {
      this.emit("agent", "APPROVED\n- Validation proves the dogfood marker repair.");
      return this.completed(session, "turn-review");
    }

    if (input.title.endsWith(": absorb")) {
      this.emit("agent", "Dogfood task absorbed into project memory.");
      return this.completed(session, "turn-absorb");
    }

    if (input.title.endsWith(": test-engineer")) {
      const taskId = input.title.split(":")[0];
      const count = (DogfoodCodexClient.testTurnsByTask.get(taskId) ?? 0) + 1;
      DogfoodCodexClient.testTurnsByTask.set(taskId, count);
      if (count === 1) {
        this.emit(
          "agent",
          "VERIFICATION_FAILED\n- dogfood-marker.txt does not yet contain repaired output.",
        );
      } else {
        this.emit(
          "agent",
          [
            "VERIFICATION_PASSED",
            "- Dogfood marker file contains repaired output. Inspected dogfood-marker.txt after the repair turn.",
          ].join("\n"),
        );
      }
      return this.completed(session, `turn-test-${count}`);
    }

    if (/^TASK-\d+: repair /.test(input.title)) {
      await Deno.writeTextFile(`${session.cwd}/dogfood-marker.txt`, "dogfood repaired output\n");
      this.emit("output", "dogfood-marker.txt repaired");
      return this.completed(session, "turn-repair");
    }

    if (/^TASK-\d+: /.test(input.title)) {
      await Deno.writeTextFile(`${session.cwd}/dogfood-marker.txt`, "dogfood first pass output\n");
      this.emit("output", "dogfood-marker.txt written");
      return this.completed(session, "turn-implementation");
    }

    this.emit("agent", "Dogfood Codex stand-in handled the turn.");
    return this.completed(session, "turn-generic");
  }

  setThreadName(_session: CodexSession, _name: string): Promise<void> {
    return Promise.resolve();
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  private nextThreadId(): string {
    return `dogfood-thread-${DogfoodCodexClient.nextThread++}`;
  }

  private emit(kind: string, message: string): void {
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind,
      message,
    });
  }

  private completed(session: CodexSession, turnId: string): CodexTurnResult {
    return {
      threadId: session.threadId,
      turnId,
      status: "completed",
      completed: true,
    };
  }
}

async function seedGitRepo(target: string): Promise<void> {
  await Deno.mkdir(target, { recursive: true });
  await Deno.writeTextFile(`${target}/seed.txt`, "seed\n");
  await git(target, ["init", "-b", "main"]);
  await git(target, ["add", "seed.txt"]);
  await git(target, ["commit", "-m", "seed"]);
}

async function git(cwd: string, args: string[]): Promise<void> {
  const output = await new Deno.Command("git", {
    args: [
      "-c",
      "user.email=loopforge-smoke@example.com",
      "-c",
      "user.name=LoopForge Smoke",
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

await main();

async function main(): Promise<void> {
  await seedGitRepo(root);

  const server = startServer(root, port, {
    createCodexClient: (onEvent) => new DogfoodCodexClient(onEvent),
  });

  console.log(`DOGFOOD_READY ${server.url}`);

  const shutdown = () => {
    server.shutdown();
  };

  Deno.addSignalListener("SIGTERM", shutdown);
  Deno.addSignalListener("SIGINT", shutdown);

  try {
    await server.finished;
  } finally {
    Deno.removeSignalListener("SIGTERM", shutdown);
    Deno.removeSignalListener("SIGINT", shutdown);
  }
}
