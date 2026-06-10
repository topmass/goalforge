import { assertStringIncludes } from "@std/assert";
import {
  discoverVerificationGates,
  formatVerificationGates,
} from "../src/workers/verification_gates.ts";
import { BoardStore } from "../src/board/store.ts";

Deno.test("verification gates discover package and deno checks", async () => {
  const root = Deno.makeTempDirSync();
  const store = new BoardStore(root);
  try {
    store.initProject();
    await Deno.writeTextFile(
      `${root}/package.json`,
      JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest" } }),
    );
    await Deno.writeTextFile(
      `${root}/deno.json`,
      JSON.stringify({ tasks: { check: "deno check" } }),
    );
    const { tasks } = store.createGoalWithTasks("Verify gates", [{
      title: "Verify gates",
      description: "Verify gates.",
      acceptanceCriteria: "- Gates are discovered.",
      priority: 100,
      verificationPlan: "- Run a focused smoke check.",
    }]);

    const text = formatVerificationGates(discoverVerificationGates(root, tasks[0]));
    assertStringIncludes(text, "Diff inspection");
    assertStringIncludes(text, "pnpm run typecheck");
    assertStringIncludes(text, "pnpm run test");
    assertStringIncludes(text, "deno task check");
    assertStringIncludes(text, "Run a focused smoke check");
  } finally {
    store.close();
    await Deno.remove(root, { recursive: true });
  }
});
