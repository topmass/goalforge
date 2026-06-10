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
```

In the TUI: Build Goal plans and runs in one click, blocked tasks tell you exactly what they need,
and Reply both answers a blocked agent and restarts it.

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
