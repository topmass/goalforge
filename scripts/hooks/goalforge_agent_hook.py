#!/usr/bin/env python3
"""GoalForge agent status hook.

Reads a coding-agent lifecycle hook payload (Claude Code or Codex CLI style)
from stdin and reports the agent's state to the local GoalForge server so the
agent shows up in the Active Agents panel and the Agent Flow visualizer.

Registered per agent, for example:
    python3 goalforge_agent_hook.py --agent claude-code

Never blocks or fails the host agent: short timeout, always exits 0.
"""
import json
import os
import sys
import urllib.request

STATE_BY_EVENT = {
    "SessionStart": "working",
    "UserPromptSubmit": "working",
    "PreToolUse": "working",
    "PostToolUse": "working",
    "PreCompact": "working",
    "PostCompact": "working",
    "PermissionRequest": "blocked",
    "Notification": "blocked",
    "Stop": "idle",
    "SessionEnd": "done",
}


def main() -> int:
    agent = "coding-agent"
    args = sys.argv[1:]
    if "--agent" in args:
        index = args.index("--agent")
        if index + 1 < len(args):
            agent = args[index + 1]
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception:
        payload = {}
    event = str(payload.get("hook_event_name") or payload.get("hookEventName") or "")
    if event in ("SubagentStart", "SubagentStop"):
        return 0
    state = STATE_BY_EVENT.get(event)
    if not state:
        return 0
    headline = ""
    tool = payload.get("tool_name") or payload.get("toolName")
    if event in ("PreToolUse", "PostToolUse") and tool:
        headline = f"Using {tool}"
    elif event == "Notification":
        headline = str(payload.get("message") or "Waiting for permission or input")
    elif event == "UserPromptSubmit":
        headline = "Handling a new prompt"
    elif event == "Stop":
        headline = "Finished the last turn"
    elif event == "SessionEnd":
        headline = "Session ended"
    report = {
        "agent": agent,
        "state": state,
        "headline": headline[:200],
        "cwd": str(payload.get("cwd") or os.getcwd()),
        "sessionId": str(payload.get("session_id") or payload.get("sessionId") or ""),
    }
    base = os.environ.get("GOALFORGE_URL")
    if not base:
        port = os.environ.get("GOALFORGE_PORT", "4733")
        base = f"http://127.0.0.1:{port}"
    request = urllib.request.Request(
        f"{base}/api/agents/report",
        data=json.dumps(report).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        urllib.request.urlopen(request, timeout=0.5).read()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
