// Maps board state to the Agent Flow scene: one cluster per live agent, one-shot
// effects on transitions. Pure module so the animation logic stays Deno-testable.

export type ClusterMood =
  | "spawning"
  | "active"
  | "blocked"
  | "conflict"
  | "failing"
  | "merging";

export interface FlowCluster {
  id: string;
  label: string;
  kind: "codex" | "external";
  phase: string;
  mood: ClusterMood;
  energy: number;
  bornAtMs: number;
}

export type FlowEffectType = "spawn" | "merge" | "scatter" | "conflict" | "pulse";

export interface FlowEffect {
  type: FlowEffectType;
  clusterId: string;
  otherId?: string;
}

export interface FlowScene {
  clusters: FlowCluster[];
  effects: FlowEffect[];
  coreEnergy: number;
}

export interface FlowBoardLike {
  tasks: Array<{
    id: string;
    status: string;
    touchedPaths: string[];
  }>;
  runs: Array<{ id: string; taskId: string; status: string }>;
  agentStatuses: Array<{
    taskId: string;
    runId: string;
    phase: string;
    risk: string;
  }>;
  externalAgents?: Array<{
    id: string;
    agent: string;
    state: string;
    headline: string;
  }>;
}

const PHASE_ENERGY: Record<string, number> = {
  starting: 0.35,
  planning: 0.55,
  reading: 0.45,
  editing: 0.85,
  running: 0.75,
  testing: 0.9,
  reviewing: 0.6,
  merging: 0.7,
  blocked: 0.12,
  done: 0.3,
};

const EXTERNAL_ENERGY: Record<string, number> = {
  working: 0.7,
  blocked: 0.12,
  done: 0.3,
  idle: 0.15,
};

const SPAWN_MS = 1500;

export function emptyFlowScene(): FlowScene {
  return { clusters: [], effects: [], coreEnergy: 0.2 };
}

export function updateFlowScene(
  prev: FlowScene,
  board: FlowBoardLike,
  nowMs: number,
): FlowScene {
  const previous = new Map(prev.clusters.map((cluster) => [cluster.id, cluster]));
  const clusters: FlowCluster[] = [];
  const effects: FlowEffect[] = [];

  const runningTaskIds = new Set(
    board.runs.filter((run) => run.status === "running").map((run) => run.taskId),
  );
  const runningRunIds = new Set(
    board.runs.filter((run) => run.status === "running").map((run) => run.id),
  );
  const statusByTask = new Map<string, FlowBoardLike["agentStatuses"][number]>();
  for (const status of board.agentStatuses) {
    if (runningRunIds.has(status.runId) && !statusByTask.has(status.taskId)) {
      statusByTask.set(status.taskId, status);
    }
  }

  for (const taskId of [...runningTaskIds].sort()) {
    const status = statusByTask.get(taskId);
    const phase = status?.phase ?? "starting";
    const risk = status?.risk ?? "none";
    const before = previous.get(taskId);
    const bornAtMs = before?.bornAtMs ?? nowMs;
    let mood: ClusterMood = nowMs - bornAtMs < SPAWN_MS ? "spawning" : "active";
    if (risk === "conflict") {
      mood = "conflict";
    } else if (risk === "test_failed") {
      mood = "failing";
    } else if (phase === "blocked" || risk === "needs_user" || risk === "stale") {
      mood = "blocked";
    } else if (phase === "merging" || phase === "done") {
      mood = "merging";
    }
    clusters.push({
      id: taskId,
      label: taskId,
      kind: "codex",
      phase,
      mood,
      energy: PHASE_ENERGY[phase] ?? 0.5,
      bornAtMs,
    });
    if (!before) {
      effects.push({ type: "spawn", clusterId: taskId });
    } else {
      if (mood === "conflict" && before.mood !== "conflict") {
        effects.push({
          type: "conflict",
          clusterId: taskId,
          otherId: conflictPartner(board, taskId, runningTaskIds),
        });
      }
      if (mood === "failing" && before.mood !== "failing") {
        effects.push({ type: "scatter", clusterId: taskId });
      }
    }
  }

  for (const agent of board.externalAgents ?? []) {
    const before = previous.get(agent.id);
    const bornAtMs = before?.bornAtMs ?? nowMs;
    const mood: ClusterMood = agent.state === "blocked"
      ? "blocked"
      : nowMs - bornAtMs < SPAWN_MS
      ? "spawning"
      : "active";
    clusters.push({
      id: agent.id,
      label: agent.agent,
      kind: "external",
      phase: agent.state,
      mood,
      energy: EXTERNAL_ENERGY[agent.state] ?? 0.4,
      bornAtMs,
    });
    if (!before) {
      effects.push({ type: "spawn", clusterId: agent.id });
    }
  }

  const liveIds = new Set(clusters.map((cluster) => cluster.id));
  for (const cluster of prev.clusters) {
    if (liveIds.has(cluster.id)) {
      continue;
    }
    const task = board.tasks.find((item) => item.id === cluster.id);
    const finished = cluster.kind === "external" ||
      task?.status === "done" || task?.status === "review";
    effects.push({ type: finished ? "merge" : "scatter", clusterId: cluster.id });
  }

  const working = clusters.filter((cluster) => cluster.energy > 0.3).length;
  const coreEnergy = Math.min(1, 0.2 + working * 0.2);
  return { clusters, effects, coreEnergy };
}

export function pulseTargetForEvent(
  scene: FlowScene,
  event: { taskId: string | null; role: string; kind: string },
): string | null {
  if (!event.taskId) {
    return null;
  }
  return scene.clusters.some((cluster) => cluster.id === event.taskId) ? event.taskId : null;
}

function conflictPartner(
  board: FlowBoardLike,
  taskId: string,
  runningTaskIds: Set<string>,
): string | undefined {
  const paths = new Set(board.tasks.find((task) => task.id === taskId)?.touchedPaths ?? []);
  for (const other of board.tasks) {
    if (other.id === taskId || !runningTaskIds.has(other.id)) {
      continue;
    }
    if (other.touchedPaths.some((path) => paths.has(path))) {
      return other.id;
    }
  }
  return undefined;
}
