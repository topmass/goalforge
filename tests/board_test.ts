import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { BoardStore, readConfig, updateConfig } from "../src/board/store.ts";

Deno.test("init creates local runtime files and prompt templates", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    assertEquals(Deno.statSync(`${root}/.goalforge/board.sqlite`).isFile, true);
    assertEquals(Deno.statSync(`${root}/.goalforge/config.json`).isFile, true);
    assertEquals(Deno.statSync(`${root}/.goalforge/prompts/constitution.md`).isFile, true);
    assertStringIncludes(Deno.readTextFileSync(`${root}/.gitignore`), "/.goalforge/");
    assertStringIncludes(Deno.readTextFileSync(`${root}/.gitignore`), "/.omx/");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("goal creates an initial ready task", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Ship the kanban command center");
    assertEquals(goal.id, "GOAL-1");
    assertEquals(task.id, "TASK-1");
    assertEquals(task.status, "ready");
    assertStringIncludes(task.acceptanceCriteria, "validation evidence");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("config stores model, reasoning, and fast mode", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    assertEquals(readConfig(root).model, "gpt-5.5");
    const config = updateConfig(root, {
      model: "gpt-5.4",
      reasoningEffort: "medium",
      fastMode: false,
    });
    assertEquals(config.model, "gpt-5.4");
    assertEquals(config.reasoningEffort, "medium");
    assertEquals(config.fastMode, false);
    assertEquals(readConfig(root).reasoningEffort, "medium");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("planned goals create multiple prioritized tasks", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, tasks } = store.createGoalWithTasks("Plan a project", [
      {
        title: "Build the first slice",
        description: "Implement the first slice.",
        acceptanceCriteria: "- Slice works.",
        priority: 300,
      },
      {
        title: "Verify the slice",
        description: "Test the first slice.",
        acceptanceCriteria: "- Tests pass.",
        priority: 200,
      },
    ]);
    assertEquals(goal.id, "GOAL-1");
    assertEquals(tasks.length, 2);
    assertEquals(tasks[0].priority, 300);
    assertEquals(tasks[1].title, "Verify the slice");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("transition validation prevents review without evidence", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Protect review gates");
    store.requestTransition(task.id, "in_progress", "test", "claim");
    assertThrows(
      () => {
        store.requestTransition(task.id, "review", "test", "missing proof");
      },
      Error,
      "Validation evidence is required",
    );
    store.updateTaskValidation(task.id, "Unit test evidence");
    const result = store.requestTransition(task.id, "review", "test", "proof attached");
    assertEquals(result.task.status, "review");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("running runs prevent duplicate task claims", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Protect worker claims");
    store.createRun(task.id, "worker");
    assertThrows(
      () => {
        store.createRun(task.id, "worker");
      },
      Error,
      "already has a running agent",
    );
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("queued tasks can be deleted before they start", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Remove this queued goal");
    store.deleteTask(task.id);
    assertEquals(store.getBoard().tasks.length, 0);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("started stuck tasks can be deleted from the board", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Remove this stuck goal");
    store.assignWorktree(task.id, "goalforge/task-1", `${root}/.goalforge/worktrees/TASK-1`);
    store.requestTransition(task.id, "in_progress", "test", "claim");
    store.createRun(task.id, "worker");
    store.deleteTask(task.id);
    assertEquals(store.getBoard().tasks.length, 0);
    assertThrows(
      () => {
        store.getTask(task.id);
      },
      Error,
      "Task not found",
    );
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("events keep readable activity and raw protocol payloads", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.appendEvent(null, null, "codex", "turn", "Started turn.", { turn: { id: "turn-1" } });
    const event = store.getBoard().events.at(-1);
    assertEquals(event?.message, "Started turn.");
    assertStringIncludes(event?.rawJson ?? "", "turn-1");
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("queued messages appear on the board and can be processed", () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { task } = store.createGoal("Receive queued instructions");
    store.enqueueMessage(task.id, "user", "Please keep the scope tight.");
    assertEquals(store.getBoard().messages.length, 1);
    const pending = store.listPendingMessages(task.id);
    assertEquals(pending.length, 1);
    store.markMessagesProcessed(pending.map((message) => message.id));
    assertEquals(store.listPendingMessages(task.id).length, 0);
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
