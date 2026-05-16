import { ActivityEventInput } from "../board/types.ts";
import { GoalForgeConfig, readConfig } from "../board/store.ts";

export interface CodexEventHandler {
  (event: ActivityEventInput): void;
}

export interface CodexSession {
  threadId: string;
  cwd: string;
}

export interface CodexTurnInput {
  prompt: string;
  title: string;
}

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  status: string;
  completed: boolean;
}

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (reason: Error) => void;
}

export interface CodexClient {
  startSession(cwd: string): Promise<CodexSession>;
  resumeSession(cwd: string, threadId: string): Promise<CodexSession>;
  runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult>;
  stop(): Promise<void>;
}

export class CodexAppServerClient implements CodexClient {
  private child: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private activeTurn:
    | {
      threadId: string;
      turnId: string | null;
      resolve: (value: CodexTurnResult) => void;
      reject: (reason: Error) => void;
    }
    | null = null;

  constructor(
    private readonly onEvent: CodexEventHandler = () => {},
    private readonly settings: Pick<GoalForgeConfig, "model" | "reasoningEffort" | "fastMode"> =
      readConfig(Deno.cwd()),
  ) {}

  async startSession(cwd: string): Promise<CodexSession> {
    await this.start(cwd);
    await this.request("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "goalforge",
        title: "GoalForge",
        version: "0.1.0",
      },
    });
    await this.notify("initialized", {});
    const response = await this.request("thread/start", {
      cwd,
      model: this.settings.model,
      serviceTier: this.settings.fastMode ? "fast" : null,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      config: { model_reasoning_effort: this.settings.reasoningEffort },
      serviceName: "GoalForge",
      threadSource: "user",
      sessionStartSource: "startup",
    });
    const thread = response.thread as { id?: string } | undefined;
    if (!thread?.id) {
      throw new Error("Codex App Server did not return a thread id.");
    }
    return { threadId: thread.id, cwd };
  }

  async resumeSession(cwd: string, threadId: string): Promise<CodexSession> {
    await this.start(cwd);
    await this.request("initialize", {
      capabilities: { experimentalApi: true },
      clientInfo: {
        name: "goalforge",
        title: "GoalForge",
        version: "0.1.0",
      },
    });
    await this.notify("initialized", {});
    const response = await this.request("thread/resume", {
      threadId,
      cwd,
      model: this.settings.model,
      serviceTier: this.settings.fastMode ? "fast" : null,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access",
      config: { model_reasoning_effort: this.settings.reasoningEffort },
    });
    const thread = response.thread as { id?: string } | undefined;
    if (!thread?.id) {
      throw new Error("Codex App Server did not return a resumed thread id.");
    }
    return { threadId: thread.id, cwd };
  }

  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    if (this.activeTurn) {
      throw new Error("Codex App Server already has an active turn.");
    }

    const response = await this.request("turn/start", {
      threadId: session.threadId,
      input: [{ type: "text", text: input.prompt, text_elements: [] }],
      cwd: session.cwd,
      model: this.settings.model,
      effort: this.settings.reasoningEffort,
      serviceTier: this.settings.fastMode ? "fast" : null,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
    const turn = response.turn as { id?: string; status?: string } | undefined;
    if (!turn?.id) {
      throw new Error("Codex App Server did not return a turn id.");
    }

    this.emit("codex", "turn", `Started Codex turn ${turn.id}.`, response);

    return await new Promise<CodexTurnResult>((resolve, reject) => {
      this.activeTurn = {
        threadId: session.threadId,
        turnId: turn.id ?? null,
        resolve,
        reject,
      };
    });
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Codex App Server stopped."));
    }
    this.pending.clear();
    this.activeTurn?.reject(new Error("Codex App Server stopped."));
    this.activeTurn = null;
    await this.writer?.close().catch(() => {});
    this.child?.kill("SIGTERM");
    this.child = null;
    this.writer = null;
  }

  private start(cwd: string): void {
    if (this.child) {
      return;
    }
    const command = new Deno.Command("codex", {
      args: ["app-server", "--listen", "stdio://"],
      cwd,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    this.child = command.spawn();
    this.writer = this.child.stdin.getWriter();
    this.readStdout(this.child.stdout);
    this.readStderr(this.child.stderr);
    this.child.status.then((status) => {
      if (!status.success) {
        this.activeTurn?.reject(new Error(`Codex App Server exited with code ${status.code}.`));
      }
    });
  }

  private async request(method: string, params: unknown): Promise<JsonObject> {
    const id = this.nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.send({ id, method, params });
    return await response;
  }

  private async notify(method: string, params: unknown): Promise<void> {
    await this.send({ method, params });
  }

  private async send(payload: JsonObject): Promise<void> {
    if (!this.writer) {
      throw new Error("Codex App Server is not running.");
    }
    await this.writer.write(this.encoder.encode(`${JSON.stringify(payload)}\n`));
  }

  private async respond(id: number | string, result: unknown): Promise<void> {
    await this.send({ id, result });
  }

  private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    for await (const line of lines(stream)) {
      const payload = safeJson(line);
      if (!payload) {
        this.emit("codex", "stdout", line, line);
        continue;
      }
      await this.handlePayload(payload);
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    for await (const line of lines(stream)) {
      this.emit("codex", "stderr", line, line);
    }
  }

  private async handlePayload(payload: JsonObject): Promise<void> {
    if (typeof payload.id === "number" && "result" in payload) {
      const pending = this.pending.get(payload.id);
      if (pending) {
        this.pending.delete(payload.id);
        pending.resolve(payload.result as JsonObject);
      }
      return;
    }

    if (typeof payload.id === "number" && "error" in payload) {
      const pending = this.pending.get(payload.id);
      if (pending) {
        this.pending.delete(payload.id);
        pending.reject(new Error(JSON.stringify(payload.error)));
      }
      return;
    }

    const method = typeof payload.method === "string" ? payload.method : "";
    if (method && typeof payload.id !== "undefined") {
      await this.handleServerRequest(payload.id as number | string, method, payload.params);
      return;
    }

    if (!method) {
      this.emit("codex", "message", "Codex protocol message.", payload);
      return;
    }

    this.handleNotification(method, payload.params as JsonObject | undefined, payload);
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    this.emit("codex", "approval", `Auto-handling ${method}.`, params);

    switch (method) {
      case "item/commandExecution/requestApproval":
        await this.respond(id, { decision: "acceptForSession" });
        break;
      case "item/fileChange/requestApproval":
        await this.respond(id, { decision: "acceptForSession" });
        break;
      case "item/permissions/requestApproval":
        await this.respond(id, { permissions: {}, scope: "session", strictAutoReview: false });
        break;
      case "item/tool/requestUserInput":
        await this.respond(id, { answers: {} });
        break;
      default:
        await this.respond(id, {});
        break;
    }
  }

  private handleNotification(
    method: string,
    params: JsonObject | undefined,
    raw: JsonObject,
  ): void {
    switch (method) {
      case "item/agentMessage/delta":
        this.emit("codex", "agent", String(params?.delta ?? ""), raw);
        break;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        this.emit("codex", "reasoning", String(params?.delta ?? ""), raw);
        break;
      case "item/plan/delta":
        this.emit("codex", "plan", String(params?.delta ?? ""), raw);
        break;
      case "item/commandExecution/outputDelta":
      case "command/exec/outputDelta":
      case "process/outputDelta":
        this.emit("codex", "output", decodeOutputDelta(params), raw);
        break;
      case "item/started":
        this.emit("codex", "item", summarizeItem("Started", params?.item), raw);
        break;
      case "item/completed":
        this.emit("codex", "item", summarizeItem("Completed", params?.item), raw);
        break;
      case "turn/completed":
        this.emit("codex", "turn", "Codex turn completed.", raw);
        this.completeTurn(params, true);
        break;
      case "turn/failed":
      case "error":
        this.emit("codex", "error", summarizeError(params), raw);
        this.failTurn(new Error(summarizeError(params)));
        break;
      default:
        this.emit("codex", method, summarizeNotification(method, params), raw);
        break;
    }
  }

  private completeTurn(params: JsonObject | undefined, completed: boolean): void {
    if (!this.activeTurn) {
      return;
    }
    const turn = params?.turn as { id?: string; status?: string } | undefined;
    this.activeTurn.resolve({
      threadId: this.activeTurn.threadId,
      turnId: turn?.id ?? this.activeTurn.turnId ?? "unknown",
      status: turn?.status ?? "completed",
      completed,
    });
    this.activeTurn = null;
  }

  private failTurn(error: Error): void {
    this.activeTurn?.reject(error);
    this.activeTurn = null;
  }

  private emit(role: string, kind: string, message: string, raw: unknown): void {
    if (!message.trim()) {
      return;
    }
    this.onEvent({
      taskId: null,
      runId: null,
      role,
      kind,
      message,
      raw,
    });
  }
}

async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      if (part.trim()) {
        yield part;
      }
    }
  }
  if (buffer.trim()) {
    yield buffer;
  }
}

function safeJson(line: string): JsonObject | null {
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function decodeOutputDelta(params: JsonObject | undefined): string {
  const delta = params?.delta;
  if (typeof delta !== "string") {
    return "";
  }
  const stream = typeof params?.stream === "string" ? `${params.stream}: ` : "";
  return `${stream}${delta}`;
}

function summarizeItem(prefix: string, item: unknown): string {
  if (!item || typeof item !== "object") {
    return `${prefix} item.`;
  }
  const typed = item as JsonObject;
  const itemType = typeof typed.type === "string" ? typed.type : "item";
  if (typeof typed.command === "string") {
    return `${prefix} ${itemType}: ${typed.command}`;
  }
  if (typeof typed.text === "string") {
    return `${prefix} ${itemType}: ${typed.text.slice(0, 240)}`;
  }
  return `${prefix} ${itemType}.`;
}

function summarizeError(params: unknown): string {
  if (!params) {
    return "Codex turn failed.";
  }
  if (typeof params === "string") {
    return params;
  }
  return JSON.stringify(params);
}

function summarizeNotification(method: string, params: JsonObject | undefined): string {
  if (method === "thread/tokenUsage/updated" && params) {
    return "Token usage updated.";
  }
  if (
    method === "mcpServer/startupStatus/updated" ||
    method === "serverRequest/resolved" ||
    method === "account/rateLimits/updated"
  ) {
    return "";
  }
  return `Codex event: ${method}`;
}
