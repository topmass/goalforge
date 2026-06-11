import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { parseScoutResponse, runScout, SCOUT_PENDING_CAP } from "../src/workers/goal_scout.ts";
import {
  CodexClient,
  CodexSession,
  CodexThreadReadResult,
  CodexTurnInput,
  CodexTurnResult,
} from "../src/workers/codex_app_server.ts";
import { ActivityEventInput } from "../src/board/types.ts";

class ScriptedScoutClient implements CodexClient {
  prompts: string[] = [];
  constructor(
    private readonly onEvent: (event: ActivityEventInput) => void,
    private readonly response: string,
  ) {}

  startSession(cwd: string): Promise<CodexSession> {
    return Promise.resolve({ threadId: "thread-scout-test", cwd });
  }

  resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    return Promise.resolve({ threadId, cwd });
  }

  readThread(session: CodexSession): Promise<CodexThreadReadResult> {
    return Promise.resolve({
      threadId: session.threadId,
      name: "scout",
      status: "idle",
      turnCount: 0,
      raw: {},
    });
  }

  compactThread(_session: CodexSession): Promise<void> {
    return Promise.resolve();
  }

  runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    this.prompts.push(input.prompt);
    this.onEvent({
      taskId: null,
      runId: null,
      role: "codex",
      kind: "agent",
      message: this.response,
    });
    return Promise.resolve({
      threadId: session.threadId,
      turnId: "turn-scout",
      status: "completed",
      completed: true,
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }
}

const SCOUT_JSON = JSON.stringify({
  ideas: [
    {
      title: "Add idea export",
      pitch: "**What:** Export ideas. **Why it's cool:** Sharing. **Why now:** Scout shipped.",
      sources: ["https://example.com/loops"],
      buildsOn: "",
    },
    {
      title: "Add idea import",
      pitch: "**What:** Import ideas. **Why it's cool:** Round trip. **Why now:** Pairs.",
      sources: [],
      buildsOn: "Add idea export",
    },
  ],
  order: ["Add idea export", "Add idea import"],
});

Deno.test("scout proposes ideas, ranks them, and never re-pitches rejections", async () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-scout-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    let client = new ScriptedScoutClient(() => {}, SCOUT_JSON);
    const report = await runScout(root, store, {
      createScoutClient: (onEvent) => {
        client = new ScriptedScoutClient(onEvent, SCOUT_JSON);
        return client;
      },
    });
    assertEquals(report.ran, true);
    assertEquals(report.added.length, 2);
    assertStringIncludes(client.prompts[0], "GoalForge scout");
    assertStringIncludes(client.prompts[0], "Web search is not configured");

    const pending = store.listIdeas("proposed");
    assertEquals(pending.map((idea) => idea.title), ["Add idea export", "Add idea import"]);
    assertEquals(pending[0].rank, 1);
    assertEquals(pending[1].buildsOn, "Add idea export");
    assertEquals(pending[0].sources, ["https://example.com/loops"]);
    assertEquals(store.getBoard().ideas.length, 2);

    // Reject one; the same title must never come back.
    store.setIdeaStatus(pending[1].id, "rejected");
    const rerun = await runScout(root, store, {
      createScoutClient: (onEvent) => new ScriptedScoutClient(onEvent, SCOUT_JSON),
    });
    assertEquals(rerun.added.length, 0);
    assertEquals(store.listIdeas("proposed").length, 1);
    assertEquals(store.listIdeas("rejected").length, 1);

    // Approval keeps it out of the pending board list.
    const approved = store.setIdeaStatus(pending[0].id, "approved");
    assertEquals(approved.status, "approved");
    assertEquals(store.getBoard().ideas.length, 0);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("scout skips when the pending list is already full", async () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-scout-cap-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.addIdeas(
      Array.from({ length: SCOUT_PENDING_CAP }, (_, index) => ({
        title: `Filler idea ${index + 1}`,
        pitch: "**What:** filler. **Why it's cool:** filler. **Why now:** filler.",
      })),
    );
    const report = await runScout(root, store, {
      createScoutClient: (onEvent) => new ScriptedScoutClient(onEvent, SCOUT_JSON),
    });
    assertEquals(report.ran, false);
    assertStringIncludes(report.reason, "already await review");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("scout prompt includes search instructions and rejected titles", async () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-scout-search-" });
  const home = Deno.makeTempDirSync({ prefix: "goalforge-scout-home-" });
  const previous = Deno.env.get("GOALFORGE_HOME");
  Deno.env.set("GOALFORGE_HOME", home);
  const store = new BoardStore(root);
  try {
    store.initProject();
    const [seed] = store.addIdeas([{
      title: "Stale idea",
      pitch: "**What:** old. **Why it's cool:** old. **Why now:** old.",
    }]);
    store.setIdeaStatus(seed.id, "rejected");
    const { updateGlobalConfig } = await import("../src/board/global_config.ts");
    updateGlobalConfig({ search: { endpoint: "http://127.0.0.1:8888" } });

    let client: ScriptedScoutClient | null = null;
    await runScout(root, store, {
      createScoutClient: (onEvent) => {
        client = new ScriptedScoutClient(onEvent, SCOUT_JSON);
        return client;
      },
    });
    assert(client);
    const prompt = (client as ScriptedScoutClient).prompts[0];
    assertStringIncludes(prompt, "http://127.0.0.1:8888/search?q=YOUR+QUERY&format=json");
    assertStringIncludes(prompt, "- Stale idea");
  } finally {
    store.close();
    if (previous === undefined) {
      Deno.env.delete("GOALFORGE_HOME");
    } else {
      Deno.env.set("GOALFORGE_HOME", previous);
    }
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(home, { recursive: true });
  }
});

Deno.test("scout response parser handles fences and refuses empty answers", () => {
  const fenced = "Here you go:\n```json\n" + SCOUT_JSON + "\n```";
  const parsed = parseScoutResponse(fenced, []);
  assertEquals(parsed.ideas.length, 2);
  assertEquals(parsed.order.length, 2);

  const empty = parseScoutResponse('{"ideas": [], "order": []}', []);
  assertEquals(empty.ideas.length, 0);

  let threw = false;
  try {
    parseScoutResponse('{"ideas": [], "order": []}', [{
      id: "IDEA-1",
      title: "Pending",
      pitch: "p",
      sources: [],
      buildsOn: "",
      rank: 1,
      status: "proposed",
      fingerprint: "pending",
      createdAt: "now",
      updatedAt: "now",
    }]);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
