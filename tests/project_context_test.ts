import { assertStringIncludes } from "@std/assert";
import { collectAgentsInstructions } from "../src/workers/project_context.ts";

Deno.test("project context collects AGENTS outside runtime folders", async () => {
  const root = Deno.makeTempDirSync();
  try {
    await Deno.writeTextFile(`${root}/AGENTS.md`, "root instruction");
    await Deno.writeTextFile(`${root}/VISION.md`, "build a great local agent OS");
    await Deno.writeTextFile(`${root}/project-specsheet.md`, "current feature facts");
    await Deno.mkdir(`${root}/feature`, { recursive: true });
    await Deno.writeTextFile(`${root}/feature/AGENTS.md`, "feature instruction");
    await Deno.mkdir(`${root}/.loopforge`, { recursive: true });
    await Deno.writeTextFile(`${root}/.loopforge/AGENTS.md`, "runtime instruction");

    const instructions = await collectAgentsInstructions(root);
    assertStringIncludes(instructions, "build a great local agent OS");
    assertStringIncludes(instructions, "current feature facts");
    assertStringIncludes(instructions, "root instruction");
    assertStringIncludes(instructions, "feature instruction");
    if (instructions.includes("runtime instruction")) {
      throw new Error("Runtime AGENTS.md should not be included.");
    }
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
