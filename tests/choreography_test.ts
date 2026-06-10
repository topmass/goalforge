import { assert, assertEquals } from "@std/assert";
import {
  emptyFlowScene,
  FlowBoardLike,
  pulseTargetForEvent,
  updateFlowScene,
} from "../src/tui/choreography.ts";

function board(overrides: Partial<FlowBoardLike> = {}): FlowBoardLike {
  return {
    tasks: [],
    runs: [],
    agentStatuses: [],
    externalAgents: [],
    ...overrides,
  };
}

Deno.test("updateFlowScene spawns a cluster for a running task and settles to active", () => {
  const snapshot = board({
    tasks: [{ id: "TASK-1", status: "in_progress", touchedPaths: [] }],
    runs: [{ id: "RUN-1", taskId: "TASK-1", status: "running" }],
    agentStatuses: [{ taskId: "TASK-1", runId: "RUN-1", phase: "editing", risk: "none" }],
  });
  const first = updateFlowScene(emptyFlowScene(), snapshot, 1000);
  assertEquals(first.clusters.length, 1);
  assertEquals(first.clusters[0].id, "TASK-1");
  assertEquals(first.clusters[0].mood, "spawning");
  assertEquals(first.effects, [{ type: "spawn", clusterId: "TASK-1" }]);
  assert(first.clusters[0].energy > 0.7);

  const second = updateFlowScene(first, snapshot, 4000);
  assertEquals(second.clusters[0].mood, "active");
  assertEquals(second.effects.length, 0);
  assert(second.coreEnergy > emptyFlowScene().coreEnergy);
});

Deno.test("updateFlowScene reports conflict with the overlapping running task", () => {
  const snapshot = board({
    tasks: [
      { id: "TASK-1", status: "in_progress", touchedPaths: ["src/a.ts"] },
      { id: "TASK-2", status: "in_progress", touchedPaths: ["src/a.ts"] },
    ],
    runs: [
      { id: "RUN-1", taskId: "TASK-1", status: "running" },
      { id: "RUN-2", taskId: "TASK-2", status: "running" },
    ],
    agentStatuses: [
      { taskId: "TASK-1", runId: "RUN-1", phase: "editing", risk: "none" },
      { taskId: "TASK-2", runId: "RUN-2", phase: "editing", risk: "none" },
    ],
  });
  const calm = updateFlowScene(emptyFlowScene(), snapshot, 1000);
  snapshot.agentStatuses[0].risk = "conflict";
  const next = updateFlowScene(calm, snapshot, 4000);
  assertEquals(next.clusters[0].mood, "conflict");
  const conflict = next.effects.find((effect) => effect.type === "conflict");
  assertEquals(conflict?.clusterId, "TASK-1");
  assertEquals(conflict?.otherId, "TASK-2");
});

Deno.test("updateFlowScene merges finished tasks and scatters failed ones", () => {
  const running = board({
    tasks: [
      { id: "TASK-1", status: "in_progress", touchedPaths: [] },
      { id: "TASK-2", status: "in_progress", touchedPaths: [] },
    ],
    runs: [
      { id: "RUN-1", taskId: "TASK-1", status: "running" },
      { id: "RUN-2", taskId: "TASK-2", status: "running" },
    ],
    agentStatuses: [
      { taskId: "TASK-1", runId: "RUN-1", phase: "testing", risk: "none" },
      { taskId: "TASK-2", runId: "RUN-2", phase: "testing", risk: "none" },
    ],
  });
  const active = updateFlowScene(emptyFlowScene(), running, 1000);
  const finished = board({
    tasks: [
      { id: "TASK-1", status: "done", touchedPaths: [] },
      { id: "TASK-2", status: "blocked", touchedPaths: [] },
    ],
    runs: [
      { id: "RUN-1", taskId: "TASK-1", status: "completed" },
      { id: "RUN-2", taskId: "TASK-2", status: "failed" },
    ],
    agentStatuses: [],
  });
  const next = updateFlowScene(active, finished, 5000);
  assertEquals(next.clusters.length, 0);
  const types = next.effects.map((effect) => `${effect.type}:${effect.clusterId}`).sort();
  assertEquals(types, ["merge:TASK-1", "scatter:TASK-2"]);
});

Deno.test("updateFlowScene tracks external agents and failing tests scatter", () => {
  const snapshot = board({
    tasks: [{ id: "TASK-1", status: "in_progress", touchedPaths: [] }],
    runs: [{ id: "RUN-1", taskId: "TASK-1", status: "running" }],
    agentStatuses: [{ taskId: "TASK-1", runId: "RUN-1", phase: "testing", risk: "none" }],
    externalAgents: [
      { id: "claude-code:abc", agent: "claude-code", state: "blocked", headline: "Waiting" },
    ],
  });
  const first = updateFlowScene(emptyFlowScene(), snapshot, 1000);
  assertEquals(first.clusters.length, 2);
  const external = first.clusters.find((cluster) => cluster.kind === "external");
  assertEquals(external?.mood, "blocked");
  assert((external?.energy ?? 1) < 0.2);

  snapshot.agentStatuses[0].risk = "test_failed";
  const next = updateFlowScene(first, snapshot, 4000);
  assertEquals(next.clusters[0].mood, "failing");
  assert(next.effects.some((effect) => effect.type === "scatter" && effect.clusterId === "TASK-1"));
});

Deno.test("pulseTargetForEvent only pulses live clusters", () => {
  const snapshot = board({
    tasks: [{ id: "TASK-1", status: "in_progress", touchedPaths: [] }],
    runs: [{ id: "RUN-1", taskId: "TASK-1", status: "running" }],
    agentStatuses: [{ taskId: "TASK-1", runId: "RUN-1", phase: "running", risk: "none" }],
  });
  const scene = updateFlowScene(emptyFlowScene(), snapshot, 1000);
  assertEquals(
    pulseTargetForEvent(scene, { taskId: "TASK-1", role: "codex", kind: "event" }),
    "TASK-1",
  );
  assertEquals(
    pulseTargetForEvent(scene, { taskId: "TASK-9", role: "codex", kind: "event" }),
    null,
  );
  assertEquals(pulseTargetForEvent(scene, { taskId: null, role: "codex", kind: "event" }), null);
});
