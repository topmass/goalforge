// Particle simulation behind the Agent Flow band. Works in sub-cell space
// (2x2 quadrant subpixels per terminal cell) and rasterizes to cells through
// an emit callback, so it has no renderer or runtime dependency.

import { FlowScene } from "./choreography.ts";

export interface FlowAnchor {
  id: string;
  kind: "core" | "codex" | "external";
  label: string;
  mood: string;
  x: number;
  y: number;
  cellX: number;
  cellY: number;
}

export type FlowCellEmit = (
  cellX: number,
  cellY: number,
  char: string,
  r: number,
  g: number,
  b: number,
  intensity: number,
) => void;

interface Particle {
  mode: "ambient" | "orbit" | "stream" | "scatter" | "spark";
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  g: number;
  b: number;
  ttl: number;
  anchorId: string | null;
  angle: number;
  spin: number;
  radius: number;
  tx: number;
  ty: number;
  arrival: "orbit" | "vanish";
  seed: number;
}

interface AnchorState extends FlowAnchor {
  energy: number;
  pulse: number;
  color: [number, number, number];
}

const QUADRANTS = [
  " ",
  "▘",
  "▝",
  "▀",
  "▖",
  "▌",
  "▞",
  "▛",
  "▗",
  "▚",
  "▐",
  "▜",
  "▄",
  "▙",
  "▟",
  "█",
];

const CORE_COLOR: [number, number, number] = [0.4, 0.88, 0.95];
const AMBIENT_COLOR: [number, number, number] = [0.32, 0.45, 0.6];
const CONFLICT_COLOR: [number, number, number] = [0.98, 0.32, 0.28];

const PHASE_COLORS: Record<string, [number, number, number]> = {
  starting: [0.55, 0.75, 0.95],
  planning: [0.68, 0.56, 0.98],
  reading: [0.5, 0.66, 0.98],
  editing: [0.45, 0.93, 0.62],
  running: [0.42, 0.88, 0.85],
  testing: [0.98, 0.83, 0.4],
  reviewing: [0.55, 0.7, 0.98],
  merging: [0.75, 0.95, 0.8],
  blocked: [0.95, 0.62, 0.3],
  done: [0.7, 0.85, 0.75],
  working: [0.88, 0.55, 0.9],
  idle: [0.6, 0.5, 0.7],
};

const MOOD_COLORS: Partial<Record<string, [number, number, number]>> = {
  failing: CONFLICT_COLOR,
  conflict: CONFLICT_COLOR,
};

const LIT_THRESHOLD = 0.1;
const MAX_PARTICLES = 420;

export class FlowField {
  private cols: number;
  private rows: number;
  private width: number;
  private height: number;
  private field: Float32Array;
  private fieldR: Float32Array;
  private fieldG: Float32Array;
  private fieldB: Float32Array;
  private particles: Particle[] = [];
  private anchorStates = new Map<string, AnchorState>();
  private core: AnchorState;
  private coreEnergy = 0.2;
  private rng: () => number;

  constructor(options: { cols: number; rows: number; rng?: () => number }) {
    this.rng = options.rng ?? Math.random;
    this.cols = Math.max(1, options.cols);
    this.rows = Math.max(1, options.rows);
    this.width = this.cols * 2;
    this.height = this.rows * 2;
    this.field = new Float32Array(this.width * this.height);
    this.fieldR = new Float32Array(this.width * this.height);
    this.fieldG = new Float32Array(this.width * this.height);
    this.fieldB = new Float32Array(this.width * this.height);
    this.core = this.makeCore();
  }

  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) {
      return;
    }
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.width = this.cols * 2;
    this.height = this.rows * 2;
    this.field = new Float32Array(this.width * this.height);
    this.fieldR = new Float32Array(this.width * this.height);
    this.fieldG = new Float32Array(this.width * this.height);
    this.fieldB = new Float32Array(this.width * this.height);
    this.core = this.makeCore();
    this.layoutAnchors();
    for (const particle of this.particles) {
      particle.x = clamp(particle.x, 0, this.width - 1);
      particle.y = clamp(particle.y, 0, this.height - 1);
    }
  }

  applyScene(scene: FlowScene): void {
    this.coreEnergy = scene.coreEnergy;
    const seen = new Set<string>(["core"]);
    for (const cluster of scene.clusters) {
      seen.add(cluster.id);
      const existing = this.anchorStates.get(cluster.id);
      const color = MOOD_COLORS[cluster.mood] ?? PHASE_COLORS[cluster.phase] ??
        (cluster.kind === "external" ? PHASE_COLORS.working : PHASE_COLORS.starting);
      const next: AnchorState = {
        id: cluster.id,
        kind: cluster.kind,
        label: cluster.label,
        mood: cluster.mood,
        energy: cluster.energy,
        pulse: existing?.pulse ?? 0,
        color,
        x: existing?.x ?? this.core.x,
        y: existing?.y ?? this.core.y,
        cellX: existing?.cellX ?? this.core.cellX,
        cellY: existing?.cellY ?? this.core.cellY,
      };
      this.anchorStates.set(cluster.id, next);
    }
    for (const id of [...this.anchorStates.keys()]) {
      if (!seen.has(id)) {
        this.anchorStates.delete(id);
      }
    }
    this.layoutAnchors();
    for (const effect of scene.effects) {
      if (effect.type === "spawn") {
        this.emitStream("core", effect.clusterId, 14, "orbit");
      } else if (effect.type === "merge") {
        this.returnCluster(effect.clusterId);
      } else if (effect.type === "scatter") {
        this.scatterCluster(effect.clusterId);
      } else if (effect.type === "conflict") {
        this.emitSparks(effect.clusterId, effect.otherId);
      } else if (effect.type === "pulse") {
        this.pulse(effect.clusterId);
      }
    }
  }

  celebrate(): void {
    this.core.pulse = Math.min(2.2, this.core.pulse + 1.6);
    for (let i = 0; i < 36 && this.particles.length < MAX_PARTICLES; i++) {
      const particle = this.makeAmbient();
      particle.mode = "scatter";
      particle.x = this.core.x;
      particle.y = this.core.y;
      const direction = (i / 36) * Math.PI * 2;
      const speed = 14 + this.rng() * 18;
      particle.vx = Math.cos(direction) * speed;
      particle.vy = Math.sin(direction) * speed * 0.6;
      particle.ttl = 1.2 + this.rng() * 0.8;
      particle.r = CORE_COLOR[0];
      particle.g = CORE_COLOR[1];
      particle.b = CORE_COLOR[2];
      this.particles.push(particle);
    }
  }

  pulse(clusterId: string): void {
    const anchor = this.anchorStates.get(clusterId);
    if (anchor) {
      anchor.pulse = Math.min(1.6, anchor.pulse + 0.55);
    }
  }

  anchors(): FlowAnchor[] {
    return [this.core, ...this.anchorStates.values()];
  }

  particleCount(): number {
    return this.particles.length;
  }

  tick(dtSeconds: number): void {
    const dt = clamp(dtSeconds, 0.001, 0.1);
    const decay = Math.exp(-dt * 3.4);
    for (let i = 0; i < this.field.length; i++) {
      this.field[i] *= decay;
      this.fieldR[i] *= decay;
      this.fieldG[i] *= decay;
      this.fieldB[i] *= decay;
    }
    this.maintainBudgets();
    const survivors: Particle[] = [];
    for (const particle of this.particles) {
      particle.ttl -= dt;
      if (particle.ttl <= 0) {
        continue;
      }
      this.advance(particle, dt);
      if (particle.mode !== "ambient" || this.anchorStates.size === 0) {
        this.deposit(particle);
      } else {
        this.deposit(particle, 0.45);
      }
      survivors.push(particle);
    }
    this.particles = survivors;
    for (const anchor of this.anchorStates.values()) {
      anchor.pulse = Math.max(0, anchor.pulse - dt * 1.4);
    }
    this.core.pulse = Math.max(0, this.core.pulse - dt * 1.4);
  }

  render(emit: FlowCellEmit): void {
    for (let cellY = 0; cellY < this.rows; cellY++) {
      for (let cellX = 0; cellX < this.cols; cellX++) {
        const x0 = cellX * 2;
        const y0 = cellY * 2;
        let bits = 0;
        let total = 0;
        let red = 0;
        let green = 0;
        let blue = 0;
        let peak = 0;
        for (let q = 0; q < 4; q++) {
          const sx = x0 + (q & 1);
          const sy = y0 + (q >> 1);
          const index = sy * this.width + sx;
          const value = this.field[index];
          if (value > LIT_THRESHOLD) {
            bits |= q === 0 ? 1 : q === 1 ? 2 : q === 2 ? 4 : 8;
            total += value;
            red += this.fieldR[index];
            green += this.fieldG[index];
            blue += this.fieldB[index];
            peak = Math.max(peak, value);
          }
        }
        if (!bits || total <= 0) {
          continue;
        }
        const brightness = clamp(0.35 + peak * 0.75, 0, 1);
        emit(
          cellX,
          cellY,
          QUADRANTS[bits],
          clamp(red / total, 0, 1) * brightness + (1 - brightness) * 0.02,
          clamp(green / total, 0, 1) * brightness + (1 - brightness) * 0.02,
          clamp(blue / total, 0, 1) * brightness + (1 - brightness) * 0.03,
          clamp(peak, 0, 1),
        );
      }
    }
  }

  private makeCore(): AnchorState {
    const x = clamp(Math.round(this.width * 0.07), 4, this.width - 2);
    const y = this.height / 2;
    return {
      id: "core",
      kind: "core",
      label: "CORE",
      mood: "active",
      energy: 0.5,
      pulse: 0,
      color: CORE_COLOR,
      x,
      y,
      cellX: Math.floor(x / 2),
      cellY: Math.floor(y / 2),
    };
  }

  private layoutAnchors(): void {
    const clusters = [...this.anchorStates.values()];
    const count = clusters.length;
    if (!count) {
      return;
    }
    const startX = this.width * 0.24;
    const span = this.width * 0.72;
    clusters.sort((a, b) => a.id.localeCompare(b.id));
    clusters.forEach((anchor, index) => {
      anchor.x = startX + span * ((index + 0.5) / count);
      anchor.y = this.height / 2 +
        (count > 3 ? (index % 2 === 0 ? -1 : 1) * this.height * 0.1 : 0);
      anchor.cellX = Math.floor(anchor.x / 2);
      anchor.cellY = Math.floor(anchor.y / 2);
    });
  }

  private maintainBudgets(): void {
    const clusterIds = new Set(this.anchorStates.keys());
    const orbiters = new Map<string, number>();
    let coreOrbiters = 0;
    let ambient = 0;
    for (const particle of this.particles) {
      if (particle.mode === "orbit" && particle.anchorId) {
        if (particle.anchorId === "core") {
          coreOrbiters++;
        } else if (clusterIds.has(particle.anchorId)) {
          orbiters.set(particle.anchorId, (orbiters.get(particle.anchorId) ?? 0) + 1);
        } else {
          this.toScatter(particle);
        }
      } else if (particle.mode === "ambient") {
        ambient++;
      }
    }
    const coreTarget = Math.round(16 + this.coreEnergy * 14);
    for (let i = coreOrbiters; i < coreTarget && this.particles.length < MAX_PARTICLES; i++) {
      this.particles.push(this.makeOrbiter(this.core));
    }
    for (const anchor of this.anchorStates.values()) {
      const target = Math.round(9 + anchor.energy * 15);
      const current = orbiters.get(anchor.id) ?? 0;
      for (let i = current; i < target && this.particles.length < MAX_PARTICLES; i++) {
        this.particles.push(this.makeStream(this.core, anchor, "orbit"));
      }
    }
    const ambientTarget = Math.max(8, 30 - this.anchorStates.size * 6);
    for (let i = ambient; i < ambientTarget && this.particles.length < MAX_PARTICLES; i++) {
      this.particles.push(this.makeAmbient());
    }
  }

  private advance(particle: Particle, dt: number): void {
    if (particle.mode === "orbit") {
      const anchor = particle.anchorId === "core"
        ? this.core
        : this.anchorStates.get(particle.anchorId ?? "");
      if (!anchor) {
        this.toScatter(particle);
        return;
      }
      const energy = anchor.id === "core" ? this.coreEnergy : anchor.energy;
      const speed = 0.55 + energy * 2.4 + anchor.pulse * 2.2;
      const slow = anchor.mood === "blocked" ? 0.25 : 1;
      particle.angle += particle.spin * speed * slow * dt;
      const wobble = Math.sin(particle.angle * 2.3 + particle.seed * 12) * 0.5;
      const radius = particle.radius + wobble + anchor.pulse * 1.4;
      particle.x = anchor.x + Math.cos(particle.angle) * radius;
      particle.y = anchor.y + Math.sin(particle.angle) * radius * 0.55;
      particle.r = anchor.color[0];
      particle.g = anchor.color[1];
      particle.b = anchor.color[2];
      if (anchor.mood === "failing" || anchor.mood === "conflict") {
        particle.x += (this.rng() - 0.5) * 1.6;
        particle.y += (this.rng() - 0.5) * 1.2;
      }
    } else if (particle.mode === "stream") {
      const dx = particle.tx - particle.x;
      const dy = particle.ty - particle.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1.6) {
        if (particle.arrival === "orbit" && particle.anchorId) {
          const anchor = particle.anchorId === "core"
            ? this.core
            : this.anchorStates.get(particle.anchorId);
          if (anchor) {
            this.toOrbit(particle, anchor);
            return;
          }
        }
        particle.ttl = 0.0001;
        return;
      }
      const speed = 26 + particle.seed * 10;
      const nx = dx / dist;
      const ny = dy / dist;
      const swirl = Math.sin(
        particle.seed * 20 + (particle.x + particle.y) * 0.22,
      ) * 6;
      particle.vx = nx * speed - ny * swirl;
      particle.vy = (ny * speed + nx * swirl) * 0.6;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
    } else if (particle.mode === "scatter") {
      particle.vx *= 1 - dt * 2.2;
      particle.vy *= 1 - dt * 2.2;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
    } else if (particle.mode === "spark") {
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
    } else {
      particle.x += (particle.vx + Math.sin(particle.seed * 9 + particle.y * 0.18) * 1.6) * dt;
      particle.y += (particle.vy + Math.cos(particle.seed * 7 + particle.x * 0.12) * 0.8) * dt;
      if (particle.x < 0) particle.x += this.width;
      if (particle.x >= this.width) particle.x -= this.width;
      if (particle.y < 0) particle.y += this.height;
      if (particle.y >= this.height) particle.y -= this.height;
    }
  }

  private deposit(particle: Particle, scale = 1): void {
    const x = Math.round(particle.x);
    const y = Math.round(particle.y);
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) {
      return;
    }
    const fade = particle.ttl < 0.6 ? particle.ttl / 0.6 : 1;
    const amount = 0.55 * scale * fade;
    this.splat(x, y, particle, amount);
    this.splat(x + 1, y, particle, amount * 0.3);
    this.splat(x - 1, y, particle, amount * 0.3);
    this.splat(x, y + 1, particle, amount * 0.3);
    this.splat(x, y - 1, particle, amount * 0.3);
  }

  private splat(x: number, y: number, particle: Particle, amount: number): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height || amount <= 0) {
      return;
    }
    const index = y * this.width + x;
    this.field[index] = Math.min(1.8, this.field[index] + amount);
    this.fieldR[index] += particle.r * amount;
    this.fieldG[index] += particle.g * amount;
    this.fieldB[index] += particle.b * amount;
  }

  private makeAmbient(): Particle {
    return {
      mode: "ambient",
      x: this.rng() * this.width,
      y: this.rng() * this.height,
      vx: 1.5 + this.rng() * 2.5,
      vy: (this.rng() - 0.5) * 0.8,
      r: AMBIENT_COLOR[0],
      g: AMBIENT_COLOR[1],
      b: AMBIENT_COLOR[2],
      ttl: 6 + this.rng() * 10,
      anchorId: null,
      angle: 0,
      spin: 0,
      radius: 0,
      tx: 0,
      ty: 0,
      arrival: "vanish",
      seed: this.rng(),
    };
  }

  private makeOrbiter(anchor: AnchorState): Particle {
    const particle = this.makeAmbient();
    this.toOrbit(particle, anchor);
    particle.x = anchor.x + Math.cos(particle.angle) * particle.radius;
    particle.y = anchor.y + Math.sin(particle.angle) * particle.radius * 0.55;
    return particle;
  }

  private makeStream(
    from: AnchorState,
    to: AnchorState,
    arrival: "orbit" | "vanish",
  ): Particle {
    const particle = this.makeAmbient();
    particle.mode = "stream";
    particle.x = from.x + (this.rng() - 0.5) * 3;
    particle.y = from.y + (this.rng() - 0.5) * 2;
    particle.tx = to.x;
    particle.ty = to.y;
    particle.anchorId = to.id;
    particle.arrival = arrival;
    particle.ttl = 14;
    particle.r = to.color[0];
    particle.g = to.color[1];
    particle.b = to.color[2];
    return particle;
  }

  private toOrbit(particle: Particle, anchor: AnchorState): void {
    particle.mode = "orbit";
    particle.anchorId = anchor.id;
    particle.angle = this.rng() * Math.PI * 2;
    particle.spin = (this.rng() > 0.5 ? 1 : -1) * (0.8 + this.rng() * 1.4);
    particle.radius = anchor.id === "core" ? 2.2 + this.rng() * 3.4 : 1.8 + this.rng() * 3.2;
    particle.ttl = 30 + this.rng() * 60;
    particle.r = anchor.color[0];
    particle.g = anchor.color[1];
    particle.b = anchor.color[2];
  }

  private toScatter(particle: Particle): void {
    particle.mode = "scatter";
    const direction = this.rng() * Math.PI * 2;
    const speed = 8 + this.rng() * 16;
    particle.vx = Math.cos(direction) * speed;
    particle.vy = Math.sin(direction) * speed * 0.6;
    particle.ttl = Math.min(particle.ttl, 0.9 + this.rng() * 0.7);
  }

  private emitStream(fromId: string, toId: string, count: number, arrival: "orbit" | "vanish") {
    const from = fromId === "core" ? this.core : this.anchorStates.get(fromId);
    const to = toId === "core" ? this.core : this.anchorStates.get(toId);
    if (!from || !to) {
      return;
    }
    for (let i = 0; i < count && this.particles.length < MAX_PARTICLES; i++) {
      this.particles.push(this.makeStream(from, to, arrival));
    }
  }

  private returnCluster(clusterId: string): void {
    let moved = 0;
    for (const particle of this.particles) {
      if (particle.mode === "orbit" && particle.anchorId === clusterId) {
        particle.mode = "stream";
        particle.tx = this.core.x;
        particle.ty = this.core.y;
        particle.anchorId = "core";
        particle.arrival = moved++ % 3 === 0 ? "orbit" : "vanish";
        particle.ttl = 10;
        particle.r = CORE_COLOR[0];
        particle.g = CORE_COLOR[1];
        particle.b = CORE_COLOR[2];
      }
    }
  }

  private scatterCluster(clusterId: string): void {
    for (const particle of this.particles) {
      if (particle.mode === "orbit" && particle.anchorId === clusterId) {
        this.toScatter(particle);
        particle.r = CONFLICT_COLOR[0];
        particle.g = CONFLICT_COLOR[1];
        particle.b = CONFLICT_COLOR[2];
      }
    }
  }

  private emitSparks(clusterId: string, otherId?: string): void {
    const from = this.anchorStates.get(clusterId);
    const to = otherId ? this.anchorStates.get(otherId) : this.core;
    if (!from) {
      return;
    }
    const target = to ?? this.core;
    for (let i = 0; i < 10 && this.particles.length < MAX_PARTICLES; i++) {
      const particle = this.makeAmbient();
      particle.mode = "spark";
      const blend = this.rng();
      particle.x = from.x + (target.x - from.x) * blend * 0.2;
      particle.y = from.y + (target.y - from.y) * blend * 0.2;
      const dx = target.x - from.x;
      const dy = target.y - from.y;
      const dist = Math.max(1, Math.hypot(dx, dy));
      const speed = 34 + this.rng() * 18;
      particle.vx = (dx / dist) * speed + (this.rng() - 0.5) * 8;
      particle.vy = ((dy / dist) * speed + (this.rng() - 0.5) * 6) * 0.6;
      particle.ttl = 0.5 + this.rng() * 0.5;
      particle.r = CONFLICT_COLOR[0];
      particle.g = CONFLICT_COLOR[1];
      particle.b = CONFLICT_COLOR[2];
      this.particles.push(particle);
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
