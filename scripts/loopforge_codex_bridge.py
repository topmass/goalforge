#!/usr/bin/env python3
from __future__ import annotations

import json
import sys
import threading
import traceback
from pathlib import Path
from typing import Any

try:
    from openai_codex import Codex, Sandbox
except Exception as exc:  # pragma: no cover - exercised only without dependency
    print(
        json.dumps(
            {
                "fatal": (
                    "Unable to import openai_codex. LoopForge runs this bridge with "
                    "`uv run --with openai-codex`; install uv or run `codex login` "
                    f"after fixing the Python environment. Import error: {exc}"
                )
            }
        ),
        flush=True,
    )
    sys.exit(1)


class Bridge:
    def __init__(self) -> None:
        self.codex = Codex()
        self.codex.__enter__()
        self.threads: dict[str, Any] = {}
        self.active_turns: dict[str, Any] = {}
        self.write_lock = threading.Lock()
        self.workers: list[threading.Thread] = []

    def close(self) -> None:
        for worker in list(self.workers):
            worker.join(timeout=0.2)
        self.codex.__exit__(None, None, None)

    def handle(self, message: dict[str, Any]) -> tuple[bool, dict[str, Any] | None]:
        op = message.get("op")
        params = message.get("params") or {}
        if op == "thread_start":
            thread = self.codex.thread_start(
                cwd=params.get("cwd"),
                model=params.get("model"),
                sandbox=sandbox_value(params.get("sandbox")),
                service_name=loopforge_service_name(params.get("cwd")),
                base_instructions=optional_string(params.get("baseInstructions")),
                developer_instructions=optional_string(params.get("developerInstructions")),
            )
            thread_id = thread_id_value(thread)
            set_thread_name(thread, params.get("name"))
            self.threads[thread_id] = thread
            return True, {"threadId": thread_id, "cwd": params.get("cwd")}
        if op == "thread_resume":
            thread_id = str(params["threadId"])
            thread = self.codex.thread_resume(
                thread_id,
                cwd=params.get("cwd"),
                model=params.get("model"),
                sandbox=sandbox_value(params.get("sandbox")),
                base_instructions=optional_string(params.get("baseInstructions")),
                developer_instructions=optional_string(params.get("developerInstructions")),
            )
            set_thread_name(thread, params.get("name"))
            self.threads[thread_id] = thread
            return True, {"threadId": thread_id, "cwd": params.get("cwd")}
        if op == "thread_fork":
            thread_id = str(params["threadId"])
            thread = self.codex.thread_fork(
                thread_id,
                cwd=params.get("cwd"),
                model=params.get("model"),
                sandbox=sandbox_value(params.get("sandbox")),
                base_instructions=optional_string(params.get("baseInstructions")),
                developer_instructions=optional_string(params.get("developerInstructions")),
            )
            child_id = thread_id_value(thread)
            set_thread_name(thread, params.get("name"))
            self.threads[child_id] = thread
            return True, {"threadId": child_id, "cwd": params.get("cwd")}
        if op == "thread_set_name":
            thread_id = str(params["threadId"])
            thread = self.threads.get(thread_id) or self.codex.thread_resume(thread_id)
            self.threads[thread_id] = thread
            thread.set_name(str(params.get("name") or "LoopForge"))
            return True, {"ok": True}
        if op == "thread_read":
            thread_id = str(params["threadId"])
            thread = self.threads.get(thread_id) or self.codex.thread_resume(thread_id)
            self.threads[thread_id] = thread
            response = thread.read(include_turns=bool(params.get("includeTurns")))
            return True, thread_read_response(thread_id, response)
        if op == "thread_list":
            response = self.codex.thread_list(
                limit=number_or_none(params.get("limit")),
                search_term=optional_string(params.get("searchTerm")),
            )
            return True, thread_list_response(response)
        if op == "thread_compact":
            thread_id = str(params["threadId"])
            thread = self.threads.get(thread_id) or self.codex.thread_resume(thread_id)
            self.threads[thread_id] = thread
            thread.compact()
            return True, {"ok": True}
        if op == "turn_run":
            thread_id = str(params["threadId"])
            thread = self.threads.get(thread_id) or self.codex.thread_resume(
                thread_id,
                cwd=params.get("cwd"),
                model=params.get("model"),
                sandbox=sandbox_value(params.get("sandbox")),
            )
            self.threads[thread_id] = thread
            request_id = message.get("id")
            worker = threading.Thread(
                target=self.run_turn,
                args=(request_id, thread, params),
                daemon=True,
            )
            self.workers.append(worker)
            worker.start()
            return False, None
        if op == "turn_steer":
            thread_id = str(params["threadId"])
            message_text = str(params.get("message") or "")
            turn = self.active_turns.get(thread_id)
            if turn is not None:
                turn.steer(message_text)
            else:
                thread = self.threads.get(thread_id) or self.codex.thread_resume(
                    thread_id,
                    cwd=params.get("cwd"),
                )
                self.threads[thread_id] = thread
                thread.run(message_text)
            return True, {"ok": True}
        if op == "turn_interrupt":
            thread_id = str(params["threadId"])
            turn = self.active_turns.get(thread_id)
            if turn is not None:
                turn.interrupt()
                return True, {"ok": True}
            return True, {"ok": False, "reason": "No active turn for thread."}
        if op == "stop":
            return True, {"ok": True}
        raise ValueError(f"Unknown op: {op}")

    def run_turn(self, request_id: Any, thread: Any, params: dict[str, Any]) -> None:
        thread_id = thread_id_value(thread)
        turn = None
        final_response_parts: list[str] = []
        try:
            turn = thread.turn(
                str(params.get("prompt") or ""),
                cwd=params.get("cwd"),
                effort=params.get("effort"),
                model=params.get("model"),
                sandbox=sandbox_value(params.get("sandbox")),
                service_tier="fast" if params.get("fastMode") else None,
            )
            self.active_turns[thread_id] = turn
            emit(
                "codex",
                "turn/started",
                f"Started Codex turn {turn.id}.",
                {"threadId": thread_id, "turnId": turn.id},
                self.write_lock,
            )
            completed_status = "completed"
            completed = True
            for notification in turn.stream():
                method = str(getattr(notification, "method", "event"))
                raw = notification_to_raw(notification)
                message = notification_message(method, notification)
                if method == "item/agentMessage/delta" and message:
                    final_response_parts.append(message)
                    emit("codex", "agent", message, raw, self.write_lock)
                elif message:
                    emit("codex", method, message, raw, self.write_lock)
                if method == "turn/completed":
                    payload = getattr(notification, "payload", None)
                    completed_turn = getattr(payload, "turn", None)
                    completed_status = str(getattr(getattr(completed_turn, "status", None), "value", getattr(completed_turn, "status", "completed")))
                    completed = completed_status == "completed"
                    break
            print_response(
                request_id,
                {
                    "threadId": thread_id,
                    "turnId": str(getattr(turn, "id", "") or "sdk-turn"),
                    "status": completed_status,
                    "completed": completed,
                    "finalResponse": "".join(final_response_parts),
                },
                self.write_lock,
            )
        except Exception as exc:
            print_error(request_id, exc, self.write_lock)
        finally:
            if turn is not None and self.active_turns.get(thread_id) is turn:
                self.active_turns.pop(thread_id, None)


def sandbox_value(value: Any) -> Any:
    if value == "read_only":
        return Sandbox.read_only
    if value == "full_access":
        return Sandbox.full_access
    if value == "workspace_write":
        return Sandbox.workspace_write
    return None


def loopforge_service_name(cwd: Any) -> str:
    if not cwd:
        return "LoopForge"
    project_name = Path(str(cwd)).resolve().name
    return f"LoopForge - {project_name}" if project_name else "LoopForge"


def optional_string(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value
    return None


def number_or_none(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def set_thread_name(thread: Any, name: Any) -> None:
    if isinstance(name, str) and name.strip():
        thread.set_name(name.strip())


def thread_read_response(thread_id: str, response: Any) -> dict[str, Any]:
    thread = getattr(response, "thread", response)
    raw = model_dump(thread)
    name = raw.get("name") if isinstance(raw, dict) else None
    status = raw.get("status") if isinstance(raw, dict) else None
    turns = raw.get("turns") if isinstance(raw, dict) else None
    return {
        "threadId": str(raw.get("id") if isinstance(raw, dict) and raw.get("id") else thread_id),
        "name": name if isinstance(name, str) else None,
        "status": status if isinstance(status, str) else None,
        "turnCount": len(turns) if isinstance(turns, list) else 0,
        "raw": raw,
    }


def thread_list_response(response: Any) -> dict[str, Any]:
    raw = model_dump(response)
    if not isinstance(raw, dict):
        return {"threads": [], "cursor": None}
    threads = raw.get("threads") or raw.get("items") or []
    cursor = raw.get("cursor")
    return {
        "threads": threads if isinstance(threads, list) else [],
        "cursor": cursor if isinstance(cursor, str) else None,
    }


def model_dump(value: Any) -> Any:
    if hasattr(value, "model_dump"):
        return value.model_dump(by_alias=True, mode="json")
    if hasattr(value, "dict"):
        return value.dict(by_alias=True)
    return value


def thread_id_value(thread: Any) -> str:
    for name in ("id", "thread_id", "threadId"):
        value = getattr(thread, name, None)
        if value:
            return str(value)
    return str(thread)


def notification_to_raw(notification: Any) -> dict[str, Any]:
    payload = getattr(notification, "payload", None)
    params = model_dump(payload)
    return {"method": getattr(notification, "method", "event"), "params": params}


def notification_message(method: str, notification: Any) -> str:
    payload = getattr(notification, "payload", None)
    for attr in ("delta", "message", "text", "aggregated_output"):
        value = getattr(payload, attr, None)
        if isinstance(value, str) and value:
            return value
    if method == "item/started":
        return summarize_item("Started", getattr(payload, "item", None))
    if method == "item/completed":
        return summarize_item("Completed", getattr(payload, "item", None))
    if method == "turn/completed":
        turn = getattr(payload, "turn", None)
        status = getattr(getattr(turn, "status", None), "value", getattr(turn, "status", "completed"))
        return f"Codex turn {status}."
    if method.endswith("/updated") or method.endswith("/changed"):
        return ""
    return f"Codex event: {method}"


def summarize_item(prefix: str, item: Any) -> str:
    root = getattr(item, "root", item)
    item_type = getattr(root, "type", "item")
    command = getattr(root, "command", None)
    if isinstance(command, str) and command:
        return f"{prefix} {item_type}: {command}"
    text = getattr(root, "text", None)
    if isinstance(text, str) and text:
        return f"{prefix} {item_type}: {text[:240]}"
    return f"{prefix} {item_type}."


def emit(role: str, kind: str, message: str, raw: Any = None, lock: threading.Lock | None = None) -> None:
    payload = {"event": {"role": role, "kind": kind, "message": message, "raw": raw}}
    if lock:
        with lock:
            print(json.dumps(payload), flush=True)
    else:
        print(json.dumps(payload), flush=True)


def print_response(request_id: Any, result: dict[str, Any], lock: threading.Lock) -> None:
    with lock:
        print(json.dumps({"id": request_id, "result": result}), flush=True)


def print_error(request_id: Any, exc: Exception, lock: threading.Lock) -> None:
    with lock:
        print(
            json.dumps(
                {
                    "id": request_id,
                    "error": {
                        "message": str(exc),
                        "traceback": traceback.format_exc(limit=4),
                    },
                }
            ),
            flush=True,
        )


def main() -> int:
    bridge = Bridge()
    try:
        for line in sys.stdin:
            if not line.strip():
                continue
            request = json.loads(line)
            request_id = request.get("id")
            try:
                respond_now, result = bridge.handle(request)
                if respond_now:
                    print_response(request_id, result or {}, bridge.write_lock)
                if request.get("op") == "stop":
                    break
            except Exception as exc:
                print_error(request_id, exc, bridge.write_lock)
    finally:
        bridge.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
