import path from "node:path";
import { Task } from "../board/types.ts";

export interface VerificationGate {
  name: string;
  command: string | null;
  reason: string;
}

export function discoverVerificationGates(cwd: string, task: Task): VerificationGate[] {
  const gates: VerificationGate[] = [
    {
      name: "Diff inspection",
      command: "git diff --stat && git diff --check",
      reason: "Every task needs a basic changed-file and whitespace sanity check.",
    },
  ];

  for (const line of task.verificationPlan.split(/\r?\n/)) {
    const text = line.replace(/^[-*]\s*/, "").trim();
    if (text) {
      gates.push({ name: "Task verification plan", command: null, reason: text });
    }
  }

  const packageJson = readJson(path.join(cwd, "package.json"));
  const scripts = packageJson && typeof packageJson === "object"
    ? (packageJson as { scripts?: unknown }).scripts
    : null;
  if (scripts && typeof scripts === "object") {
    for (const name of ["typecheck", "check", "lint", "test", "build"]) {
      if (typeof (scripts as Record<string, unknown>)[name] === "string") {
        gates.push({
          name: `package ${name}`,
          command: `pnpm run ${name}`,
          reason: `package.json defines a ${name} script.`,
        });
      }
    }
  }

  if (exists(path.join(cwd, "deno.json")) || exists(path.join(cwd, "deno.jsonc"))) {
    gates.push({
      name: "Deno checks",
      command: "deno task check && deno task test",
      reason: "Deno project detected.",
    });
  }
  if (exists(path.join(cwd, "pyproject.toml"))) {
    gates.push({
      name: "Python tests",
      command: "uv run pytest",
      reason: "Python project metadata detected.",
    });
  }
  if (exists(path.join(cwd, "go.mod"))) {
    gates.push({
      name: "Go tests",
      command: "go test ./...",
      reason: "Go module detected.",
    });
  }
  if (exists(path.join(cwd, "Cargo.toml"))) {
    gates.push({
      name: "Rust tests",
      command: "cargo test",
      reason: "Rust package detected.",
    });
  }

  return dedupeGates(gates).slice(0, 12);
}

export function formatVerificationGates(gates: VerificationGate[]): string {
  if (!gates.length) {
    return "- No verification gates discovered.";
  }
  return gates.map((gate) =>
    `- ${gate.name}: ${gate.command ?? "manual/agent check"} - ${gate.reason}`
  ).join("\n");
}

function dedupeGates(gates: VerificationGate[]): VerificationGate[] {
  const seen = new Set<string>();
  const unique: VerificationGate[] = [];
  for (const gate of gates) {
    const key = `${gate.name}:${gate.command ?? gate.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(gate);
    }
  }
  return unique;
}

function exists(target: string): boolean {
  try {
    Deno.statSync(target);
    return true;
  } catch {
    return false;
  }
}

function readJson(target: string): unknown {
  try {
    return JSON.parse(Deno.readTextFileSync(target));
  } catch {
    return null;
  }
}
