import path from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  ".loopforge",
  ".goalforge",
  ".omx",
  "node_modules",
  "vendor",
  "dist",
  "build",
]);

export async function collectAgentsInstructions(root: string): Promise<string> {
  const files: string[] = [];
  await collectAgentsFiles(root, root, files);
  const sections: string[] = [];
  for (const name of ["VISION.md", "project-specsheet.md"]) {
    const content = await safeRead(path.join(root, name));
    if (content.trim()) {
      sections.push(`## ${name}\n${content.trim()}`);
    }
  }
  for (const file of files.slice(0, 20)) {
    const content = await Deno.readTextFile(path.join(root, file));
    sections.push(`## ${file}\n${content.trim()}`);
  }
  if (!sections.length) {
    return "No VISION.md, project-specsheet.md, or AGENTS.md files were found outside LoopForge runtime folders.";
  }
  return limitText(sections.join("\n\n"), 12000);
}

async function collectAgentsFiles(root: string, dir: string, files: string[]): Promise<void> {
  for await (const entry of Deno.readDir(dir)) {
    const fullPath = path.join(dir, entry.name);
    const relative = path.relative(root, fullPath);
    if (entry.isDirectory) {
      if (!SKIP_DIRS.has(entry.name)) {
        await collectAgentsFiles(root, fullPath, files);
      }
      continue;
    }
    if (entry.isFile && entry.name === "AGENTS.md") {
      files.push(relative);
    }
  }
}

function limitText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) {
    return value;
  }
  return value.slice(0, maxCharacters - 80).trimEnd() +
    "\n\n[LoopForge truncated AGENTS.md context to keep prompts bounded.]";
}

async function safeRead(target: string): Promise<string> {
  try {
    return await Deno.readTextFile(target);
  } catch {
    return "";
  }
}
