import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { renderCommandCenterFrame, TuiState } from "../src/tui/command_center.ts";

Deno.test("command center snapshot renders task, thread, stream, and controls", () => {
  const root = Deno.makeTempDirSync({ prefix: "loopforge-tui-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { tasks } = store.createGoalWithTasks("Ship command center", [
      {
        title: "Build polished TUI",
        description: "Create a command center for supervising Codex task threads.",
        acceptanceCriteria: "The TUI shows task state, main thread, live events, and controls.",
        priority: 9,
      },
    ]);
    store.setMainThread("thread-main", "Project memory lives here.");
    store.assignThreadLineage(tasks[0].id, "thread-main", "thread-child");
    store.updateTaskActiveTurn(tasks[0].id, "turn-active");
    store.updateTaskCard(
      tasks[0].id,
      "State: building. Next: verify layout and steering controls.",
    );
    store.updateTaskTouchedPaths(tasks[0].id, ["src/tui/command_center.ts"]);
    store.updateTaskValidation(
      tasks[0].id,
      "Codex App Server turn completed.\nTest turn: turn-test\nLoopForge review: APPROVED",
    );
    store.recordSupervisorDecision(tasks[0].id, "Supervisor is watching task progress.");
    store.appendEvent(tasks[0].id, null, "worker", "phase", "Rendering command center.");

    const state: TuiState = {
      selectedTaskId: tasks[0].id,
      promptMode: null,
      input: "",
      notice: "Ready.",
      busy: false,
      frame: 0,
      showHelp: true,
    };
    const output = renderCommandCenterFrame(store.getBoard(), state, {
      width: 120,
      height: 40,
      color: false,
    });

    assertStringIncludes(output, "LoopForge Command Center");
    assertStringIncludes(output, "Agents / Tasks");
    assertStringIncludes(output, "Build polished TUI");
    assertStringIncludes(output, "Queued");
    assertStringIncludes(output, "gate");
    assertStringIncludes(output, "Recommended Action");
    assertStringIncludes(output, "Click Start");
    assertStringIncludes(output, "Changed Files");
    assertStringIncludes(output, "src/tui/command_center.ts");
    assertStringIncludes(output, "Validation Log");
    assertStringIncludes(output, "gates missing");
    assertStringIncludes(output, "review APPROVED");
    assertStringIncludes(output, "Codex App Server");
    assertStringIncludes(output, "Supervisor");
    assertStringIncludes(output, "Recent Activity");
    assertStringIncludes(output, "Current Goal");
    assertStringIncludes(output, "GOAL-1 Ready 0/1 done");
    assertStringIncludes(output, "verdict Ready To Run");
    assertStringIncludes(output, "evidence gaps 0");
    assertStringIncludes(output, "thread-main");
    assertStringIncludes(output, "thread-child");
    assertStringIncludes(output, "Agent: Rendering command center.");
    assertStringIncludes(output, "b build");
    assertStringIncludes(output, "g plan");
    assertStringIncludes(output, "v review");
    assertStringIncludes(output, "M mem");
    assertStringIncludes(output, "R reset");
    assertStringIncludes(output, "D done");
    assertStringIncludes(output, "C close");
    assertStringIncludes(output, "del rm");
    assertEquals(output.split("\n").length, 40);
    assert(output.split("\n").every((line) => line.length <= 140));
  } finally {
    store.close();
    Deno.removeSync(root, { recursive: true });
  }
});
