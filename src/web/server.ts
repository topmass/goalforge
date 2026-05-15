import path from "node:path";
import { BoardStore } from "../board/store.ts";
import { ActivityEvent, TaskStatus } from "../board/types.ts";
import { normalizeRoot, staticPath } from "../paths.ts";
import { CodexClient } from "../workers/codex_app_server.ts";
import { gitMergeBranch } from "../workers/git_utils.ts";
import { GoalPlanner } from "../workers/goal_planner.ts";
import { GoalReviewer } from "../workers/goal_reviewer.ts";
import { GoalForgeWorker } from "../workers/goalforge_worker.ts";

export interface GoalForgeServer {
  url: string;
  shutdown: () => void;
  finished: Promise<void>;
}

type Client = ReadableStreamDefaultController<Uint8Array>;

export interface GoalForgeServerOptions {
  createCodexClient?: (
    onEvent: (
      event: {
        taskId: string | null;
        runId: string | null;
        role: string;
        kind: string;
        message: string;
      },
    ) => void,
  ) => CodexClient;
}

const APP_ROOT = path.normalize(decodeURIComponent(new URL("../../", import.meta.url).pathname));

export function startServer(
  root = Deno.cwd(),
  port = 4733,
  options: GoalForgeServerOptions = {},
): GoalForgeServer {
  const normalizedRoot = normalizeRoot(root);
  const store = new BoardStore(normalizedRoot);
  store.initProject();
  const clients = new Set<Client>();
  const encoder = new TextEncoder();
  let queueRunning = false;

  const send = (client: Client, type: string, payload: unknown) => {
    try {
      client.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
    } catch {
      clients.delete(client);
    }
  };
  const broadcast = (type: string, payload: unknown) => {
    for (const client of clients) {
      send(client, type, payload);
    }
  };
  const broadcastBoard = () => broadcast("board", store.getBoard());
  const broadcastActivity = (event: ActivityEvent) => {
    broadcast("activity", event);
    broadcastBoard();
  };
  const startQueue = () => {
    if (queueRunning) {
      return;
    }
    queueRunning = true;
    queueMicrotask(() => {
      const worker = new GoalForgeWorker(normalizedRoot, store, {
        onEvent: broadcastActivity,
        createCodexClient: options.createCodexClient,
      });
      worker.runQueue().then(() => {
        queueRunning = false;
        broadcastBoard();
      }).catch((error) => {
        queueRunning = false;
        const message = error instanceof Error ? error.message : String(error);
        broadcast("error", { message });
      });
    });
  };

  const abort = new AbortController();
  const server = Deno.serve(
    {
      port,
      signal: abort.signal,
      onListen: ({ hostname, port }) => {
        console.log(`GoalForge listening at http://${hostname}:${port}`);
      },
    },
    async (request) => {
      const url = new URL(request.url);

      try {
        if (url.pathname === "/api/events") {
          let streamController: Client | null = null;
          return new Response(
            new ReadableStream({
              start(controller) {
                streamController = controller;
                clients.add(controller);
                send(controller, "board", store.getBoard());
              },
              cancel() {
                if (streamController) {
                  clients.delete(streamController);
                }
              },
            }),
            {
              headers: {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
              },
            },
          );
        }

        if (url.pathname === "/api/board" && request.method === "GET") {
          return json(store.getBoard());
        }

        if (url.pathname === "/api/goals" && request.method === "POST") {
          const body = await readJson<{ text?: string }>(request);
          const text = body.text?.trim() ?? "";
          if (!text) {
            return json({ error: "Goal text is required." }, 400);
          }
          const planner = new GoalPlanner(normalizedRoot, {
            createCodexClient: options.createCodexClient,
            onEvent: (event) => {
              const activity = store.appendEvent(
                null,
                null,
                event.role,
                event.kind,
                event.message,
              );
              broadcastActivity(activity);
            },
          });
          const drafts = await planner.plan(text);
          const result = store.createGoalWithTasks(text, drafts);
          broadcastBoard();
          return json(result, 201);
        }

        if (url.pathname === "/api/goals/plan" && request.method === "POST") {
          const body = await readJson<{ text?: string }>(request);
          const text = body.text?.trim() ?? "";
          if (!text) {
            return json({ error: "Goal text is required." }, 400);
          }
          const planner = new GoalPlanner(normalizedRoot, {
            createCodexClient: options.createCodexClient,
            onEvent: (event) => {
              const activity = store.appendEvent(
                null,
                null,
                event.role,
                event.kind,
                event.message,
              );
              broadcastActivity(activity);
            },
          });
          const drafts = await planner.plan(text);
          const result = store.createGoalWithTasks(text, drafts);
          broadcastBoard();
          return json(result, 201);
        }

        if (url.pathname === "/api/run" && request.method === "POST") {
          queueMicrotask(() => {
            const worker = new GoalForgeWorker(normalizedRoot, store, {
              onEvent: broadcastActivity,
              createCodexClient: options.createCodexClient,
            });
            worker.runNext().then(broadcastBoard).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              broadcast("error", { message });
            });
          });
          return json({ ok: true });
        }

        if (url.pathname === "/api/run-queue" && request.method === "POST") {
          startQueue();
          return json({ ok: true, running: queueRunning });
        }

        const runMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run$/);
        if (runMatch && request.method === "POST") {
          const taskId = decodeURIComponent(runMatch[1]);
          queueMicrotask(() => {
            const worker = new GoalForgeWorker(normalizedRoot, store, {
              onEvent: broadcastActivity,
              createCodexClient: options.createCodexClient,
            });
            worker.runTask(taskId).then(broadcastBoard).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              broadcast("error", { message });
            });
          });
          return json({ ok: true, taskId });
        }

        const deleteMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
        if (deleteMatch && request.method === "DELETE") {
          const taskId = decodeURIComponent(deleteMatch[1]);
          const event = store.deleteTask(taskId);
          broadcastActivity(event);
          return json({ ok: true, taskId, board: store.getBoard() });
        }

        const transitionMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/transition$/);
        if (transitionMatch && request.method === "POST") {
          const taskId = decodeURIComponent(transitionMatch[1]);
          const body = await readJson<{ status?: TaskStatus; actor?: string; reason?: string }>(
            request,
          );
          if (!body.status) {
            return json({ error: "status is required" }, 400);
          }
          const result = store.requestTransition(taskId, body.status, body.actor, body.reason);
          broadcastActivity(result.event);
          return json(result);
        }

        const mergeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/merge$/);
        if (mergeMatch && request.method === "POST") {
          const taskId = decodeURIComponent(mergeMatch[1]);
          const task = store.getTask(taskId);
          if (!task.branchName) {
            return json({ error: `${task.id} does not have an assigned branch.` }, 400);
          }
          if (task.status !== "review" && task.status !== "done") {
            return json({ error: `${task.id} must be in Review or Done before merge.` }, 400);
          }
          const output = await gitMergeBranch(normalizedRoot, task.branchName);
          const event = store.appendEvent(
            task.id,
            null,
            "merger",
            "merge",
            output.trim() || `Merged ${task.branchName}.`,
          );
          broadcastActivity(event);
          if (task.status === "review") {
            const result = store.requestTransition(
              task.id,
              "done",
              "merger",
              `Merged ${task.branchName}.`,
            );
            broadcastActivity(result.event);
          }
          return json({ ok: true });
        }

        const reviewMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/review$/);
        if (reviewMatch && request.method === "POST") {
          const taskId = decodeURIComponent(reviewMatch[1]);
          const task = store.getTask(taskId);
          if (task.status !== "review") {
            return json({ error: `${task.id} must be in Review before review.` }, 400);
          }
          queueMicrotask(() => {
            const reviewer = new GoalReviewer(normalizedRoot, {
              createCodexClient: options.createCodexClient,
              onEvent: (event) => {
                const activity = store.appendEvent(
                  event.taskId,
                  null,
                  event.role,
                  event.kind,
                  event.message,
                );
                broadcastActivity(activity);
              },
            });
            reviewer.review(task).then((result) => {
              const latest = store.getTask(task.id);
              const reviewText = [
                latest.validation,
                "",
                `GoalForge review: ${result.verdict.toUpperCase()}`,
                result.notes,
              ].filter(Boolean).join("\n");
              store.updateTaskValidation(task.id, reviewText);
              broadcastActivity(
                store.appendEvent(task.id, null, "reviewer", "review", result.verdict),
              );
            }).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              broadcast("error", { message });
            });
          });
          return json({ ok: true });
        }

        return await serveStatic(url.pathname);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return json({ error: message }, 500);
      }
    },
  );

  return {
    url: `http://127.0.0.1:${port}`,
    shutdown: () => abort.abort(),
    finished: server.finished.then(() => store.close()).catch(() => store.close()),
  };
}

async function serveStatic(pathname: string): Promise<Response> {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const target = path.normalize(staticPath(APP_ROOT, file));
  const staticRoot = path.normalize(staticPath(APP_ROOT));
  if (!target.startsWith(staticRoot)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const content = await Deno.readFile(target);
    return new Response(content, {
      headers: {
        "content-type": contentType(target),
        "cache-control": "no-store",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

function contentType(target: string): string {
  if (target.endsWith(".html")) return "text/html; charset=utf-8";
  if (target.endsWith(".css")) return "text/css; charset=utf-8";
  if (target.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

async function readJson<T>(request: Request): Promise<T> {
  return await request.json() as T;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
