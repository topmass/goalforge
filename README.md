# LoopForge

A local Kanban board that runs coding agents for you. Describe a goal, and LoopForge plans it into
tasks, runs each task in an isolated git worktree, supervises the agent live, verifies the work with
an independent test pass that fails closed, reviews, merges, and closes the goal only when real
evidence exists. A terminal command center shows the board, the agents, and a particle visualization
of everything in flight.

> LoopForge was formerly GoalForge. The `goalforge` command still works as an alias, and existing
> `.goalforge` project state and `~/.goalforge` config are picked up automatically.

## Requirements

- [Deno](https://deno.com) (runs the CLI and server)
- git
- For the default Codex backend: [`uv`](https://docs.astral.sh/uv/) and a logged-in
  [Codex CLI](https://developers.openai.com/codex) (`codex login`)
- Optional: [Bun](https://bun.sh) for the full OpenTUI command center (falls back to a native TUI
  without it)
- Optional: [pi](https://pi.dev) for the Claude and local-model backends
  (`pnpm add -g @earendil-works/pi-coding-agent`)

Check your setup any time with `loopforge doctor`.

## Install

```bash
git clone https://github.com/topmass/loopforge.git
cd loopforge
ln -s "$PWD/loopforge" ~/.local/bin/loopforge   # any directory on your PATH
```

## Use it on any project

Point LoopForge at the folder you want it to work in, either by `cd`-ing there or with `-C`:

```bash
cd ~/code/my-project && loopforge        # opens the command center for that project
loopforge -C ~/code/my-project           # same, from anywhere
```

The first run initializes `.loopforge/` (board database, worktrees, config) and a `WORKFLOW.md`
contract inside that project. Everything LoopForge does is scoped to that folder.

Common commands:

```bash
loopforge build "add a dark mode toggle"   # plan a goal, run it, close it with evidence
loopforge goal "refactor the auth flow"    # plan only; review tasks before running
loopforge run --all                        # run everything that is ready
loopforge status                           # board, goals, and evidence at a glance
loopforge health                           # readiness and the next recommended action
loopforge check                            # run the goal's win-condition probes
loopforge standup                          # digest: shipped, blocked asks, win conditions
```

## The goal loop: one agent owns the goal

The goal loop is LoopForge's native take on Codex /goal and Claude's ralph loops, identical on
every backend: one persistent agent owns the whole goal in its own worktree, plans it into
LOOP_PLAN.md (a plain markdown checklist committed with the work, so a lost session resumes
from disk), and iterates until everything is checked off. LoopForge stays the deterministic
shell around it: it mirrors the checklist onto the board live, commits progress every turn,
feeds failing win conditions back into the loop, and only merges and closes when the probes
actually pass. Attended sessions hold the merge behind your manual-verification checklist;
timed runs merge on a tagged baseline.

```bash
loopforge loop "add a dark mode toggle with tests"   # one step: plan it, then loop it
loopforge loop GOAL-1 --hours 4                      # unattended: merge on green probes
loopforge loop GOAL-1                                # attended: you gate the merge
```

In the TUI, press **Loop New** and describe the goal (or select a task of an existing goal and
press **Loop Goal**); the agent's plan items appear on the board as they're worked.

## Let it run overnight

Goals get **win conditions**: executable probes the planner writes alongside the tasks (curl checks,
test commands, file checks). A goal can only close when every probe passes, and `pursue` keeps
working a goal until they do:

```bash
loopforge pursue GOAL-1 --hours 8          # run, probe, replan from failures, repeat
loopforge pursue --all --hours 8           # work the whole backlog while you sleep
loopforge pursue GOAL-1 --escalate codex   # local model grinds; stuck passes escalate
```

Repair attempts rotate strategy (minimal fix, then diagnose-first, then rewrite), the same failure
twice triggers escalation or a clean stop with one clear ask, and lessons learned from failures feed
every future prompt. In the morning, `loopforge standup` tells you what shipped with proof and
exactly what needs you.

Timed runs are unattended by design: every pursue run first tags the starting commit
(`loopforge/run-<stamp>`), so one `git reset --hard` discards the whole night if you want it gone.
Work an agent could not prove inside the repo merges anyway with an honest note and lands on the
standup's "Needs manual verification" checklist instead of stalling the queue. In attended sessions
the same work is held in Review until you check it by hand - restarting the task merges it
instantly. When something truly does need you, the blocker arrives as a prepared decision brief
(what it is, what was already done, a recommendation, and your exact options), never a raw log dump.

### Rescue model

Arm a stronger model as the on-call senior engineer: when the working model fails verification N
times, the rescue model reviews the task, the failure, and the actual diff, then tells the worker
exactly how to fix it - it never implements. Toggle it with the highlighted **Rescue** button in the
TUI footer (click to cycle Off, codex, claude, local, pi) or:

```bash
loopforge --rescue codex --rescue-after 2   # saved; works for runs and pursue loops
loopforge --rescue off
```

With rescue armed, pursue loops also use it as the takeover backend when guidance alone is not
enough. Claude as the rescue backend consumes your Anthropic extra usage.

### Planner model

Route goal planning to a stronger model while the workers stay on the main backend: a subscription
model compiles the goal into tasks, win conditions, and overnight replans, and your local model
grinds through the implementation for free. Toggle it with the **Planner** button in the TUI footer
(click to cycle Off, codex, claude, local, pi) or:

```bash
loopforge --planner codex                   # saved; plans and replans on codex
loopforge --planner off                     # planning follows the main backend again
```

### Scout: loops that propose what to build next

The scout studies your project (memory, goals, lessons, VISION) and pitches the next ideas, each
with what it is, why it's cool, and why now. It never builds anything: ideas wait in their own list,
in a recommended build order, until you approve or reject them. Approve compiles the idea into a
goal with tasks and win conditions in Ready (zero typing); reject is remembered forever so the same
idea never comes back. During long pursue runs the scout adds one pass per hour, so you wake up to
finished work plus a curated idea list.

```bash
loopforge --scout codex                     # arm the scout (or claude, local, pi)
loopforge scout                             # one scout pass right now
loopforge ideas                             # review: show / approve / reject <id>
```

Ideas also appear in the TUI task rail: select one, read the pitch, press y to approve or n to
reject.

The scout can always try ad-hoc web searches through bash (strong models usually manage on their
own). The reliable upgrade, especially for local models, is a self-hosted SearXNG instance: clean
JSON results from one curl, identical on every backend. Optional setup, on your machine or any
always-on box on your network:

```bash
mkdir -p ~/.config/searxng && cat > ~/.config/searxng/settings.yml <<CONF
use_default_settings: true
server:
  secret_key: "$(openssl rand -hex 24)"
  limiter: false
search:
  formats: [html, json]
CONF
docker run -d --name searxng --restart=always -p 8888:8080 \
  -v ~/.config/searxng:/etc/searxng searxng/searxng
loopforge --search http://127.0.0.1:8888
```

podman works identically (add `:Z` to the volume on SELinux systems; for reboot survival run
`systemctl --user enable podman-restart` and `loginctl enable-linger $USER`). Hosting it on a home
server and pointing every machine's LoopForge at it over your tailnet works great.

In the TUI: Build Goal plans and runs in one click, blocked tasks tell you exactly what they need,
and Reply both answers a blocked agent and restarts it. The bottom footer row holds the config
toggles - Rescue, Planner, Scout, and Agents (max concurrent agents) - each a click to cycle.

## Pick the model that does the work

The backend is remembered in `~/.loopforge/config.json`, so set it once:

```bash
loopforge --codex                                   # default: Codex (codex login)
loopforge --local --endpoint http://HOST:8080/v1 \
          --agent-model MODEL_ID                    # any OpenAI-compatible server via pi
loopforge --claude                                  # Claude via pi (uses your Anthropic
                                                    # subscription extra usage or API credits)
loopforge --pi                                      # whatever model pi is configured for
```

`--local` works with llama.cpp, LM Studio, vLLM, or Ollama. For llama.cpp run `llama-server` with
`--jinja` (tool calling) and LoopForge auto-detects the serving context window so sessions compact
before they overflow.

## See other agents on your board

Coding agents you run yourself (Claude Code, Codex CLI) can report their status into the same board
and visualizer:

```bash
loopforge hooks install claude   # or: codex
```

## More

- `WORKFLOW.md` (generated per project): the contract for how agents plan, verify, review, and
  merge, plus authority settings for publishing and blocker triage.
- `AGENTS.md` / `project-specsheet.md`: durable per-project agent context and memory.
- `loopforge help`: every command and flag.
