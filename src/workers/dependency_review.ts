// Planner-backed dependency revalidation: when every ready task waits on an
// unfinished dependency, one cheap planner turn re-judges the edges under the
// parallelism rule and drops the fake ones. Plans made before parallel-by-
// default chained independent tasks; this unsticks those boards without hand
// surgery. Parsing fails closed: any malformed reply leaves the board alone.

import { Task } from "../board/types.ts";

export function buildDependencyReviewPrompt(gated: Task[], unfinished: Task[]): string {
  const lines = unfinished.map((task) =>
    `- ${task.id} [${task.status}] ${task.title}: ${shortText(task.description, 180)} (current dependsOn: ${
      task.dependencyIds.join(", ") || "none"
    })`
  ).join("\n");
  const rewritable = gated.map((task) => task.id).join(", ");
  return `You are the LoopForge planner re-checking task dependencies on a stuck board.

Nothing can start: every ready task waits on an unfinished dependency. Most edges like
this are fake. PARALLELISM IS THE DEFAULT: a task depends on another ONLY when it
literally consumes that task's output (a file it creates, an API it adds, a schema it
defines). Touching the same project, the same theme, or "it feels like the natural
order" is NOT a dependency. Final validation or integration tasks legitimately depend
on the tasks they validate.

Unfinished tasks on the board:
${lines}

Re-judge dependsOn for these tasks only: ${rewritable}

Reply with JSON only (no markdown, no commentary):
{"dependencies": {"TASK-N": ["TASK-M"], "TASK-K": []}}

Rules:
- Include every re-judged task id as a key.
- Values may only reference task ids listed above.
- When in doubt, remove the edge; verification and review still gate every merge.
`;
}

export function parseDependencyReview(
  responseText: string,
  rewritableIds: string[],
  allIds: string[],
  currentDeps: Map<string, string[]>,
): Map<string, string[]> | null {
  const text = responseText.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const map = record.dependencies && typeof record.dependencies === "object" &&
      !Array.isArray(record.dependencies)
    ? record.dependencies as Record<string, unknown>
    : record;
  const known = new Set(allIds);
  const rewritable = new Set(rewritableIds);
  const result = new Map<string, string[]>();
  for (const [key, value] of Object.entries(map)) {
    if (!rewritable.has(key) || !Array.isArray(value)) {
      continue;
    }
    const deps = [
      ...new Set(
        value.filter((dep): dep is string =>
          typeof dep === "string" && known.has(dep) && dep !== key
        ),
      ),
    ];
    result.set(key, deps);
  }
  if (!result.size) {
    return null;
  }
  const graph = new Map<string, string[]>(currentDeps);
  for (const [id, deps] of result) {
    graph.set(id, deps);
  }
  if (hasCycle(graph)) {
    return null;
  }
  return result;
}

function hasCycle(graph: Map<string, string[]>): boolean {
  const state = new Map<string, "visiting" | "done">();
  const visit = (node: string): boolean => {
    const mark = state.get(node);
    if (mark === "visiting") {
      return true;
    }
    if (mark === "done") {
      return false;
    }
    state.set(node, "visiting");
    for (const dep of graph.get(node) ?? []) {
      if (graph.has(dep) && visit(dep)) {
        return true;
      }
    }
    state.set(node, "done");
    return false;
  };
  for (const node of graph.keys()) {
    if (visit(node)) {
      return true;
    }
  }
  return false;
}

function shortText(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 3)}...` : cleaned;
}
