import path from "node:path";

export const RUNTIME_DIR = ".goalforge";

export function runtimePath(root: string, ...parts: string[]): string {
  return path.join(root, RUNTIME_DIR, ...parts);
}

export function databasePath(root: string): string {
  return runtimePath(root, "board.sqlite");
}

export function configPath(root: string): string {
  return runtimePath(root, "config.json");
}

export function promptsPath(root: string): string {
  return runtimePath(root, "prompts");
}

export function worktreesPath(root: string): string {
  return runtimePath(root, "worktrees");
}

export function runsPath(root: string): string {
  return runtimePath(root, "runs");
}

export function staticPath(root: string, ...parts: string[]): string {
  return path.join(root, "static", ...parts);
}

export function normalizeRoot(root = Deno.cwd()): string {
  return path.resolve(root);
}
