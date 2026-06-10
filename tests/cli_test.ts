import { assertEquals, assertStringIncludes } from "@std/assert";
import { BoardStore } from "../src/board/store.ts";

Deno.test("CLI close-goal closes the active proven goal", async () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-cli-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Close from CLI");
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
        "",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "GoalForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");
    store.close();

    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "close-goal",
        goal.id,
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "GOAL-1 closed.");
    assertStringIncludes(stdout, "1/1 tasks done.");

    const reopened = new BoardStore(root);
    try {
      assertEquals(reopened.getGoal(goal.id).status, "closed");
    } finally {
      reopened.close();
    }
  } finally {
    try {
      store.close();
    } catch {
      // The store is already closed on the success path.
    }
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI goals lists open and closed goals", async () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-cli-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    const { goal, task } = store.createGoal("Closed CLI listing");
    store.requestTransition(task.id, "in_progress");
    store.updateTaskValidation(
      task.id,
      [
        "Turn status: completed",
        "Test turn status: completed",
        "Discovered verification gates:",
        "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
        "",
        "Verification verdict:",
        "VERIFICATION_PASSED",
        "- Focused validation passed with recorded proof.",
        "Commit: abc123",
        "Git status:",
        "clean",
        "GoalForge review: APPROVED",
      ].join("\n"),
    );
    store.updateTaskCard(task.id, "TASK-1 complete.");
    store.updateTaskHandoff(task.id, "Validated and absorbed.");
    store.requestTransition(task.id, "review");
    store.requestTransition(task.id, "done");
    store.closeGoal(goal.id, "Closed before listing.");
    store.createGoal("Open CLI listing");
    store.close();

    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "goals",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "GOAL-1 closed");
    assertStringIncludes(stdout, "Closed CLI listing");
    assertStringIncludes(stdout, "GOAL-2 open: Open CLI listing");
  } finally {
    try {
      store.close();
    } catch {
      // The store is already closed on the success path.
    }
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI health prints project readiness", async () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-cli-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.setMainThread("thread-main", "Project memory ready.");
    store.createGoal("Health CLI listing");
    store.close();

    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "health",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "Project health: Ready To Run");
    assertStringIncludes(stdout, "Main memory: ready thread-main");
    assertStringIncludes(stdout, "Next: TASK-1: start the task or run ready tasks.");
  } finally {
    try {
      store.close();
    } catch {
      // The store is already closed on the success path.
    }
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI help documents main ensure", async () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-cli-" });
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "help",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, 'goalforge build "<goal text>"');
    assertStringIncludes(stdout, "goalforge main status|ensure|reset|absorb");
    assertStringIncludes(stdout, "goalforge dogfood [--live] [--keep]");
    assertStringIncludes(stdout, "goalforge doctor");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI main status includes project health guidance", async () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-cli-" });
  const store = new BoardStore(root);
  try {
    store.initProject();
    store.createGoal("Main status guidance");
    store.close();

    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "main",
        "status",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "Main thread: none");
    assertStringIncludes(stdout, "Project health: Needs Project Memory");
    assertStringIncludes(
      stdout,
      "Next: Open the TUI or run `goalforge main ensure` to create project memory.",
    );
  } finally {
    try {
      store.close();
    } catch {
      // The store is already closed on the success path.
    }
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI doctor reports local prerequisites", async () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-cli-" });
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        new URL("../src/cli.ts", import.meta.url).pathname,
        "doctor",
      ],
      cwd: root,
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
    const stdout = new TextDecoder().decode(output.stdout);
    assertStringIncludes(stdout, "Deno runtime");
    assertStringIncludes(stdout, "Git");
    assertStringIncludes(stdout, "Bun");
    assertStringIncludes(stdout, "uv");
    assertStringIncludes(stdout, "Python 3");
    assertStringIncludes(stdout, "Doctor:");
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});

Deno.test("CLI backend flags persist to the global config and warn for claude", async () => {
  const root = Deno.makeTempDirSync({ prefix: "goalforge-cli-backend-" });
  const home = Deno.makeTempDirSync({ prefix: "goalforge-home-" });
  const run = (...flags: string[]) =>
    new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-run",
        "--allow-net",
        new URL("../src/cli.ts", import.meta.url).pathname,
        ...flags,
        "help",
      ],
      cwd: root,
      env: { GOALFORGE_HOME: home },
      stdout: "piped",
      stderr: "piped",
    }).output();
  try {
    const local = await run(
      "--local",
      "--endpoint",
      "http://100.64.0.7:8080/v1",
      "--agent-model",
      "qwen3-coder",
    );
    assertEquals(local.code, 0, new TextDecoder().decode(local.stderr));
    const localNotice = new TextDecoder().decode(local.stderr);
    assertStringIncludes(localNotice, "local via pi");
    assertStringIncludes(localNotice, "saved for next time");
    const saved = JSON.parse(await Deno.readTextFile(`${home}/config.json`));
    assertEquals(saved.backend, "local");
    assertEquals(saved.local.endpoint, "http://100.64.0.7:8080/v1");
    assertEquals(saved.local.model, "qwen3-coder");

    const claude = await run("--claude");
    const claudeNotice = new TextDecoder().decode(claude.stderr);
    assertStringIncludes(claudeNotice, "extra usage");

    const codex = await run("--codex");
    assertEquals(codex.code, 0);
    const final = JSON.parse(await Deno.readTextFile(`${home}/config.json`));
    assertEquals(final.backend, "codex");
    assertEquals(final.local.endpoint, "http://100.64.0.7:8080/v1");
  } finally {
    Deno.removeSync(root, { recursive: true });
    Deno.removeSync(home, { recursive: true });
  }
});
