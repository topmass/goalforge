import { ActivityEventInput } from "../board/types.ts";
import { LoopForgeConfig, readConfig } from "../board/store.ts";

export interface CodexEventHandler {
  (event: ActivityEventInput): void;
}

export interface CodexSession {
  threadId: string;
  cwd: string;
}

export interface CodexSessionOptions {
  name?: string;
  baseInstructions?: string;
  developerInstructions?: string;
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

export interface CodexThreadReadResult {
  threadId: string;
  name: string | null;
  status: string | null;
  turnCount: number;
  raw: unknown;
}

export interface CodexThreadListResult {
  threads: unknown[];
  cursor: string | null;
}

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (reason: Error) => void;
}

export interface CodexClient {
  startSession(cwd: string, options?: CodexSessionOptions): Promise<CodexSession>;
  resumeSession(
    cwd: string,
    threadId: string,
    options?: CodexSessionOptions,
  ): Promise<CodexSession>;
  forkSession?(
    cwd: string,
    threadId: string,
    options?: CodexSessionOptions,
  ): Promise<CodexSession>;
  runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult>;
  setThreadName?(session: CodexSession, name: string): Promise<void>;
  readThread?(session: CodexSession, includeTurns?: boolean): Promise<CodexThreadReadResult>;
  listThreads?(options?: { limit?: number; searchTerm?: string }): Promise<CodexThreadListResult>;
  compactThread?(session: CodexSession): Promise<void>;
  steerTurn?(session: CodexSession, message: string): Promise<void>;
  interruptTurn?(session: CodexSession): Promise<void>;
  stop(): Promise<void>;
}

export class CodexAppServerClient implements CodexClient {
  private child: Deno.ChildProcess | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();

  constructor(
    private readonly onEvent: CodexEventHandler = () => {},
    private readonly settings: Pick<LoopForgeConfig, "model" | "reasoningEffort" | "fastMode"> =
      readConfig(Deno.cwd()),
  ) {}

  async startSession(cwd: string, options: CodexSessionOptions = {}): Promise<CodexSession> {
    this.start(cwd);
    const result = await this.request("thread_start", {
      cwd,
      model: this.settings.model,
      sandbox: "full_access",
      name: options.name,
      baseInstructions: options.baseInstructions,
      developerInstructions: options.developerInstructions,
    });
    return {
      threadId: stringResult(result.threadId, "Codex SDK bridge did not return a thread id."),
      cwd,
    };
  }

  async resumeSession(
    cwd: string,
    threadId: string,
    options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    this.start(cwd);
    const result = await this.request("thread_resume", {
      cwd,
      threadId,
      name: options.name,
      baseInstructions: options.baseInstructions,
      developerInstructions: options.developerInstructions,
    });
    return {
      threadId: stringResult(
        result.threadId,
        "Codex SDK bridge did not return a resumed thread id.",
      ),
      cwd,
    };
  }

  async forkSession(
    cwd: string,
    threadId: string,
    options: CodexSessionOptions = {},
  ): Promise<CodexSession> {
    this.start(cwd);
    const result = await this.request("thread_fork", {
      cwd,
      threadId,
      model: this.settings.model,
      sandbox: "full_access",
      name: options.name,
      baseInstructions: options.baseInstructions,
      developerInstructions: options.developerInstructions,
    });
    return {
      threadId: stringResult(
        result.threadId,
        "Codex SDK bridge did not return a forked thread id.",
      ),
      cwd,
    };
  }

  async runTurn(session: CodexSession, input: CodexTurnInput): Promise<CodexTurnResult> {
    this.start(session.cwd);
    const result = await this.request("turn_run", {
      threadId: session.threadId,
      cwd: session.cwd,
      title: input.title,
      prompt: input.prompt,
      model: this.settings.model,
      effort: this.settings.reasoningEffort,
      fastMode: this.settings.fastMode,
      sandbox: "full_access",
    });
    return {
      threadId: stringResult(result.threadId, "Codex SDK bridge did not return a turn thread id."),
      turnId: typeof result.turnId === "string" ? result.turnId : "sdk-turn",
      status: typeof result.status === "string" ? result.status : "completed",
      completed: typeof result.completed === "boolean" ? result.completed : true,
    };
  }

  async setThreadName(session: CodexSession, name: string): Promise<void> {
    this.start(session.cwd);
    await this.request("thread_set_name", { threadId: session.threadId, name });
  }

  async readThread(
    session: CodexSession,
    includeTurns = false,
  ): Promise<CodexThreadReadResult> {
    this.start(session.cwd);
    const result = await this.request("thread_read", {
      threadId: session.threadId,
      includeTurns,
    });
    return {
      threadId: stringResult(result.threadId, "Codex SDK bridge did not return thread read id."),
      name: typeof result.name === "string" ? result.name : null,
      status: typeof result.status === "string" ? result.status : null,
      turnCount: typeof result.turnCount === "number" ? result.turnCount : 0,
      raw: result.raw,
    };
  }

  async compactThread(session: CodexSession): Promise<void> {
    this.start(session.cwd);
    await this.request("thread_compact", { threadId: session.threadId });
  }

  async listThreads(
    options: { limit?: number; searchTerm?: string } = {},
  ): Promise<CodexThreadListResult> {
    this.start(Deno.cwd());
    const result = await this.request("thread_list", {
      limit: options.limit,
      searchTerm: options.searchTerm,
    });
    return {
      threads: Array.isArray(result.threads) ? result.threads : [],
      cursor: typeof result.cursor === "string" ? result.cursor : null,
    };
  }

  async steerTurn(session: CodexSession, message: string): Promise<void> {
    this.start(session.cwd);
    await this.request("turn_steer", {
      threadId: session.threadId,
      cwd: session.cwd,
      message,
    });
  }

  async interruptTurn(session: CodexSession): Promise<void> {
    this.start(session.cwd);
    await this.request("turn_interrupt", {
      threadId: session.threadId,
      cwd: session.cwd,
    });
  }

  async stop(): Promise<void> {
    if (this.writer) {
      await this.request("stop", {}).catch(() => {});
    }
    for (const pending of this.pending.values()) {
      pending.reject(new Error("Codex SDK bridge stopped."));
    }
    this.pending.clear();
    await this.writer?.close().catch(() => {});
    this.child?.kill("SIGTERM");
    this.child = null;
    this.writer = null;
  }

  private start(cwd: string): void {
    if (this.child) {
      return;
    }
    const command = new Deno.Command("uv", {
      args: [
        "run",
        "--prerelease=allow",
        "--with",
        "openai-codex",
        "python",
        new URL("../../scripts/loopforge_codex_bridge.py", import.meta.url).pathname,
      ],
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
        for (const pending of this.pending.values()) {
          pending.reject(new Error(`Codex SDK bridge exited with code ${status.code}.`));
        }
        this.pending.clear();
      }
    });
  }

  private async request(op: string, params: unknown): Promise<JsonObject> {
    const id = this.nextId++;
    const response = new Promise<JsonObject>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.send({ id, op, params });
    return await response;
  }

  private async send(payload: JsonObject): Promise<void> {
    if (!this.writer) {
      throw new Error("Codex SDK bridge is not running.");
    }
    await this.writer.write(this.encoder.encode(`${JSON.stringify(payload)}\n`));
  }

  private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
    for await (const line of lines(stream)) {
      const payload = safeJson(line);
      if (!payload) {
        this.emit("codex", "stdout", line, line);
        continue;
      }
      if (payload.fatal) {
        for (const pending of this.pending.values()) {
          pending.reject(new Error(String(payload.fatal)));
        }
        this.pending.clear();
        this.emit("codex", "error", String(payload.fatal), payload);
        continue;
      }
      if (payload.event && typeof payload.event === "object") {
        const event = payload.event as JsonObject;
        this.emit(
          typeof event.role === "string" ? event.role : "codex",
          typeof event.kind === "string" ? event.kind : "event",
          typeof event.message === "string" ? event.message : "",
          event.raw ?? payload,
        );
        continue;
      }
      if (typeof payload.id === "number" && "result" in payload) {
        const pending = this.pending.get(payload.id);
        if (pending) {
          this.pending.delete(payload.id);
          pending.resolve(payload.result as JsonObject);
        }
        continue;
      }
      if (typeof payload.id === "number" && "error" in payload) {
        const pending = this.pending.get(payload.id);
        if (pending) {
          this.pending.delete(payload.id);
          pending.reject(new Error(JSON.stringify(payload.error)));
        }
      }
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    for await (const line of lines(stream)) {
      this.emit("codex", "stderr", line, line);
    }
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

function stringResult(value: unknown, message: string): string {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  throw new Error(message);
}
