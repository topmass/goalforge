const state = {
  board: { goals: [], tasks: [], runs: [], events: [], statuses: [] },
  selectedTaskId: null,
};

const boardEl = document.querySelector("#board");
const detailEl = document.querySelector("#taskDetail");
const commandEl = document.querySelector("#commandCenter");
const connectionEl = document.querySelector("#connection");
const goalTextEl = document.querySelector("#goalText");

document.querySelector("#addGoal").addEventListener("click", addGoal);
document.querySelector("#planGoal").addEventListener("click", planGoal);
document.querySelector("#runNext").addEventListener("click", () => postJson("/api/run", {}));
document.querySelector("#runQueue").addEventListener("click", () => postJson("/api/run-queue", {}));
goalTextEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addGoal();
});

connectEvents();
loadBoard();

async function loadBoard() {
  const response = await fetch("/api/board");
  state.board = await response.json();
  render();
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    connectionEl.textContent = "LIVE";
  });
  source.addEventListener("board", (event) => {
    state.board = JSON.parse(event.data);
    render();
  });
  source.addEventListener("activity", (event) => {
    const activity = JSON.parse(event.data);
    state.board.events.push(activity);
    renderCommandCenter();
  });
  source.addEventListener("error", () => {
    connectionEl.textContent = "RECONNECTING";
  });
}

async function addGoal() {
  const text = goalTextEl.value.trim();
  if (!text) return;
  goalTextEl.value = "";
  await postJson("/api/goals", { text });
  await loadBoard();
}

async function planGoal() {
  const text = goalTextEl.value.trim();
  if (!text) return;
  goalTextEl.value = "";
  await postJson("/api/goals/plan", { text }).catch((error) => alert(error.message));
  await loadBoard();
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || response.statusText);
  }
  return await response.json();
}

function render() {
  renderBoard();
  renderDetail();
  renderCommandCenter();
}

function renderBoard() {
  boardEl.innerHTML = "";
  for (const status of state.board.statuses) {
    const column = document.createElement("section");
    column.className = "column";
    column.dataset.status = status.id;
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      column.classList.add("drag-over");
    });
    column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
    column.addEventListener("drop", async (event) => {
      event.preventDefault();
      column.classList.remove("drag-over");
      const taskId = event.dataTransfer.getData("text/plain");
      if (taskId) {
        await postJson(`/api/tasks/${encodeURIComponent(taskId)}/transition`, {
          status: status.id,
          actor: "user",
          reason: "Dragged in GoalForge board.",
        }).catch((error) => alert(error.message));
        await loadBoard();
      }
    });

    const tasks = state.board.tasks.filter((task) => task.status === status.id);
    column.innerHTML = `
      <div class="column-head">
        <span>${escapeHtml(status.label).toUpperCase()}</span>
        <span>${tasks.length}</span>
      </div>
      <div class="task-list"></div>
    `;
    const list = column.querySelector(".task-list");
    for (const task of tasks) {
      list.appendChild(taskCard(task));
    }
    boardEl.appendChild(column);
  }
}

function taskCard(task) {
  const card = document.createElement("article");
  card.className = `task-card${state.selectedTaskId === task.id ? " selected" : ""}`;
  card.draggable = true;
  card.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", task.id);
  });
  card.addEventListener("click", () => {
    state.selectedTaskId = task.id;
    render();
  });
  card.innerHTML = `
    <div class="task-id">${escapeHtml(task.id)}</div>
    <div class="task-title">${escapeHtml(task.title)}</div>
    <div class="task-meta">
      <span>P${task.priority}</span>
      <span>${task.branchName ? "BRANCH" : "UNCLAIMED"}</span>
    </div>
  `;
  return card;
}

function renderDetail() {
  const task = state.board.tasks.find((item) => item.id === state.selectedTaskId) ||
    state.board.tasks[0];
  if (!task) {
    detailEl.textContent = "No tasks yet. Queue a goal above.";
    return;
  }
  state.selectedTaskId = task.id;
  detailEl.innerHTML = `
    <h3>${escapeHtml(task.id)} ${escapeHtml(task.title)}</h3>
    <div>Status: ${escapeHtml(labelFor(task.status))}</div>
    <div>Branch: ${escapeHtml(task.branchName || "not assigned")}</div>
    <div>Worktree: ${escapeHtml(task.worktreePath || "not assigned")}</div>
    <p>${escapeHtml(task.description)}</p>
    <div>Acceptance Criteria</div>
    <pre>${escapeHtml(task.acceptanceCriteria || "none")}</pre>
    <div>Workpad</div>
    <pre>${escapeHtml(task.workpad || "empty")}</pre>
    <div>Validation</div>
    <pre>${escapeHtml(task.validation || "not recorded")}</pre>
    <div class="detail-actions">
      <button data-action="run">RUN CODEX</button>
      <button data-action="merge">MERGE</button>
      <button data-action="ready">MOVE READY</button>
      <button data-action="blocked">BLOCK</button>
      <button data-action="done">MARK DONE</button>
    </div>
  `;
  detailEl.querySelector('[data-action="run"]').addEventListener("click", () => {
    postJson(`/api/tasks/${encodeURIComponent(task.id)}/run`, {});
  });
  detailEl.querySelector('[data-action="merge"]').addEventListener("click", async () => {
    await postJson(`/api/tasks/${encodeURIComponent(task.id)}/merge`, {})
      .catch((error) => alert(error.message));
    await loadBoard();
  });
  detailEl.querySelector('[data-action="ready"]').addEventListener("click", () => {
    transition(task.id, "ready", "Manual ready from task detail.");
  });
  detailEl.querySelector('[data-action="blocked"]').addEventListener("click", () => {
    transition(task.id, "blocked", "Blocked by user from task detail.");
  });
  detailEl.querySelector('[data-action="done"]').addEventListener("click", () => {
    transition(task.id, "done", "Accepted by user from task detail.");
  });
}

async function transition(taskId, status, reason) {
  await postJson(`/api/tasks/${encodeURIComponent(taskId)}/transition`, {
    status,
    actor: "user",
    reason,
  }).catch((error) => alert(error.message));
  await loadBoard();
}

function renderCommandCenter() {
  const groups = new Map();
  for (const event of state.board.events.slice(-160)) {
    const key = event.runId || event.taskId || "system";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }

  commandEl.innerHTML = "";
  if (!groups.size) {
    const empty = document.createElement("div");
    empty.className = "agent-card";
    empty.innerHTML = `
      <div class="agent-head"><span>idle</span><span>waiting</span></div>
      <div class="terminal"><div class="terminal-line">No live agent output yet.</div></div>
    `;
    commandEl.appendChild(empty);
    return;
  }

  for (const [key, events] of groups) {
    const latest = events[events.length - 1];
    const card = document.createElement("article");
    card.className = "agent-card";
    card.innerHTML = `
      <div class="agent-head">
        <span>${escapeHtml(latest.role)}:${escapeHtml(latest.taskId || "system")}</span>
        <span>${escapeHtml(key)}</span>
      </div>
      <div class="terminal">
        ${
      events.map((event) => `
          <div class="terminal-line">
            <span class="time">${timeOnly(event.createdAt)}</span>
            <span class="kind">${escapeHtml(event.kind)}</span>
            ${escapeHtml(event.message)}
          </div>
        `).join("")
    }
      </div>
    `;
    commandEl.appendChild(card);
    const terminal = card.querySelector(".terminal");
    terminal.scrollTop = terminal.scrollHeight;
  }
}

function labelFor(status) {
  return state.board.statuses.find((item) => item.id === status)?.label || status;
}

function timeOnly(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
