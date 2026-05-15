import { assertEquals } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";
import { gitCommitAll, prepareTaskWorktree } from "../src/workers/git_utils.ts";

Deno.test("worktree commits exclude agent runtime folders", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await git(root, ["init", "-b", "main"]);
    await git(root, ["commit", "--allow-empty", "-m", "seed"]);
    const store = new BoardStore(root);
    store.initProject();
    const { task } = store.createGoal("Exclude runtime logs");
    const assignment = await prepareTaskWorktree(root, task);
    await Deno.mkdir(`${assignment.worktreePath}/.omx/logs`, { recursive: true });
    await Deno.writeTextFile(`${assignment.worktreePath}/.omx/logs/turn.jsonl`, "{}\n");
    await Deno.writeTextFile(`${assignment.worktreePath}/result.txt`, "ok\n");

    const commit = await gitCommitAll(assignment.worktreePath, "commit result");
    assertEquals(typeof commit, "string");
    assertEquals(await git(assignment.worktreePath, ["status", "--short"]), "");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function git(root: string, args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args: [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test",
      ...args,
    ],
    cwd: root,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!output.success) {
    throw new Error(new TextDecoder().decode(output.stderr));
  }
  return new TextDecoder().decode(output.stdout);
}
