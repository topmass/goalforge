const state = {
  board: { goals: [], tasks: [], runs: [], events: [], statuses: [] },
  selectedTaskId: null,
};

const boardEl = document.querySelector("#board");
const commandEl = document.querySelector("#commandCenter");
const connectionEl = document.querySelector("#connection");
const goalTextEl = document.querySelector("#goalText");
const selectedTaskEl = document.querySelector("#selectedTask");

document.querySelector("#addGoal").addEventListener("click", addGoal);
document.querySelector("#startGoalforge").addEventListener(
  "click",
  () => postJson("/api/run-queue", {}),
);
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
  renderSelection();
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
        if (status.id === "in_progress") {
          await postJson(`/api/tasks/${encodeURIComponent(taskId)}/run`, {})
            .catch((error) => alert(error.message));
          await loadBoard();
          return;
        }
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
  const canDelete = task.status !== "done";
  const canStart = ["inbox", "ready", "blocked"].includes(task.status);
  const canReview = task.status === "review";
  const canMerge = task.status === "review" || task.status === "done";
  card.innerHTML = `
    <div class="task-id">
      <span>${escapeHtml(task.id)}</span>
      ${canDelete ? `<button class="card-action danger" data-action="delete">DELETE</button>` : ""}
    </div>
    <div class="task-title">${escapeHtml(task.title)}</div>
    <div class="task-meta">
      <span>P${task.priority}</span>
      <span>${task.branchName ? "BRANCH" : "QUEUED"}</span>
    </div>
    <div class="card-actions">
      ${canStart ? `<button class="card-action" data-action="start">START</button>` : ""}
      ${canReview ? `<button class="card-action" data-action="review">REVIEW</button>` : ""}
      ${canMerge ? `<button class="card-action" data-action="merge">MERGE</button>` : ""}
    </div>
  `;
  for (const button of card.querySelectorAll("[data-action]")) {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      await handleCardAction(task, button.dataset.action);
    });
  }
  return card;
}

function renderSelection() {
  const task = state.board.tasks.find((item) => item.id === state.selectedTaskId);
  selectedTaskEl.textContent = task
    ? `${task.id} ${labelFor(task.status).toUpperCase()}`
    : "NO SELECTION";
}

async function handleCardAction(task, action) {
  if (action === "delete") {
    await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || response.statusText);
        }
      })
      .catch((error) => alert(error.message));
  }
  if (action === "start") {
    await postJson(`/api/tasks/${encodeURIComponent(task.id)}/run`, {})
      .catch((error) => alert(error.message));
  }
  if (action === "review") {
    await postJson(`/api/tasks/${encodeURIComponent(task.id)}/review`, {})
      .catch((error) => alert(error.message));
  }
  if (action === "merge") {
    await postJson(`/api/tasks/${encodeURIComponent(task.id)}/merge`, {})
      .catch((error) => alert(error.message));
  }
  await loadBoard();
}

function renderCommandCenter() {
  const groups = new Map();
  for (const event of compactEvents(state.board.events.slice(-220))) {
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
            <span class="message">${escapeHtml(event.message)}</span>
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

function compactEvents(events) {
  const compacted = [];
  for (const event of events) {
    const previous = compacted[compacted.length - 1];
    const isDelta = ["agent", "reasoning", "output"].includes(event.kind);
    if (
      isDelta && previous && previous.kind === event.kind && previous.role === event.role &&
      previous.taskId === event.taskId && previous.runId === event.runId
    ) {
      previous.message += event.message;
      previous.createdAt = event.createdAt;
    } else {
      compacted.push({ ...event });
    }
  }
  return compacted;
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
