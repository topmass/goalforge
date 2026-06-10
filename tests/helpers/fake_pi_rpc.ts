// Scripted stand-in for `pi --mode rpc` used by PiRpcClient tests. Speaks the
// JSONL protocol on stdio: id-correlated responses plus streamed events. Turn
// content branches on prompt text the same way the Codex test fakes do.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

let currentSession = `/tmp/fake-pi/session-${crypto.randomUUID()}.jsonl`;
let sessionName: string | undefined;
let cloneCounter = 0;
const messages: Array<{ role: string; content: string }> = [];

function write(payload: Record<string, unknown>): void {
  Deno.stdout.writeSync(encoder.encode(`${JSON.stringify(payload)}\n`));
}

function respond(
  command: Record<string, unknown>,
  data: Record<string, unknown> = {},
  success = true,
): void {
  write({
    type: "response",
    command: command.type,
    ...(command.id !== undefined ? { id: command.id } : {}),
    success,
    data,
  });
}

function streamText(text: string): void {
  for (const piece of text.match(/.{1,40}/gs) ?? []) {
    write({
      type: "message_update",
      message: {},
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: piece },
    });
  }
}

function runPrompt(message: string): void {
  messages.push({ role: "user", content: message });
  write({ type: "agent_start" });
  write({ type: "turn_start" });
  let reply = "Fake pi acknowledged the prompt.";
  if (message.includes("persistent GoalForge main thread")) {
    reply = "Project memory thread is ready.";
  } else if (message.includes("GoalForge test engineer")) {
    reply = "VERIFICATION_PASSED\n- Fake pi verified the change.";
  } else if (message.includes("APPROVED or CHANGES_REQUESTED")) {
    reply = "APPROVED\n- Fake pi review passed.";
  } else if (message.includes("Absorb this completed GoalForge task")) {
    reply = "Absorbed.";
  } else if (message.includes("GoalForge Codex worker")) {
    const outputPath = `${Deno.cwd()}/fake-pi-output.txt`;
    write({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "write",
      args: { path: "fake-pi-output.txt", content: "fake pi implementation\n" },
    });
    Deno.writeTextFileSync(outputPath, "fake pi implementation\n");
    write({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "write",
      result: { content: [{ type: "text", text: "wrote fake-pi-output.txt" }] },
      isError: false,
    });
    write({
      type: "tool_execution_start",
      toolCallId: "call-2",
      toolName: "bash",
      args: { command: "echo implementation done" },
    });
    write({
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "bash",
      result: { content: [{ type: "text", text: "implementation done" }] },
      isError: false,
    });
    reply = "Implemented the task and validated it. Handoff: wrote fake-pi-output.txt.";
  }
  streamText(reply);
  messages.push({ role: "assistant", content: reply });
  write({ type: "turn_end", message: {}, toolResults: [] });
  write({ type: "agent_end", messages: [] });
}

function handle(command: Record<string, unknown>): void {
  switch (command.type) {
    case "get_state":
      respond(command, {
        model: { id: "fake-model" },
        isStreaming: false,
        sessionFile: currentSession,
        sessionId: currentSession,
        ...(sessionName ? { sessionName } : {}),
        messageCount: messages.length,
      });
      return;
    case "switch_session":
      currentSession = String(command.sessionPath ?? currentSession);
      respond(command, { cancelled: false });
      return;
    case "clone":
      respond(command, { cancelled: false });
      currentSession = `${currentSession.replace(/\.jsonl$/, "")}-clone-${++cloneCounter}.jsonl`;
      return;
    case "set_session_name":
      sessionName = String(command.name ?? "");
      respond(command);
      return;
    case "get_messages":
      respond(command, { messages });
      return;
    case "compact":
      respond(command, { summary: "compacted", firstKeptEntryId: "x", tokensBefore: 10 });
      return;
    case "steer":
      messages.push({ role: "user", content: `steer: ${String(command.message ?? "")}` });
      respond(command);
      return;
    case "abort":
    case "follow_up":
      respond(command);
      return;
    case "prompt":
      respond(command);
      runPrompt(String(command.message ?? ""));
      return;
    default:
      respond(command, {}, false);
  }
}

let buffer = "";
for await (const chunk of Deno.stdin.readable) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch {
        // Ignore malformed test input.
      }
    }
    newline = buffer.indexOf("\n");
  }
}
