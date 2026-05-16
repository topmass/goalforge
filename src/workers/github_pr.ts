import { Task } from "../board/types.ts";

export interface PullRequestInfo {
  url: string;
}

export interface PullRequestGate {
  open(task: Task, body: string): Promise<PullRequestInfo>;
  merge(task: Task, pullRequest: PullRequestInfo): Promise<string>;
}

export class GhPullRequestGate implements PullRequestGate {
  constructor(private readonly root: string) {}

  async open(task: Task, body: string): Promise<PullRequestInfo> {
    if (!task.branchName) {
      throw new Error(`${task.id} does not have an assigned branch.`);
    }
    await run(this.root, ["gh", "--version"]);
    await run(this.root, ["git", "push", "-u", "origin", task.branchName]);

    const existing = await tryRun(this.root, [
      "gh",
      "pr",
      "view",
      task.branchName,
      "--json",
      "url",
      "--jq",
      ".url",
    ]);
    if (existing.success && existing.stdout.trim()) {
      return { url: existing.stdout.trim() };
    }

    const created = await run(this.root, [
      "gh",
      "pr",
      "create",
      "--draft",
      "--head",
      task.branchName,
      "--title",
      `${task.id}: ${task.title}`,
      "--body",
      body,
    ]);
    const url = created.stdout.trim().split(/\s+/).find((part) => part.startsWith("http"));
    if (!url) {
      throw new Error(`GitHub PR was created but no URL was returned.\n${created.stdout}`);
    }
    return { url };
  }

  async merge(task: Task, pullRequest: PullRequestInfo): Promise<string> {
    if (!task.branchName) {
      throw new Error(`${task.id} does not have an assigned branch.`);
    }
    await tryRun(this.root, ["gh", "pr", "ready", task.branchName]);
    await ensureRequiredChecksPassed(this.root, task.branchName);
    const output = await run(this.root, [
      "gh",
      "pr",
      "merge",
      task.branchName,
      "--merge",
    ]);
    const base = (await run(this.root, ["git", "rev-parse", "--abbrev-ref", "HEAD"])).stdout
      .trim();
    await run(this.root, ["git", "fetch", "origin", base]);
    await run(this.root, ["git", "merge", "--ff-only", `origin/${base}`]);
    return [pullRequest.url, output.stdout.trim()].filter(Boolean).join("\n");
  }
}

async function ensureRequiredChecksPassed(root: string, branchName: string): Promise<void> {
  const checks = await tryRun(root, [
    "gh",
    "pr",
    "checks",
    branchName,
    "--required",
    "--json",
    "name,bucket",
  ]);
  if (!checks.success) {
    return;
  }
  const parsed = JSON.parse(checks.stdout || "[]") as Array<{ name?: string; bucket?: string }>;
  const failing = parsed.filter((check) =>
    check.bucket && !["pass", "skipping"].includes(check.bucket)
  );
  if (failing.length) {
    throw new Error(
      `GitHub PR checks are not passing: ${
        failing.map((check) => `${check.name ?? "check"}=${check.bucket}`).join(", ")
      }`,
    );
  }
}

async function run(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await tryRun(cwd, args);
  if (!result.success) {
    throw new Error(`${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

async function tryRun(
  cwd: string,
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  try {
    const output = await new Deno.Command(args[0], {
      args: args.slice(1),
      cwd,
      env: { GH_PROMPT_DISABLED: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      success: output.success,
      stdout: new TextDecoder().decode(output.stdout),
      stderr: new TextDecoder().decode(output.stderr),
    };
  } catch (error) {
    return {
      success: false,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}
