// Executable win conditions. Each goal probe is a shell command with an
// expected outcome (exit 0 plus optional output substring). Probes run
// deterministically at the project root; a goal with probes closes only when
// every probe passes.

import { BoardStore } from "../board/store.ts";
import { GoalProbe } from "../board/types.ts";

export interface ProbeRunResult {
  probe: GoalProbe;
  passed: boolean;
  output: string;
}

export interface ProbeSummary {
  total: number;
  passed: number;
  results: ProbeRunResult[];
}

export async function runGoalProbes(
  root: string,
  store: BoardStore,
  goalId: string,
): Promise<ProbeSummary> {
  const probes = store.listProbes(goalId);
  const results: ProbeRunResult[] = [];
  for (const probe of probes) {
    const result = await runProbeCommand(root, probe);
    store.recordProbeResult(probe.id, result.passed ? "passed" : "failed", result.output);
    results.push({ ...result, probe: store.listProbes(goalId).find((p) => p.id === probe.id)! });
  }
  return {
    total: results.length,
    passed: results.filter((result) => result.passed).length,
    results,
  };
}

async function runProbeCommand(
  root: string,
  probe: GoalProbe,
): Promise<{ probe: GoalProbe; passed: boolean; output: string }> {
  try {
    const child = new Deno.Command("bash", {
      args: ["-lc", probe.command],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const timer = setTimeout(() => child.kill("SIGKILL"), probe.timeoutMs);
    const output = await child.output();
    clearTimeout(timer);
    const text = [
      new TextDecoder().decode(output.stdout),
      new TextDecoder().decode(output.stderr),
    ].join("\n").trim();
    const passed = output.success &&
      (!probe.expectContains || text.includes(probe.expectContains));
    return { probe, passed, output: text.slice(0, 4000) };
  } catch (error) {
    return {
      probe,
      passed: false,
      output: `probe failed to run: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function probeLights(probes: GoalProbe[]): string {
  if (!probes.length) {
    return "";
  }
  return probes
    .map((probe) => probe.lastStatus === "passed" ? "●" : probe.lastStatus === "failed" ? "○" : "◌")
    .join("");
}

export function formatProbeLines(probes: GoalProbe[]): string[] {
  return probes.map((probe) => {
    const mark = probe.lastStatus === "passed"
      ? "PASS"
      : probe.lastStatus === "failed"
      ? "FAIL"
      : "----";
    return `${mark} ${probe.label}`;
  });
}
