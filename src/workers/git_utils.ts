import path from "node:path";
import { Task } from "../board/types.ts";
import { worktreesPath } from "../paths.ts";

export interface WorktreeAssignment {
  branchName: string;
  worktreePath: string;
  created: boolean;
}

export async function prepareTaskWorktree(
  root: string,
  task: Task,
  configuredWorktreesDir = worktreesPath(root),
): Promise<WorktreeAssignment> {
  const branchName = `goalforge/${task.id.toLowerCase()}`;
  const worktreeRoot = path.isAbsolute(configuredWorktreesDir)
    ? configuredWorktreesDir
    : path.join(root, configuredWorktreesDir);
  const worktreePath = path.join(worktreeRoot, task.id);

  if (!await isGitRepo(root)) {
    throw new Error("GoalForge workers require a git repository. Run goalforge init first.");
  }

  try {
    await Deno.stat(path.join(worktreePath, ".git"));
    await ensureWorktreeExcludes(worktreePath);
    return { branchName, worktreePath, created: false };
  } catch {
    await Deno.mkdir(worktreeRoot, { recursive: true });
    await runCommand(root, [
      "git",
      "worktree",
      "add",
      "--force",
      "-B",
      branchName,
      worktreePath,
      "HEAD",
    ]);
    await ensureWorktreeExcludes(worktreePath);
    return { branchName, worktreePath, created: true };
  }
}

export async function gitStatus(cwd: string): Promise<string> {
  return await runCommand(cwd, ["git", "status", "--short"]);
}

export async function gitDiffStat(cwd: string): Promise<string> {
  return await runCommand(cwd, ["git", "diff", "--stat"]);
}

export async function gitCommitAll(cwd: string, message: string): Promise<string | null> {
  if (!await isGitRepo(cwd)) {
    return null;
  }

  const status = await gitStatus(cwd);
  if (!status.trim()) {
    return null;
  }

  await ensureWorktreeExcludes(cwd);
  await runCommand(cwd, ["git", "add", "-A"]);
  await runCommand(cwd, [
    "git",
    "-c",
    "user.email=goalforge@local",
    "-c",
    "user.name=GoalForge",
    "commit",
    "-m",
    message,
  ]);
  return (await runCommand(cwd, ["git", "rev-parse", "--short", "HEAD"])).trim();
}

export async function ensureWorktreeExcludes(cwd: string): Promise<void> {
  const excludePath = (await runCommand(cwd, ["git", "rev-parse", "--git-path", "info/exclude"]))
    .trim();
  const current = await Deno.readTextFile(excludePath).catch(() => "");
  const additions = [".omx/", ".goalforge/"].filter((entry) =>
    !current.split(/\r?\n/).includes(entry)
  );
  if (!additions.length) {
    return;
  }
  const prefix = current && !current.endsWith("\n") ? "\n" : "";
  await Deno.writeTextFile(excludePath, `${current}${prefix}${additions.join("\n")}\n`);
}

export async function gitMergeBranch(root: string, branchName: string): Promise<string> {
  return await runCommand(root, [
    "git",
    "merge",
    "--no-ff",
    branchName,
    "-m",
    `Merge ${branchName}`,
  ]);
}

export async function ensureGitRepository(root: string): Promise<string[]> {
  const actions: string[] = [];
  if (!await isGitRepo(root)) {
    await runCommand(root, ["git", "init", "-b", "main"]);
    actions.push("Initialized git repository.");
  }

  if (!await hasHeadCommit(root)) {
    await runCommand(root, ["git", "add", "-A"]);
    await runCommand(root, [
      "git",
      "-c",
      "user.email=goalforge@local",
      "-c",
      "user.name=GoalForge",
      "commit",
      "--allow-empty",
      "-m",
      "GoalForge baseline",
    ]);
    actions.push("Created baseline commit.");
  }

  return actions;
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await runCommand(root, ["git", "rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

async function hasHeadCommit(root: string): Promise<boolean> {
  try {
    await runCommand(root, ["git", "rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export async function runCommand(cwd: string, args: string[]): Promise<string> {
  const [command, ...rest] = args;
  const child = new Deno.Command(command, {
    args: rest,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await child.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (!output.success) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}
