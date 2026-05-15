import path from "node:path";
import { Task } from "../board/types.ts";
import { worktreesPath } from "../paths.ts";

export interface WorktreeAssignment {
  branchName: string;
  worktreePath: string;
}

export async function prepareTaskWorktree(root: string, task: Task): Promise<WorktreeAssignment> {
  const branchName = `goalforge/${task.id.toLowerCase()}`;
  const worktreePath = path.join(worktreesPath(root), task.id);

  if (!await isGitRepo(root)) {
    await Deno.mkdir(worktreePath, { recursive: true });
    return { branchName, worktreePath };
  }

  try {
    await Deno.stat(path.join(worktreePath, ".git"));
    return { branchName, worktreePath };
  } catch {
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
    return { branchName, worktreePath };
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

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await runCommand(root, ["git", "rev-parse", "--is-inside-work-tree"]);
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
