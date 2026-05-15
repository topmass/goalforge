import { assertStringIncludes } from "@std/assert";
import { collectAgentsInstructions } from "../src/workers/project_context.ts";

Deno.test("project context collects AGENTS outside runtime folders", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await Deno.writeTextFile(`${root}/AGENTS.md`, "root instruction");
    await Deno.mkdir(`${root}/feature`, { recursive: true });
    await Deno.writeTextFile(`${root}/feature/AGENTS.md`, "feature instruction");
    await Deno.mkdir(`${root}/.goalforge`, { recursive: true });
    await Deno.writeTextFile(`${root}/.goalforge/AGENTS.md`, "runtime instruction");

    const instructions = await collectAgentsInstructions(root);
    assertStringIncludes(instructions, "root instruction");
    assertStringIncludes(instructions, "feature instruction");
    if (instructions.includes("runtime instruction")) {
      throw new Error("Runtime AGENTS.md should not be included.");
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
