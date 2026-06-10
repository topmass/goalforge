import { assert, assertEquals } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { startServer } from "../src/web/server.ts";

Deno.test("store records, updates, and prunes external agent reports", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const first = store.reportExternalAgent({
      id: "claude-code:abc",
      agent: "claude-code",
      state: "working",
      headline: "Handling a new prompt",
      cwd: root,
      sessionId: "abc",
    });
    assertEquals(first.changed, true);
    const repeat = store.reportExternalAgent({
      id: "claude-code:abc",
      agent: "claude-code",
      state: "working",
    });
    assertEquals(repeat.changed, false);
    assertEquals(repeat.status.headline, "Handling a new prompt");
    const blocked = store.reportExternalAgent({
      id: "claude-code:abc",
      agent: "claude-code",
      state: "blocked",
      headline: "Waiting for permission",
    });
    assertEquals(blocked.changed, true);

    const board = store.getBoard();
    assertEquals(board.externalAgents.length, 1);
    assertEquals(board.externalAgents[0].state, "blocked");
    assertEquals(board.externalAgents[0].sessionId, "abc");

    assertEquals(store.pruneExternalAgents(60_000), 0);
    assertEquals(store.pruneExternalAgents(-1), 1);
    assertEquals(store.listExternalAgents().length, 0);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("server accepts hook reports and ignores other project roots", async () => {
  const root = Deno.makeTempDirSync();
  const port = 49233 + Math.floor(Math.random() * 300);
  const server = startServer(root, port);
  try {
    const report = await fetch(`${server.url}/api/agents/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        state: "working",
        headline: "Editing files",
        cwd: root,
        sessionId: "session-1",
      }),
    }).then((response) => response.json());
    assertEquals(report.ok, true);
    assertEquals(report.status.state, "working");

    const ignored = await fetch(`${server.url}/api/agents/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "codex",
        state: "working",
        cwd: "/somewhere/else",
      }),
    }).then((response) => response.json());
    assertEquals(ignored.ignored, true);

    const missingAgent = await fetch(`${server.url}/api/agents/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assertEquals(missingAgent.status, 400);
    await missingAgent.json();

    const update = await fetch(`${server.url}/api/agents/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "claude-code",
        state: "idle",
        sessionId: "session-1",
        cwd: root,
      }),
    }).then((response) => response.json());
    assertEquals(update.ok, true);

    const board = await fetch(`${server.url}/api/board`).then((response) => response.json());
    assertEquals(board.externalAgents.length, 1);
    assertEquals(board.externalAgents[0].state, "idle");
    assertEquals(board.externalAgents[0].agent, "claude-code");
    assert(
      board.events.some((event: { role: string; message: string }) =>
        event.role === "external" && event.message.includes("claude-code is idle")
      ),
    );
  } finally {
    server.shutdown();
    await server.finished.catch(() => {});
    await Deno.remove(root, { recursive: true });
  }
});
