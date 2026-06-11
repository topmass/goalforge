// The scout: a routed role that studies the project and proposes next ideas.
// It never builds anything. Ideas land in the board's idea list where the user
// approves (feeds the planner) or rejects (fingerprint remembered forever).
// Each run also re-ranks pending ideas into a build order that reads like a
// roadmap: foundations first, dependents after.

import { BoardStore } from "../board/store.ts";
import { GlobalConfig, readGlobalConfig } from "../board/global_config.ts";
import { ActivityEvent, ActivityEventInput, Idea, IdeaDraft } from "../board/types.ts";
import { CodexClient } from "./codex_app_server.ts";
import { createAgentClient } from "./agent_backend.ts";
import { buildProjectMemory } from "./project_memory.ts";
import { collectAgentsInstructions } from "./project_context.ts";
import { shouldRecordActivity } from "./activity_filter.ts";

export const SCOUT_PENDING_CAP = 8;
export const SCOUT_MAX_NEW_IDEAS = 4;

export interface ScoutOptions {
  onEvent?: (event: ActivityEvent) => void;
  createScoutClient?: (onEvent: (event: ActivityEventInput) => void) => CodexClient;
  config?: GlobalConfig;
}

export interface ScoutReport {
  ran: boolean;
  reason: string;
  added: Idea[];
}

export function createScoutClient(
  root: string,
  onEvent: (event: ActivityEventInput) => void,
  config: GlobalConfig = readGlobalConfig(),
): CodexClient {
  if (config.scout.enabled) {
    return createAgentClient(root, onEvent, { ...config, backend: config.scout.backend });
  }
  return createAgentClient(root, onEvent, config);
}

export async function runScout(
  root: string,
  store: BoardStore,
  options: ScoutOptions = {},
): Promise<ScoutReport> {
  const config = options.config ?? readGlobalConfig();
  if (!config.scout.enabled && !options.createScoutClient) {
    return { ran: false, reason: "Scout is off.", added: [] };
  }
  const pending = store.listIdeas("proposed");
  if (pending.length >= SCOUT_PENDING_CAP) {
    return {
      ran: false,
      reason: `${pending.length} ideas already await review; skipping so the list stays curated.`,
      added: [],
    };
  }

  let responseText = "";
  const factory = options.createScoutClient ??
    ((onEvent: (event: ActivityEventInput) => void) => createScoutClient(root, onEvent, config));
  const codex = factory((event) => {
    if (event.role === "codex" && event.kind === "agent") {
      responseText += event.message;
    }
    if (shouldRecordActivity({ ...event, role: "scout" })) {
      options.onEvent?.(store.appendAgentEvent({ ...event, role: "scout" }));
    }
  });

  try {
    const session = await codex.startSession(root);
    const projectInstructions = await collectAgentsInstructions(root);
    await codex.runTurn(session, {
      title: "GoalForge scout",
      prompt: buildScoutPrompt({
        projectMemory: buildProjectMemory(store),
        projectInstructions,
        pending,
        rejectedTitles: store.listIdeas("rejected").map((idea) => idea.title),
        searchEndpoint: config.search.endpoint,
      }),
    });
    const parsed = parseScoutResponse(responseText, pending);
    const added = store.addIdeas(parsed.ideas.slice(0, SCOUT_MAX_NEW_IDEAS));
    const knownIds = new Map(
      [...pending, ...added].map((idea) => [idea.title.toLowerCase(), idea.id]),
    );
    const orderedIds = parsed.order
      .map((ref) => ref.startsWith("IDEA-") ? ref : knownIds.get(ref.toLowerCase()) ?? "")
      .filter(Boolean);
    store.applyIdeaOrder(orderedIds);
    const event = store.appendEvent(
      null,
      null,
      "scout",
      "ideas",
      added.length
        ? `Scout proposed ${added.length} idea${added.length === 1 ? "" : "s"}: ${
          added.map((idea) => `${idea.id} ${idea.title}`).join("; ")
        }`
        : "Scout found nothing new worth proposing this pass.",
    );
    options.onEvent?.(event);
    return { ran: true, reason: "Scout pass complete.", added };
  } finally {
    await codex.stop().catch(() => {});
  }
}

interface ScoutParseResult {
  ideas: IdeaDraft[];
  order: string[];
}

export function parseScoutResponse(responseText: string, pending: Idea[]): ScoutParseResult {
  const jsonText = extractJson(responseText);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  const rawIdeas = Array.isArray(parsed.ideas) ? parsed.ideas : [];
  const ideas = rawIdeas.flatMap((item): IdeaDraft[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const pitch = typeof record.pitch === "string" ? record.pitch.trim() : "";
    if (!title || !pitch) {
      return [];
    }
    return [{
      title,
      pitch,
      sources: Array.isArray(record.sources)
        ? record.sources.filter((source): source is string => typeof source === "string")
        : [],
      buildsOn: typeof record.buildsOn === "string" ? record.buildsOn : "",
    }];
  });
  const order = Array.isArray(parsed.order)
    ? parsed.order.filter((item): item is string => typeof item === "string")
    : [];
  if (!ideas.length && !order.length && pending.length) {
    throw new Error("Scout response contained no ideas and no ordering.");
  }
  return { ideas, order };
}

function buildScoutPrompt(input: {
  projectMemory: string;
  projectInstructions: string;
  pending: Idea[];
  rejectedTitles: string[];
  searchEndpoint: string;
}): string {
  const searchBlock = input.searchEndpoint
    ? `Web search is available. Use bash to query the configured SearXNG-style endpoint:
  curl -s '${input.searchEndpoint}/search?q=YOUR+QUERY&format=json'
Read result titles, urls, and snippets from the JSON. Fetch a promising page with
curl when its content matters. Search when an idea involves AI integration, new
models, external APIs, or anything where what is state of the art this month
changes the recommendation. Cite the urls you used in that idea's sources array.`
    : "Web search is not configured; propose ideas from the project context alone.";

  return `You are the GoalForge scout. Study this project and propose what to build next.

You never implement anything. You pitch ideas to the human gatekeeper, who approves
or rejects each one. Approved ideas get compiled into goals by the planner.

Rules:
- Output only valid JSON: one object with "ideas" and "order".
- "ideas" is an array of 0 to ${SCOUT_MAX_NEW_IDEAS} NEW idea objects: {title, pitch, sources, buildsOn}.
- title is a short feature name (under 12 words).
- pitch is markdown, under 160 words, with exactly three parts: **What:** one or two
  sentences. **Why it's cool:** the payoff for this project's users. **Why now:** why it
  fits the current state and momentum of the project.
- sources is an array of urls that informed the idea (empty if none).
- buildsOn names one existing idea title or pending idea id this depends on, or "".
- "order" is the COMPLETE recommended build order: every pending idea id listed below
  plus your new idea titles, sequenced so foundations come before dependents and the
  list reads like a roadmap. Standalone ideas rank by impact.
- Propose fewer, better ideas. Zero is a valid answer when nothing clears the bar.
- Never re-propose anything resembling a rejected idea below.
- Ideas must be buildable inside this repository by coding agents in git worktrees.

${searchBlock}

Project context (VISION, specsheet, AGENTS):
${input.projectInstructions}

Current GoalForge board memory:
${input.projectMemory}

Pending ideas awaiting review (re-rank these in "order"):
${
    input.pending.length
      ? input.pending.map((idea) => `- ${idea.id}: ${idea.title}`).join("\n")
      : "- none"
  }

Rejected ideas (never re-pitch these or close variants):
${
    input.rejectedTitles.length
      ? input.rejectedTitles.map((title) => `- ${title}`).join("\n")
      : "- none"
  }
`;
}

function extractJson(responseText: string): string {
  const trimmed = responseText.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return extractJson(fenced[1]);
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  throw new Error("Scout response did not contain JSON.");
}
