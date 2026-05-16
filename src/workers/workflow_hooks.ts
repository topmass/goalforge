import { WorkflowHookStage, WorkflowRuntime } from "../workflow/workflow.ts";

export async function runWorkflowHooks(
  workflow: WorkflowRuntime,
  stage: WorkflowHookStage,
  cwd: string,
): Promise<string[]> {
  const outputs: string[] = [];
  for (const hook of workflow.hooks[stage]) {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), hook.timeoutMs);
    let output: Deno.CommandOutput;
    try {
      output = await new Deno.Command("bash", {
        args: ["-lc", hook.command],
        cwd,
        stdout: "piped",
        stderr: "piped",
        signal: abort.signal,
      }).output();
    } catch (error) {
      throw new Error(
        `Workflow hook ${stage} failed: ${hook.command}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timeout);
    }
    const stdout = new TextDecoder().decode(output.stdout).trim();
    const stderr = new TextDecoder().decode(output.stderr).trim();
    const text = [stdout, stderr].filter(Boolean).join("\n");
    if (!output.success) {
      throw new Error(
        `Workflow hook ${stage} failed: ${hook.command}${text ? `\n${text}` : ""}`,
      );
    }
    outputs.push(text || `Workflow hook ${stage} completed: ${hook.command}`);
  }
  return outputs;
}
