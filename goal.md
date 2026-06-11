Build the first working MVP of LoopForge in /home/matthew/Code/loopforge.

LoopForge is a CLI-first local Codex orchestration tool. It combines the strongest parts of OpenAI
Symphony and Uncle Bob's SwarmForge: a local kanban board for goals/tasks, Codex App Server workers,
git worktree isolation, structured role prompts, strong verification gates, and live terminal-style
agent activity in the GUI.

Current repo state:

- Path: /home/matthew/Code/loopforge
- GitHub: https://github.com/topmass/loopforge
- Visibility: private
- Branch: main
- Repo is intentionally empty except for git.

Core product requirements:

1. Use Deno 2 + TypeScript for the local daemon/CLI unless inspection shows a serious blocker.
2. Build a local-first app with SQLite-backed state under .loopforge/.
3. Provide a CLI named loopforge with at least:
   - loopforge init
   - loopforge goal "<goal text>"
   - loopforge board or loopforge serve
   - loopforge run
4. Build a local web GUI with:
   - interactive kanban board
   - task detail/workpad panel
   - live command-center section below the board
   - terminal-style cards/panels showing live agent activity streams
5. Do not embed tmux in the GUI. The command center should render captured agent/Codex/process
   output as terminal-style UI.
6. Design the daemon as the source of truth. Both users and agents interact through daemon
   APIs/tools, not by mutating board files directly.
7. Use WebSocket or SSE for live updates from daemon to GUI.
8. Use Codex App Server over stdio as the intended worker transport. Do not rely on experimental
   websocket transport for the core.
9. Include a Codex App Server client abstraction that can:
   - spawn codex app-server
   - send initialize / initialized
   - start or resume a thread
   - start a turn
   - parse streamed JSONL events
   - store raw events and derived readable activity
10. Use real Codex App Server worker execution for user-facing task runs. Automated tests may inject
    a controlled Codex client, but the product path must run Codex.
11. Use git worktrees for task isolation. A task should map to its own branch/worktree once active.
12. Add board/task state transitions:

- Inbox
- Ready
- Started
- Review
- Waiting
- Done

13. Add state-transition validation so agents can request transitions but the daemon arbitrates
    them.
14. Adapt Symphony's workflow prompt ideas into LoopForge's local-board model:

- persistent task workpad
- status routing
- compile a user's rough feature request into one strong Codex-ready prompt under 4,000 characters
- reproduce first
- acceptance criteria
- validation before review
- review/rework loop
- continuation turns while a task remains active
- discovered extra work becomes a new task, not silent scope creep

15. Adapt SwarmForge's benefits:

- layered constitution/project/engineering/workflow prompt structure
- role-specific compiler/worker/reviewer prompts
- work only in assigned worktree
- explicit handoff format with branch, commit, files changed, validation evidence
- queued messages/events when an agent is busy

16. Keep the first implementation pragmatic. Build a real vertical slice rather than a huge
    unfinished framework.

Suggested first vertical slice:

- loopforge init creates .loopforge/, SQLite DB, config, prompt templates, and required ignored
  runtime folders. If the folder is not yet a git repository, it bootstraps one and creates a
  baseline commit so worktrees can see the project.
- loopforge goal uses Codex to compile the user's rough request into one worker prompt and creates
  an initial task on the board.
- loopforge serve starts the daemon and GUI.
- GUI displays the kanban board and command center.
- loopforge run or a GUI button starts a real Codex worker that streams activity into the command
  center and moves a task through Started -> Review.
- loopforge run or the GUI Start LoopForge action asks the scheduler which queued goals can run
  together and processes a safe batch.
- loopforge review or the GUI Review action starts a Codex reviewer and appends review evidence to
  the task before merge.
- Codex App Server client exists behind an interface and is the default production worker path.
- Tests may use injected controlled Codex clients only to avoid spending turns during automated
  checks.

Verification requirements:

- Run formatter/linter/typecheck.
- Run unit tests for board schema, state transitions, event log, and scheduler basics.
- Run an integration test or scripted check proving:
  - init creates the expected files
  - a goal can be created
  - serve starts
  - Codex worker emits live events
  - GUI can load and show board state
- If GUI is implemented, use browser-harness or Playwright-style browser verification to open it,
  inspect the board, trigger a Codex run, and confirm live command-center output appears.
- Do not claim it works without running the exact changed paths.

Do not create extra markdown documentation unless explicitly needed. If a short README is necessary
for package/tool usage, keep it minimal. Follow the repo/user AGENTS.md instructions, use pnpm
instead of npm if package management is needed, and keep changes focused on this MVP.
