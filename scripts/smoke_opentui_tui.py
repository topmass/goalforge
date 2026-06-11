#!/usr/bin/env python3
import errno
import json
import os
import pty
import select
import signal
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = os.environ.get("LOOPFORGE_REPO", str(Path(__file__).resolve().parents[1]))
LOOPFORGE = os.environ.get("LOOPFORGE_BIN", str(Path(REPO) / "loopforge"))

def main() -> int:
    if "--dogfood-only" in sys.argv:
        return run_dogfood_build_smoke()
    task_smoke = run_task_smoke()
    scroll_smoke = run_task_details_scroll_smoke()
    close_smoke = run_close_goal_smoke()
    review_smoke = run_review_label_smoke()
    dogfood_smoke = run_dogfood_build_smoke()
    return 0 if task_smoke == 0 and scroll_smoke == 0 and close_smoke == 0 and review_smoke == 0 and dogfood_smoke == 0 else 1


def run_task_smoke() -> int:
    port = free_port()
    project = tempfile.mkdtemp(prefix="loopforge-opentui-")
    subprocess.run(
        [LOOPFORGE, "main", "reset", "smoke-main-thread"],
        cwd=project,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["COLUMNS"] = "120"
        os.environ["LINES"] = "44"
        os.chdir(project)
        os.execvp(LOOPFORGE, [LOOPFORGE, "tui", "--port", str(port)])

    output = b""
    status = None
    clicked_first_task = False
    clicked_first_row = False
    clicked_delete_button = False
    typed_first_task = False
    clicked_second_task = False
    clicked_second_row = False
    pressed_delete_key = False
    typed_second_task = False
    clicked_quit = False
    start = time.time()
    try:
        while time.time() - start < 18:
            readable, _, _ = select.select([fd], [], [], 0.2)
            if readable:
                try:
                    output += os.read(fd, 65536)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
            if not clicked_first_task and b"Task Board" in output:
                time.sleep(0.5)
                os.write(fd, mouse_click(18, 41))
                clicked_first_task = True
            if clicked_first_task and not typed_first_task:
                time.sleep(0.5)
                os.write(fd, b"Button delete task from paste")
                time.sleep(0.2)
                os.write(fd, b"\r")
                typed_first_task = True
            if typed_first_task and not clicked_first_row and b"Button delete task" in output and b"TASK-1" in output:
                time.sleep(0.3)
                os.write(fd, mouse_click(3, 14))
                clicked_first_row = True
            if clicked_first_row and not clicked_delete_button and b"Button delete task" in output:
                time.sleep(0.3)
                os.write(fd, mouse_click(75, 42))
                clicked_delete_button = True
            if clicked_delete_button and not clicked_second_task and b"Delete Button delete task from paste complete." in output:
                time.sleep(0.3)
                os.write(fd, mouse_click(18, 41))
                clicked_second_task = True
            if clicked_second_task and not typed_second_task:
                time.sleep(0.5)
                os.write(fd, b"Keyboard delete task\r")
                typed_second_task = True
            if typed_second_task and not clicked_second_row and b"Keyboard delete task" in output:
                time.sleep(0.3)
                os.write(fd, mouse_click(3, 14))
                clicked_second_row = True
            if clicked_second_row and not pressed_delete_key and b"Keyboard delete task" in output and b"Selected TASK-" in output:
                time.sleep(0.3)
                os.write(fd, b"\x1b[3~")
                pressed_delete_key = True
            if pressed_delete_key and not clicked_quit and b"Delete Keyboard delete task complete." in output:
                time.sleep(0.3)
                os.write(fd, mouse_click(90, 42))
                clicked_quit = True
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = child_status
                break
        if status is None:
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = child_status
        if status is None:
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
    finally:
        os.close(fd)
        shutil.rmtree(project, ignore_errors=True)

    text = output.decode("utf-8", errors="replace")
    exit_code = os.waitstatus_to_exitcode(status)
    checks = {
        "exit_0": exit_code == 0,
        "clicked_first_task": clicked_first_task,
        "clicked_first_row": clicked_first_row,
        "clicked_delete_button": clicked_delete_button,
        "typed_first_task": typed_first_task,
        "clicked_second_task": clicked_second_task,
        "clicked_second_row": clicked_second_row,
        "pressed_delete_key": pressed_delete_key,
        "typed_second_task": typed_second_task,
        "clicked_quit": clicked_quit,
        "title": "LoopForge Command Center" in text,
        "task_board": "Task Board" in text,
        "task_sections": "Working / Ready" in text and "Needs Input" in text and "Done" in text,
        "task_details": "Task Details" in text,
        "recommended_action": "Recommended Action" in text,
        "active_agents": "Active Agents" in text,
        "build_goal_button": "Build Goal" in text,
        "start_task_button": "Start Task" in text,
        "compact_memory_button": "Compact Memory" in text,
        "reset_memory_button": "Reset Memory" in text,
        "delete_button": "Delete Task" in text,
        "rescue_button": "Rescue:" in text,
        "planner_button": "Planner:" in text,
        "scout_button": "Scout:" in text,
        "agents_button": "Agents:" in text,
        "mouse_selected_task": clicked_first_row and "Button delete task" in text,
        "friendly_status": "Ready" in text and "P100" not in text,
        "button_delete_complete": "Delete Button delete task from paste complete." in text,
        "keyboard_delete_complete": "Delete Keyboard delete task complete." in text,
        "manual_task_created": "Keyboard delete task" in text,
        "project_memory": "Project Memory" in text,
        "project_health": "Project Health" in text,
        "activity": "Activity" in text,
        "agent_flow_panel": "Agent Flow" in text,
        "agent_flow_core_label": "CORE" in text,
        "agent_flow_particles": any(glyph in text for glyph in "▘▝▀▖▌▞▛▗▚▐▜▄▙▟█"),
    }
    for name, ok in checks.items():
        print(f"{name}: {'ok' if ok else 'failed'}")
    print(f"bytes: {len(output)}")
    if not all(checks.values()):
        return 1
    return 0


def run_close_goal_smoke() -> int:
    port = free_port()
    project = tempfile.mkdtemp(prefix="loopforge-opentui-close-")
    seed_close_ready_goal(project)
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["COLUMNS"] = "120"
        os.environ["LINES"] = "36"
        os.chdir(project)
        os.execvp(LOOPFORGE, [LOOPFORGE, "tui", "--port", str(port)])

    output = b""
    status = None
    clicked_close_goal = False
    clicked_quit = False
    start = time.time()
    try:
        while time.time() - start < 12:
            readable, _, _ = select.select([fd], [], [], 0.2)
            if readable:
                try:
                    output += os.read(fd, 65536)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
            if not clicked_close_goal and b"Close Goal" in output:
                time.sleep(0.5)
                os.write(fd, mouse_click(45, 33))
                clicked_close_goal = True
            if clicked_close_goal and not clicked_quit and b"GOAL-1 closed." in output:
                time.sleep(0.3)
                os.write(fd, mouse_click(110, 34))
                clicked_quit = True
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = child_status
                break
        if status is None:
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = child_status
        if status is None:
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
    finally:
        os.close(fd)
        shutil.rmtree(project, ignore_errors=True)

    text = output.decode("utf-8", errors="replace")
    exit_code = os.waitstatus_to_exitcode(status)
    checks = {
        "close_exit_0": exit_code == 0,
        "close_goal_button": "Close Goal" in text,
        "close_goal_was_ready": "Close Goal" in text,
        "close_goal_headline": "GOAL-1 ready to close" in text,
        "done_goal_hides_start_task": "Start Task" not in text,
        "clicked_close_goal": clicked_close_goal,
        "closed_goal_notice": "GOAL-1 closed." in text,
        "clicked_close_quit": clicked_quit,
    }
    for name, ok in checks.items():
        print(f"{name}: {'ok' if ok else 'failed'}")
    print(f"close_bytes: {len(output)}")
    if not all(checks.values()):
        return 1
    return 0


def run_task_details_scroll_smoke() -> int:
    port = free_port()
    project = tempfile.mkdtemp(prefix="loopforge-opentui-scroll-")
    seed_scroll_task(project)
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["COLUMNS"] = "120"
        os.environ["LINES"] = "36"
        os.chdir(project)
        os.execvp(LOOPFORGE, [LOOPFORGE, "tui", "--port", str(port)])

    output = b""
    status = None
    wheeled_task_details = False
    clicked_quit = False
    start = time.time()
    try:
        while time.time() - start < 10:
            readable, _, _ = select.select([fd], [], [], 0.2)
            if readable:
                try:
                    output += os.read(fd, 65536)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
            if not wheeled_task_details and b"1-19 of" in output:
                time.sleep(0.3)
                os.write(fd, mouse_wheel_down(50, 16))
                wheeled_task_details = True
            if wheeled_task_details and not clicked_quit and b"4-22 of" in output:
                time.sleep(0.3)
                os.write(fd, mouse_click(90, 34))
                clicked_quit = True
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = child_status
                break
        if status is None:
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = child_status
        if status is None:
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
    finally:
        os.close(fd)
        shutil.rmtree(project, ignore_errors=True)

    text = output.decode("utf-8", errors="replace")
    exit_code = os.waitstatus_to_exitcode(status)
    checks = {
        "scroll_exit_0": exit_code == 0,
        "scroll_task_details_initial": "1-19 of" in text,
        "wheeled_task_details": wheeled_task_details,
        "scroll_task_details_moved": "4-22 of" in text,
        "scroll_clicked_quit": clicked_quit,
    }
    for name, ok in checks.items():
        print(f"{name}: {'ok' if ok else 'failed'}")
    print(f"scroll_bytes: {len(output)}")
    if not all(checks.values()):
        return 1
    return 0


def run_review_label_smoke() -> int:
    port = free_port()
    project = tempfile.mkdtemp(prefix="loopforge-opentui-review-")
    seed_review_task(project)
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["COLUMNS"] = "120"
        os.environ["LINES"] = "36"
        os.chdir(project)
        os.execvp(LOOPFORGE, [LOOPFORGE, "tui", "--port", str(port)])

    output = b""
    status = None
    clicked_quit = False
    start = time.time()
    try:
        while time.time() - start < 10:
            readable, _, _ = select.select([fd], [], [], 0.2)
            if readable:
                try:
                    output += os.read(fd, 65536)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
            if not clicked_quit and b"Review & Merge" in output:
                time.sleep(0.3)
                os.write(fd, mouse_click(90, 34))
                clicked_quit = True
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = child_status
                break
        if status is None:
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = child_status
        if status is None:
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
    finally:
        os.close(fd)
        shutil.rmtree(project, ignore_errors=True)

    text = output.decode("utf-8", errors="replace")
    exit_code = os.waitstatus_to_exitcode(status)
    checks = {
        "review_exit_0": exit_code == 0,
        "review_merge_button": "Review & Merge" in text,
        "review_headline": "1 task ready for Review & Merge" in text,
        "review_hides_start_task": "Start Task" not in text,
        "clicked_review_quit": clicked_quit,
    }
    for name, ok in checks.items():
        print(f"{name}: {'ok' if ok else 'failed'}")
    print(f"review_bytes: {len(output)}")
    if not all(checks.values()):
        return 1
    return 0


def run_dogfood_build_smoke() -> int:
    port = free_port()
    project = tempfile.mkdtemp(prefix="loopforge-opentui-dogfood-")
    server = subprocess.Popen(
        [
            "/home/topmass/.deno/bin/deno",
            "run",
            "--allow-read",
            "--allow-write",
            "--allow-run",
            "--allow-net",
            "--allow-env",
            str(Path(REPO) / "scripts" / "smoke_dogfood_server.ts"),
            project,
            str(port),
        ],
        cwd=REPO,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    ready = wait_for_server_ready(server)
    output = b""
    status = None
    api_build_started = False
    clicked_quit = False
    board = None
    server_tail = ""
    pid = None
    fd = None
    try:
        if not ready:
            print("dogfood_server_ready: failed")
            if server.stdout is not None:
                print("dogfood_server_tail: " + server.stdout.read()[-1200:].replace("\n", "\\n"))
            return 1
        bun = bun_path()
        if not bun:
            print("dogfood_bun_found: failed")
            return 1
        pid, fd = pty.fork()
        if pid == 0:
            os.environ["COLUMNS"] = "120"
            os.environ["LINES"] = "36"
            os.chdir(REPO)
            os.execvp(
                bun,
                [
                    bun,
                    str(Path(REPO) / "src" / "tui" / "opentui_client.ts"),
                    "--url",
                    f"http://127.0.0.1:{port}",
                ],
            )

        start = time.time()
        while time.time() - start < 30:
            readable, _, _ = select.select([fd], [], [], 0.2)
            if readable:
                try:
                    output += os.read(fd, 65536)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
            if not api_build_started and b"Build Goal" in output:
                time.sleep(0.5)
                post_json(
                    f"http://127.0.0.1:{port}/api/goals/build",
                    {"text": "Dogfood build observed through OpenTUI"},
                )
                api_build_started = True
            board = fetch_json(f"http://127.0.0.1:{port}/api/board")
            goal_closed = bool(board.get("goals")) and board["goals"][0].get("status") == "closed"
            task_done = bool(board.get("tasks")) and board["tasks"][0].get("status") == "done"
            if goal_closed and task_done and not clicked_quit:
                time.sleep(0.6)
                os.write(fd, mouse_click(110, 34))
                clicked_quit = True
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = child_status
                break
        if status is None:
            done, child_status = os.waitpid(pid, os.WNOHANG)
            if done:
                status = child_status
        if status is None:
            os.kill(pid, signal.SIGKILL)
            _, status = os.waitpid(pid, 0)
    finally:
        if fd is not None:
            os.close(fd)
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()
            server.wait(timeout=5)
        if server.stdout is not None:
            server_tail = server.stdout.read()[-1200:]
        shutil.rmtree(project, ignore_errors=True)

    text = output.decode("utf-8", errors="replace")
    exit_code = os.waitstatus_to_exitcode(status)
    board = board or {}
    goals = board.get("goals", [])
    tasks = board.get("tasks", [])
    events = board.get("events", [])
    validation = tasks[0].get("validation", "") if tasks else ""
    checks = {
        "dogfood_exit_0": exit_code == 0,
        "dogfood_server_ready": ready,
        "dogfood_api_build_started": api_build_started,
        "dogfood_goal_visible": "Dogfood build observed through OpenTUI" in text or "Write dogfood marker" in text,
        "dogfood_task_done": bool(tasks) and tasks[0].get("status") == "done",
        "dogfood_goal_closed": bool(goals) and goals[0].get("status") == "closed",
        "dogfood_verification_passed": "VERIFICATION_PASSED" in validation,
        "dogfood_commit_recorded": "Commit:" in validation and "not created" not in validation,
        "dogfood_repair_recorded": any(event.get("kind") == "repair" for event in events),
        "dogfood_clicked_quit": clicked_quit,
    }
    for name, ok in checks.items():
        print(f"{name}: {'ok' if ok else 'failed'}")
    if not all(checks.values()):
        print(f"dogfood_goals: {[goal.get('status') for goal in goals]}")
        print(
            "dogfood_tasks: "
            + str([
                {
                    "id": task.get("id"),
                    "status": task.get("status"),
                    "title": task.get("title"),
                    "blocked": task.get("blockedReason"),
                    "phase": task.get("loopPhase"),
                    "gate": task.get("currentGate"),
                }
                for task in tasks
            ])
        )
        print(
            "dogfood_events: "
            + str([
                {
                    "role": event.get("role"),
                    "kind": event.get("kind"),
                    "message": str(event.get("message", ""))[:140],
                }
                for event in events[-8:]
            ])
        )
        print("dogfood_tui_tail: " + text[-1200:].replace("\n", "\\n"))
        print("dogfood_server_tail: " + server_tail.replace("\n", "\\n"))
    print(f"dogfood_bytes: {len(output)}")
    if not all(checks.values()):
        return 1
    return 0


def seed_close_ready_goal(project: str) -> None:
    code = r'''
import { BoardStore } from "__REPO__/src/board/store.ts";
import { buildTaskCard } from "__REPO__/src/workers/task_memory.ts";

const root = Deno.args[0];
const store = new BoardStore(root);
try {
  store.initProject();
  store.resetMainThread("smoke-main-thread", "OpenTUI close-goal smoke main thread.");
  const { task } = store.createGoal("Close this proven smoke goal");
  store.requestTransition(task.id, "in_progress");
  store.updateTaskValidation(task.id, [
    "Codex App Server turn completed.",
    "Turn status: completed",
    "Test turn status: completed",
    "Discovered verification gates:",
    "- Diff inspection: git diff --stat && git diff --check - Every task needs a basic changed-file and whitespace sanity check.",
    "",
    "Verification verdict:",
    "VERIFICATION_PASSED",
    "- Focused validation passed with recorded proof.",
    "Commit: abc123",
    "Git status:",
    "clean",
    "LoopForge review: APPROVED",
  ].join("\n"));
  const ready = store.getTask(task.id);
  store.updateTaskCard(ready.id, buildTaskCard(ready));
  store.updateTaskHandoff(ready.id, "Validated and ready to close.");
  store.requestTransition(ready.id, "review");
  store.requestTransition(ready.id, "done");
} finally {
  store.close();
}
'''.replace("__REPO__", REPO)
    seed_path = Path(project) / "seed-close-goal.ts"
    seed_path.write_text(code)
    subprocess.run(
        [
            "/home/topmass/.deno/bin/deno",
            "run",
            "--allow-read",
            "--allow-write",
            "--allow-env",
            "--allow-run",
            "--node-modules-dir=auto",
            str(seed_path),
            project,
        ],
        cwd=REPO,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def seed_review_task(project: str) -> None:
    code = r'''
import { BoardStore } from "__REPO__/src/board/store.ts";

const root = Deno.args[0];
const store = new BoardStore(root);
try {
  store.initProject();
  store.resetMainThread("smoke-main-thread", "OpenTUI review-label smoke main thread.");
  const { task } = store.createGoal("Review this smoke task");
  store.requestTransition(task.id, "in_progress");
  store.updateTaskValidation(task.id, [
    "Codex App Server turn completed.",
    "Turn status: completed",
    "Test turn status: completed",
    "Commit: abc123",
    "Git status:",
    "clean",
  ].join("\n"));
  store.requestTransition(task.id, "review");
} finally {
  store.close();
}
'''.replace("__REPO__", REPO)
    seed_path = Path(project) / "seed-review-task.ts"
    seed_path.write_text(code)
    subprocess.run(
        [
            "/home/topmass/.deno/bin/deno",
            "run",
            "--allow-read",
            "--allow-write",
            "--allow-env",
            "--allow-run",
            "--node-modules-dir=auto",
            str(seed_path),
            project,
        ],
        cwd=REPO,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def seed_scroll_task(project: str) -> None:
    code = r'''
import { BoardStore } from "__REPO__/src/board/store.ts";

const root = Deno.args[0];
const store = new BoardStore(root);
try {
  store.initProject();
  store.resetMainThread("smoke-main-thread", "OpenTUI scroll smoke main thread.");
  const details = Array.from({ length: 40 }, (_, index) =>
    `scroll detail ${index + 1} keeps the task details panel long enough to need scrolling`
  ).join(" ");
  const { task } = store.createGoal(`Scroll task details ${details}`);
  store.requestTransition(task.id, "blocked", "worker", `LoopForge needs input: ${details}`);
} finally {
  store.close();
}
'''.replace("__REPO__", REPO)
    seed_path = Path(project) / "seed-scroll-task.ts"
    seed_path.write_text(code)
    subprocess.run(
        [
            "/home/topmass/.deno/bin/deno",
            "run",
            "--allow-read",
            "--allow-write",
            "--allow-env",
            "--allow-run",
            "--node-modules-dir=auto",
            str(seed_path),
            project,
        ],
        cwd=REPO,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def free_port() -> int:
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])
    finally:
        sock.close()


def mouse_click(x: int, y: int) -> bytes:
    return f"\x1b[<0;{x};{y}M".encode()


def mouse_wheel_down(x: int, y: int) -> bytes:
    return f"\x1b[<65;{x};{y}M".encode()


def wait_for_server_ready(server: subprocess.Popen) -> bool:
    if server.stdout is None:
        return False
    deadline = time.time() + 10
    while time.time() < deadline:
        readable, _, _ = select.select([server.stdout], [], [], 0.2)
        if readable:
            line = server.stdout.readline()
            if "DOGFOOD_READY" in line:
                return True
        if server.poll() is not None:
            return False
    return False


def bun_path() -> str | None:
    found = shutil.which("bun")
    if found:
        return found
    fallback = str(Path.home() / ".bun" / "bin" / "bun")
    return fallback if Path(fallback).exists() else None


def fetch_json(url: str) -> dict:
    try:
        with urllib.request.urlopen(url, timeout=0.5) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return {}


def post_json(url: str, payload: dict) -> dict:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{exc.code} {body}") from exc


if __name__ == "__main__":
    raise SystemExit(main())
