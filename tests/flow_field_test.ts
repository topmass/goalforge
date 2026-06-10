import { assert, assertEquals } from "@std/assert";
import { FlowField } from "../src/tui/flow_field.ts";
import { emptyFlowScene, FlowScene } from "../src/tui/choreography.ts";

function seededRng(seed = 7): () => number {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2147483648;
    return value / 2147483648;
  };
}

function sceneWithCluster(): FlowScene {
  return {
    clusters: [{
      id: "TASK-1",
      label: "TASK-1",
      kind: "codex",
      phase: "editing",
      mood: "active",
      energy: 0.85,
      bornAtMs: 0,
    }],
    effects: [{ type: "spawn", clusterId: "TASK-1" }],
    coreEnergy: 0.4,
  };
}

Deno.test("flow field renders lit cells for an idle core", () => {
  const field = new FlowField({ cols: 80, rows: 5, rng: seededRng() });
  field.applyScene(emptyFlowScene());
  for (let i = 0; i < 30; i++) {
    field.tick(1 / 24);
  }
  let cells = 0;
  field.render(() => cells++);
  assert(cells > 0, "expected ambient and core particles to light cells");
  assert(field.particleCount() > 10);
});

Deno.test("flow field grows a cluster after a spawn effect", () => {
  const field = new FlowField({ cols: 80, rows: 5, rng: seededRng() });
  field.applyScene(sceneWithCluster());
  for (let i = 0; i < 60; i++) {
    field.tick(1 / 24);
  }
  const anchors = field.anchors();
  assertEquals(anchors[0].id, "core");
  const cluster = anchors.find((anchor) => anchor.id === "TASK-1");
  assert(cluster, "expected a cluster anchor");
  let nearCluster = 0;
  field.render((cellX) => {
    if (Math.abs(cellX - cluster.cellX) <= 6) {
      nearCluster++;
    }
  });
  assert(nearCluster > 0, "expected lit cells around the cluster anchor");
});

Deno.test("flow field survives merge effects, resize, and stays bounded", () => {
  const field = new FlowField({ cols: 60, rows: 5, rng: seededRng(3) });
  field.applyScene(sceneWithCluster());
  for (let i = 0; i < 40; i++) {
    field.tick(1 / 24);
  }
  const merged: FlowScene = {
    clusters: [],
    effects: [{ type: "merge", clusterId: "TASK-1" }],
    coreEnergy: 0.2,
  };
  field.applyScene(merged);
  field.resize(40, 4);
  for (let i = 0; i < 120; i++) {
    field.tick(1 / 24);
  }
  assert(field.particleCount() <= 420);
  assertEquals(field.anchors().length, 1);
  field.render((cellX, cellY) => {
    assert(cellX >= 0 && cellX < 40);
    assert(cellY >= 0 && cellY < 4);
  });
});

Deno.test("flow field emits quadrant glyphs with colors in range", () => {
  const field = new FlowField({ cols: 80, rows: 5, rng: seededRng(11) });
  field.applyScene(sceneWithCluster());
  for (let i = 0; i < 50; i++) {
    field.tick(1 / 24);
  }
  const glyphs = new Set("▘▝▀▖▌▞▛▗▚▐▜▄▙▟█");
  let checked = 0;
  field.render((_x, _y, char, r, g, b, intensity) => {
    assert(glyphs.has(char), `unexpected glyph ${char}`);
    for (const channel of [r, g, b]) {
      assert(channel >= 0 && channel <= 1);
    }
    assert(intensity > 0);
    checked++;
  });
  assert(checked > 0);
});
