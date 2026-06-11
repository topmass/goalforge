# GoalForge

A local Kanban board that runs coding agents for you. Describe a goal, and GoalForge plans it into
tasks, runs each task in an isolated git worktree, supervises the agent live, verifies the work with
an independent test pass that fails closed, reviews, merges, and closes the goal only when real
evidence exists. A terminal command center shows the board, the agents, and a particle visualization
of everything in flight.

## Requirements

- [Deno](https://deno.com) (runs the CLI and server)
- git
- For the default Codex backend: [`uv`](https://docs.astral.sh/uv/) and a logged-in
  [Codex CLI](https://developers.openai.com/codex) (`codex login`)
- Optional: [Bun](https://bun.sh) for the full OpenTUI command center (falls back to a native TUI
  without it)
- Optional: [pi](https://pi.dev) for the Claude and local-model backends
  (`pnpm add -g @earendil-works/pi-coding-agent`)

Check your setup any time with `goalforge doctor`.

## Install

```bash
git clone https://github.com/topmass/goalforge.git
cd goalforge
ln -s "$PWD/goalforge" ~/.local/bin/goalforge   # any directory on your PATH
```

## Use it on any project

Point GoalForge at the folder you want it to work in, either by `cd`-ing there or with `-C`:

```bash
cd ~/code/my-project && goalforge        # opens the command center for that project
goalforge -C ~/code/my-project           # same, from anywhere
```

The first run initializes `.goalforge/` (board database, worktrees, config) and a `WORKFLOW.md`
contract inside that project. Everything GoalForge does is scoped to that folder.

Common commands:

```bash
goalforge build "add a dark mode toggle"   # plan a goal, run it, close it with evidence
goalforge goal "refactor the auth flow"    # plan only; review tasks before running
goalforge run --all                        # run everything that is ready
goalforge status                           # board, goals, and evidence at a glance
goalforge health                           # readiness and the next recommended action
goalforge check                            # run the goal's win-condition probes
goalforge standup                          # digest: shipped, blocked asks, win conditions
```

## Let it run overnight

Goals get **win conditions**: executable probes the planner writes alongside the tasks (curl checks,
test commands, file checks). A goal can only close when every probe passes, and `pursue` keeps
working a goal until they do:

```bash
goalforge pursue GOAL-1 --hours 8          # run, probe, replan from failures, repeat
goalforge pursue --all --hours 8           # work the whole backlog while you sleep
goalforge pursue GOAL-1 --escalate codex   # local model grinds; stuck passes escalate
```

Repair attempts rotate strategy (minimal fix, then diagnose-first, then rewrite), the same failure
twice triggers escalation or a clean stop with one clear ask, and lessons learned from failures feed
every future prompt. In the morning, `goalforge standup` tells you what shipped with proof and
exactly what needs you.

### Rescue model

Arm a stronger model as the on-call senior engineer: when the working model fails verification N
times, the rescue model reviews the task, the failure, and the actual diff, then tells the worker
exactly how to fix it - it never implements. Toggle it with the highlighted **Rescue** button in the
TUI footer (click to cycle Off, codex, claude, local, pi) or:

```bash
goalforge --rescue codex --rescue-after 2   # saved; works for runs and pursue loops
goalforge --rescue off
```

With rescue armed, pursue loops also use it as the takeover backend when guidance alone is not
enough. Claude as the rescue backend consumes your Anthropic extra usage.

### Planner model

Route goal planning to a stronger model while the workers stay on the main backend: a subscription
model compiles the goal into tasks, win conditions, and overnight replans, and your local model
grinds through the implementation for free. Toggle it with the **Planner** button in the TUI footer
(click to cycle Off, codex, claude, local, pi) or:

```bash
goalforge --planner codex                   # saved; plans and replans on codex
goalforge --planner off                     # planning follows the main backend again
```

In the TUI: Build Goal plans and runs in one click, blocked tasks tell you exactly what they need,
and Reply both answers a blocked agent and restarts it. The bottom footer row holds the config
toggles - Rescue, Planner, and Agents (max concurrent agents) - each a click to cycle.

## Pick the model that does the work

The backend is remembered in `~/.goalforge/config.json`, so set it once:

```bash
goalforge --codex                                   # default: Codex (codex login)
goalforge --local --endpoint http://HOST:8080/v1 \
          --agent-model MODEL_ID                    # any OpenAI-compatible server via pi
goalforge --claude                                  # Claude via pi (uses your Anthropic
                                                    # subscription extra usage or API credits)
goalforge --pi                                      # whatever model pi is configured for
```

`--local` works with llama.cpp, LM Studio, vLLM, or Ollama. For llama.cpp run `llama-server` with
`--jinja` (tool calling) and GoalForge auto-detects the serving context window so sessions compact
before they overflow.

## See other agents on your board

Coding agents you run yourself (Claude Code, Codex CLI) can report their status into the same board
and visualizer:

```bash
goalforge hooks install claude   # or: codex
```

## More

- `WORKFLOW.md` (generated per project): the contract for how agents plan, verify, review, and
  merge, plus authority settings for publishing and blocker triage.
- `AGENTS.md` / `project-specsheet.md`: durable per-project agent context and memory.
- `goalforge help`: every command and flag.
