const state = {
  board: { goals: [], tasks: [], runs: [], events: [], statuses: [] },
  config: null,
  runtime: null,
  selectedTaskId: null,
  draggedTaskId: null,
};

const boardEl = document.querySelector("#board");
const commandEl = document.querySelector("#commandCenter");
const connectionEl = document.querySelector("#connection");
const goalTextEl = document.querySelector("#goalText");
const selectedTaskEl = document.querySelector("#selectedTask");
const taskModalEl = document.querySelector("#taskModal");
const taskModalContentEl = document.querySelector("#taskModalContent");
const modelSelectEl = document.querySelector("#modelSelect");
const reasoningSelectEl = document.querySelector("#reasoningSelect");
const fastModeEl = document.querySelector("#fastMode");
const githubPrReviewEl = document.querySelector("#githubPrReview");
const themeModeEl = document.querySelector("#themeMode");
const settingsStatusEl = document.querySelector("#settingsStatus");
const runtimeStatusEl = document.querySelector("#runtimeStatus");

document.querySelector("#addGoal").addEventListener("click", addGoal);
document.querySelector("#startLoopforge").addEventListener(
  "click",
  () => postJson("/api/run-queue", {}),
);
goalTextEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addGoal();
});
taskModalEl.addEventListener("click", () => closeTaskModal());
taskModalContentEl.addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeTaskModal();
});
modelSelectEl.addEventListener("change", saveConfig);
reasoningSelectEl.addEventListener("change", saveConfig);
fastModeEl.addEventListener("change", saveConfig);
githubPrReviewEl.addEventListener("change", saveConfig);
themeModeEl.addEventListener("change", () => {
  applyTheme(themeModeEl.checked ? "dark" : "light");
});

applyTheme(localStorage.getItem("loopforge-theme") || "light");
connectEvents();
loadConfig();
loadRuntime();
loadBoard();

async function loadBoard() {
  const response = await fetch("/api/board");
  state.board = await response.json();
  render();
}

async function loadConfig() {
  const response = await fetch("/api/config");
  state.config = await response.json();
  renderConfig();
}

async function loadRuntime() {
  const response = await fetch("/api/runtime");
  state.runtime = await response.json();
  renderRuntime();
}

async function saveConfig() {
  settingsStatusEl.textContent = "SAVING";
  state.config = await fetch("/api/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: modelSelectEl.value,
      reasoningEffort: reasoningSelectEl.value,
      fastMode: fastModeEl.checked,
      githubPrReview: githubPrReviewEl.checked,
    }),
  }).then((response) => response.json());
  renderConfig();
}

function renderConfig() {
  if (!state.config) return;
  modelSelectEl.value = state.config.model;
  reasoningSelectEl.value = state.config.reasoningEffort;
  fastModeEl.checked = Boolean(state.config.fastMode);
  githubPrReviewEl.checked = Boolean(state.config.githubPrReview);
  settingsStatusEl.textContent =
    `${state.config.model} / ${state.config.reasoningEffort.toUpperCase()} / ${
      state.config.fastMode ? "FAST" : "STANDARD"
    } / ${state.config.githubPrReview ? "PR GATE" : "LOCAL MERGE"}`;
}

function applyTheme(theme) {
  const selected = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = selected;
  localStorage.setItem("loopforge-theme", selected);
  themeModeEl.checked = selected === "dark";
}

function renderRuntime() {
  if (!state.runtime) return;
  const mainThread = state.runtime.projectState?.mainThreadId || "NO MAIN THREAD";
  runtimeStatusEl.textContent = `${
    state.runtime.queueRunning ? "QUEUE RUNNING" : "QUEUE IDLE"
  } / ${state.runtime.workflow.maxConcurrentAgents} AGENTS / ${state.runtime.needsInputTasks.length} INBOX / ${mainThread}`;
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => {
    connectionEl.textContent = "LIVE";
  });
  source.addEventListener("board", (event) => {
    state.board = JSON.parse(event.data);
    loadRuntime();
    render();
  });
  source.addEventListener("activity", (event) => {
    const activity = JSON.parse(event.data);
    state.board.events.push(activity);
    loadRuntime();
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
  await loadRuntime();
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
  for (const status of displayStatuses()) {
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
          status: status.targetStatus,
          actor: "user",
          reason: "Dragged in LoopForge board.",
        }).catch((error) => alert(error.message));
        await loadBoard();
      }
    });

    const tasks = state.board.tasks.filter((task) => status.taskStatuses.includes(task.status));
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

function displayStatuses() {
  return state.board.statuses
    .filter((status) => status.id !== "blocked")
    .map((status) =>
      status.id === "inbox"
        ? { ...status, taskStatuses: ["inbox", "blocked"], targetStatus: "blocked" }
        : { ...status, taskStatuses: [status.id], targetStatus: status.id }
    );
}

function taskCard(task) {
  const card = document.createElement("article");
  card.className = `task-card${state.selectedTaskId === task.id ? " selected" : ""}`;
  card.draggable = true;
  card.addEventListener("dragstart", (event) => {
    state.draggedTaskId = task.id;
    event.dataTransfer.setData("text/plain", task.id);
  });
  card.addEventListener("dragend", () => {
    setTimeout(() => {
      state.draggedTaskId = null;
    }, 0);
  });
  card.addEventListener("click", () => {
    if (state.draggedTaskId === task.id) return;
    state.selectedTaskId = task.id;
    render();
    openTaskModal(task);
  });
  const canDelete = task.status !== "done";
  const canStart = ["inbox", "ready", "blocked"].includes(task.status);
  const canReview = task.status === "review";
  const canMerge = task.status === "review";
  card.innerHTML = `
    <div class="task-id">
      <span>${escapeHtml(task.id)}</span>
      ${canDelete ? `<button class="card-action danger" data-action="delete">DELETE</button>` : ""}
    </div>
    <div class="task-title">${escapeHtml(task.title)}</div>
    ${
    task.blockedReason
      ? `<div class="task-alert">${escapeHtml(shortMessage(task.blockedReason))}</div>`
      : ""
  }
    <div class="task-meta">
      <span>P${task.priority}</span>
      <span>${escapeHtml(statusBadge(task))}</span>
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
  if (!task) {
    selectedTaskEl.textContent = "NO SELECTION";
    return;
  }

  selectedTaskEl.innerHTML = `
    <span>${escapeHtml(task.id)} ${labelFor(task.status).toUpperCase()}</span>
    ${
    task.status !== "done"
      ? `<button class="selected-delete" data-action="delete-selected">DELETE</button>`
      : ""
  }
  `;
  const deleteButton = selectedTaskEl.querySelector("[data-action='delete-selected']");
  deleteButton?.addEventListener("click", async (event) => {
    event.stopPropagation();
    await deleteTask(task);
  });
}

function openTaskModal(task) {
  taskModalContentEl.innerHTML = `
    <div class="modal-head">
      <span>${escapeHtml(task.id)} · ${escapeHtml(labelFor(task.status)).toUpperCase()}</span>
      <button class="modal-close" type="button" data-action="close-modal">CLOSE</button>
    </div>
    <h2>${escapeHtml(task.title)}</h2>
    <div class="modal-meta">
      <span>P${task.priority}</span>
      <span>${task.branchName ? escapeHtml(task.branchName) : "NO BRANCH"}</span>
      <span>${task.parentThreadId ? "PARENT THREAD" : "NO PARENT"}</span>
      <span>${task.threadId ? "CHILD THREAD" : "NO CHILD"}</span>
    </div>
    <section>
      <h3>Threads</h3>
      <pre>${
    escapeHtml([
      `Parent: ${task.parentThreadId || "none"}`,
      `Child: ${task.threadId || "none"}`,
      `Active turn: ${task.activeTurnId || "none"}`,
      `Manifest: ${task.contextManifestPath || "none"}`,
    ].join("\n"))
  }</pre>
    </section>
    <section>
      <h3>Task Card</h3>
      <pre>${escapeHtml(task.taskCard || "No compact task card recorded.")}</pre>
    </section>
    ${
    task.conflictSignals?.length
      ? `<section><h3>Conflict Signals</h3><pre>${
        escapeHtml(task.conflictSignals.map((item) => `- ${item}`).join("\n"))
      }</pre></section>`
      : ""
  }
    <section>
      <h3>Plan</h3>
      <pre>${escapeHtml(task.description || "No compiled plan recorded.")}</pre>
    </section>
    <section>
      <h3>Acceptance</h3>
      <pre>${escapeHtml(task.acceptanceCriteria || "No acceptance criteria recorded.")}</pre>
    </section>
    <section>
      <h3>Workpad</h3>
      <pre>${escapeHtml(task.workpad || "No workpad notes recorded.")}</pre>
    </section>
    ${
    task.validation
      ? `<section><h3>Validation</h3><pre>${escapeHtml(task.validation)}</pre></section>`
      : ""
  }
    ${
    task.handoffSummary
      ? `<section><h3>Handoff</h3><pre>${escapeHtml(task.handoffSummary)}</pre></section>`
      : ""
  }
  `;
  taskModalEl.hidden = false;
  taskModalEl.querySelector("[data-action='close-modal']")?.addEventListener(
    "click",
    closeTaskModal,
  );
}

function closeTaskModal() {
  taskModalEl.hidden = true;
  taskModalContentEl.innerHTML = "";
}

async function handleCardAction(task, action) {
  if (action === "delete") {
    await deleteTask(task);
    return;
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

async function deleteTask(task) {
  await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" })
    .then(async (response) => {
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || response.statusText);
      }
      return response.json();
    })
    .then((payload) => {
      if (state.selectedTaskId === task.id) {
        state.selectedTaskId = null;
      }
      if (payload.board) {
        state.board = payload.board;
        render();
      }
    })
    .catch((error) => alert(error.message));
  await loadBoard();
}

function renderCommandCenter() {
  const groups = new Map();
  for (const event of compactEvents(displayEvents(state.board.events)).slice(-80)) {
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
      events.slice(-12).map((event) => `
          <div class="terminal-line">
            <span class="time">${timeOnly(event.createdAt)}</span>
            <span class="kind" title="${escapeHtml(event.kind)}">${
        escapeHtml(shortKind(event.kind))
      }</span>
            <span class="message" title="${escapeHtml(event.message)}">${
        escapeHtml(shortMessage(event.message))
      }</span>
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

function displayEvents(events) {
  return events.filter((event) => {
    if (!event.message?.trim()) return false;
    if (["agent", "reasoning", "thread/tokenUsage/updated"].includes(event.kind)) return false;
    if (event.kind === "mcpServer/startupStatus/updated") return false;
    if (event.kind === "serverRequest/resolved") return false;
    if (event.kind === "account/rateLimits/updated") return false;
    if (event.message.startsWith("Codex event: mcpServer/")) return false;
    if (event.message === "Token usage updated.") return false;
    if (event.message === "Codex event: serverRequest/resolved") return false;
    return true;
  });
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

function shortKind(value) {
  const text = String(value || "");
  if (text.includes("/")) return text.split("/").at(-1);
  return text.length > 18 ? `${text.slice(0, 17)}...` : text;
}

function shortMessage(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 180 ? `${text.slice(0, 177)}...` : text;
}

function labelFor(status) {
  return state.board.statuses.find((item) => item.id === status)?.label || status;
}

function statusBadge(task) {
  if (task.status === "blocked") return "NEEDS INPUT";
  if (task.status === "done") return "MERGED";
  if (task.status === "merging") return "MERGING";
  if (task.status === "review") return "REVIEWING";
  if (task.status === "in_progress") return task.branchName ? "ACTIVE" : "STARTED";
  return task.branchName ? "BRANCH" : "QUEUED";
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
