"use strict";

const element = (id) => document.getElementById(id);
const content = element("content");
const taskDialog = element("task-dialog");
const createDialog = element("create-dialog");
const appearanceDialog = element("appearance-dialog");
const directoriesDialog = element("directories-dialog");
const form = element("create-form");
const labels = {
  planned: "计划中", active: "进行中", paused: "已暂停", completed: "已结项",
  todo: "待办", in_progress: "进行中", blocked: "阻塞", done: "已完成", cancelled: "已取消",
};
const boardStates = ["todo", "in_progress", "blocked", "done"];
let projects = [];
let issues = [];
let registeredDirectories = [];
let hasLoaded = false;
let createProject = null;
let requestId;
let taskRequest = null;
let boardProjectId;
let boardFilter;
const selectedDirectories = new Set();
let directoryLocation;
let directoryRequest;
let scanningDirectories = false;
let removingDirectory = false;

const themeColors = { paper: "#f6f6ef", blue: "#f1f5fb", dark: "#171a19" };
const systemTheme = matchMedia("(prefers-color-scheme: dark)");
const themeInputs = [...appearanceDialog.querySelectorAll('[name="theme"]')];
let theme = "paper";
try {
  const saved = localStorage.getItem("kanban-theme");
  if (themeInputs.some((input) => input.value === saved)) theme = saved;
} catch {
  // The active theme still works when browser storage is unavailable.
}

function applyTheme() {
  const resolved = theme === "system" ? (systemTheme.matches ? "dark" : "paper") : theme;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]').content = themeColors[resolved];
  for (const input of themeInputs) input.checked = input.value === theme;
}

for (const input of themeInputs) {
  input.addEventListener("change", () => {
    theme = input.value;
    applyTheme();
    try {
      localStorage.setItem("kanban-theme", theme);
    } catch {
      // Keep the selection for this page when it cannot be stored.
    }
  });
}
systemTheme.addEventListener("change", applyTheme);
element("open-appearance").addEventListener("click", () => appearanceDialog.showModal());
applyTheme();

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined && text !== null) result.textContent = text;
  return result;
}

function linked(className, text, href) {
  const link = node("a", className, text);
  link.href = href;
  return link;
}

function projectLink(project, task) {
  const path = "#project/" + encodeURIComponent(project.project_id);
  return task ? path + "/" + encodeURIComponent(task.id) : path;
}

function route() {
  const [view, projectId, taskId] = location.hash.slice(1).split("/");
  if (view !== "project" || !projectId) return {};
  try {
    return { projectId: decodeURIComponent(projectId), taskId: taskId && decodeURIComponent(taskId) };
  } catch {
    return {};
  }
}

function notify(text = "", type = "info") {
  const message = element("message");
  message.hidden = !text;
  message.textContent = text;
  message.dataset.type = type;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "操作失败，请重试");
  return data;
}

function showDirectoryError(message = "") {
  const feedback = element("directory-message");
  feedback.textContent = message;
  feedback.hidden = !message;
}

function updateDirectorySelection() {
  const count = selectedDirectories.size;
  element("directory-count").textContent = count ? "已选 " + count + " 个目录" : "尚未选择目录";
  element("scan-directories").disabled = !count || scanningDirectories || removingDirectory || element("directory-list").hasAttribute("aria-busy");
}

function toggleDirectory(path, checked) {
  if (checked) selectedDirectories.add(path);
  else selectedDirectories.delete(path);
  updateDirectorySelection();
}

async function browseDirectory(path) {
  directoryRequest?.abort();
  const request = new AbortController();
  directoryRequest = request;
  showDirectoryError();
  const list = element("directory-list");
  list.setAttribute("aria-busy", "true");
  element("scan-directories").disabled = true;
  try {
    const query = path ? "?" + new URLSearchParams({ path }) : "";
    const data = await api("/api/directories" + query, { signal: request.signal });
    if (request.signal.aborted) return;
    directoryLocation = data;
    element("directory-path").value = data.path;
    element("directory-parent").disabled = !data.parent;
    const current = element("directory-current");
    current.disabled = false;
    current.checked = selectedDirectories.has(data.path);
    list.replaceChildren(...data.folders.map(({ name, path }) => {
      const row = node("div", "directory-row");
      const check = node("input");
      check.type = "checkbox";
      check.checked = selectedDirectories.has(path);
      check.setAttribute("aria-label", "选择目录 " + name);
      check.addEventListener("change", () => toggleDirectory(path, check.checked));
      const open = node("button", "directory-open", name);
      open.type = "button";
      open.setAttribute("aria-label", "打开目录 " + name);
      open.append(mark("directory-arrow", "›", "neutral"));
      open.addEventListener("click", () => browseDirectory(path));
      row.append(check, open);
      return row;
    }));
    if (!data.folders.length) list.append(node("p", "empty-directory", "此目录没有子目录"));
  } catch (error) {
    if (!request.signal.aborted) showDirectoryError(error.message);
  } finally {
    if (!request.signal.aborted) {
      list.removeAttribute("aria-busy");
      updateDirectorySelection();
    }
  }
}

function openDirectories() {
  selectedDirectories.clear();
  element("directory-list").replaceChildren();
  const current = element("directory-current");
  current.disabled = true;
  current.checked = false;
  element("directory-parent").disabled = true;
  updateDirectorySelection();
  renderRegisteredDirectories();
  directoriesDialog.showModal();
  browseDirectory(directoryLocation?.path);
}

function renderRegisteredDirectories() {
  element("registered-directories").hidden = !registeredDirectories.length;
  element("registered-directory-list").replaceChildren(...registeredDirectories.map((path) => {
    const row = node("li", "registered-directory");
    const remove = node("button", "button", "移除");
    remove.type = "button";
    remove.setAttribute("aria-label", "移除目录 " + path);
    remove.disabled = removingDirectory || scanningDirectories;
    remove.addEventListener("click", async () => {
      removingDirectory = true;
      renderRegisteredDirectories();
      updateDirectorySelection();
      showDirectoryError();
      try {
        await api("/api/directories/remove", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
        });
        if (!await refresh()) showDirectoryError("目录已移除，但列表刷新失败。请关闭窗口后刷新数据。");
      } catch (error) {
        showDirectoryError(error.message);
      } finally {
        removingDirectory = false;
        renderRegisteredDirectories();
        updateDirectorySelection();
      }
    });
    row.append(node("span", "", path), remove);
    return row;
  }));
}

element("directory-address").addEventListener("submit", (event) => {
  event.preventDefault();
  browseDirectory(element("directory-path").value.trim());
});
element("directory-parent").addEventListener("click", () => browseDirectory(directoryLocation?.parent));
element("directory-current").addEventListener("change", (event) => {
  toggleDirectory(directoryLocation.path, event.target.checked);
});
directoriesDialog.addEventListener("close", () => directoryRequest?.abort());
element("scan-directories").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const fields = [...directoriesDialog.querySelectorAll(".dialog-body button, .dialog-body input")];
  const enabled = fields.filter((field) => !field.disabled);
  for (const field of enabled) field.disabled = true;
  scanningDirectories = true;
  renderRegisteredDirectories();
  updateDirectorySelection();
  button.textContent = "正在扫描…";
  showDirectoryError();
  try {
    const result = await api("/api/directories", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [...selectedDirectories] }),
    });
    directoriesDialog.close();
    if (await refresh()) {
      const parts = [result.added ? "已加入 " + result.added + " 个项目" : "没有新项目"];
      if (result.skipped) parts.push("已跳过 " + result.skipped + " 个重复项目");
      if (result.empty) parts.push(result.empty + " 个目录没有有效项目索引");
      if (result.recovered) parts.push("已备份并重建目录清单");
      notify([...parts, ...issues].join(" · "), issues.length ? "error" : "info");
    }
  } catch (error) {
    showDirectoryError(error.message);
  } finally {
    scanningDirectories = false;
    renderRegisteredDirectories();
    button.textContent = "扫描并加入";
    for (const field of enabled) field.disabled = false;
    updateDirectorySelection();
  }
});

function mark(className, symbol, tone) {
  const icon = node("span", className, symbol);
  icon.dataset.tone = tone;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function projectIcon(project, className) {
  const icon = node("span", className);
  icon.dataset.projectType = project.type || "other";
  icon.setAttribute("aria-hidden", "true");
  icon.append(node("span", "project-glyph"));
  return icon;
}

function badge(status) {
  const badge = node("span", "pill");
  badge.dataset.tone = status;
  badge.append(mark("status-dot", "", status), labels[status] || "状态未知");
  return badge;
}

function localDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function renderNavigation(selected) {
  element("breadcrumb-current").textContent = selected?.name || "项目总览";
  const overview = element("overview-link");
  if (selected) overview.removeAttribute("aria-current");
  else overview.setAttribute("aria-current", "page");
  element("project-nav").replaceChildren(...projects.map((project) => {
    const link = linked("nav-link", "", projectLink(project));
    link.append(projectIcon(project, "nav-project-icon"), project.name);
    if (project === selected) link.setAttribute("aria-current", "page");
    return link;
  }));
  const picker = element("project-picker");
  picker.replaceChildren(new Option("项目总览", ""), ...projects.map((project) => new Option(project.name, project.project_id)));
  picker.value = selected?.project_id || "";
}

element("project-picker").addEventListener("change", (event) => {
  const selected = projects.find((project) => project.project_id === event.target.value);
  location.hash = selected ? projectLink(selected) : "#overview";
});

function hero(title, description) {
  const section = node("section", "hero");
  const heading = node("div");
  heading.append(node("h1", "", title));
  if (description) heading.append(node("p", "", description));
  section.append(heading);
  return section;
}

function stats(items) {
  const section = node("section", "stats");
  section.setAttribute("aria-label", "统计");
  for (const [name, value, symbol, tone] of items) {
    const stat = node("div", "stat");
    const text = node("div");
    text.append(node("span", "stat-name", name), node("strong", "stat-number", value));
    stat.append(mark("stat-icon", symbol, tone), text);
    section.append(stat);
  }
  return section;
}

function sectionHead(title, hint) {
  const header = node("div", "section-head");
  header.append(node("h2", "", title));
  if (hint) header.append(node("span", "section-hint", hint));
  return header;
}

function projectRow(project) {
  const row = node("li", "project-row");
  const identity = node("div", "project-identity");
  const heading = node("div", "project-heading");
  const link = linked("project-name", "", projectLink(project));
  link.append(project.name, mark("project-arrow", "↗", "neutral"));
  heading.append(link, node("span", "stage", project.stage || "—"));
  identity.append(projectIcon(project, "project-icon"), heading);
  const status = node("div", "project-status");
  status.append(badge(project.status));
  const nextCell = node("div", "next-task");
  nextCell.append(node("span", "field-label", "下一项任务"));
  const next = project.tasks.find((task) => task.id === project.next_task_id);
  if (next) nextCell.append(linked("next-link", next.id + " · " + next.title, projectLink(project, next)));
  else nextCell.append(node("span", "muted", "暂无"));

  const progressCell = node("div", "project-progress");
  progressCell.append(node("span", "field-label", "任务进度"));
  const progress = node("div", "progress");
  const total = project.tasks.filter((task) => task.status !== "cancelled").length;
  const done = project.tasks.filter((task) => task.status === "done").length;
  if (total) {
    const bar = node("progress");
    bar.value = done;
    bar.max = total;
    bar.setAttribute("aria-label", "已完成任务");
    progress.append(bar, done + "/" + total);
  } else {
    progress.textContent = "暂无任务";
  }
  progressCell.append(progress);
  const blocked = project.tasks.filter((task) => task.status === "blocked").length;
  const blockedCell = node("div", "project-blocked");
  blockedCell.append(node("span", "field-label", "阻塞"), node("strong", "blocked-value", blocked));
  if (blocked) blockedCell.dataset.tone = "blocked";
  row.append(identity, status, nextCell, progressCell, blockedCell);
  return row;
}

function renderOverview() {
  const allTasks = projects.flatMap((project) => project.tasks);
  const panel = node("section", "project-list");
  panel.append(sectionHead("项目列表", projects.length + " 个项目"));
  if (projects.length) {
    const list = node("ul", "project-rows");
    list.append(...projects.map(projectRow));
    panel.append(list);
  } else {
    panel.append(node("p", "empty", "选择项目目录后，识别到的项目会显示在这里。"));
  }
  const title = hero("项目总览");
  title.classList.add("overview-hero");
  const add = node("button", "button button-primary", "选择项目目录");
  add.id = "open-directories";
  add.type = "button";
  add.setAttribute("aria-haspopup", "dialog");
  add.addEventListener("click", openDirectories);
  title.append(add);
  content.replaceChildren(
    title,
    stats([
      ["项目", projects.length, "▦", "accent"],
      ["进行中的项目", projects.filter((project) => project.status === "active").length, "↗", "in_progress"],
      ["阻塞任务", allTasks.filter((task) => task.status === "blocked").length, "!", "blocked"],
      ["已完成任务", allTasks.filter((task) => task.status === "done").length, "✓", "done"],
    ]),
    panel,
  );
}

function taskCard(project, task) {
  const link = linked("task-card", "", projectLink(project, task));
  const meta = node("span", "task-card-top");
  meta.append(node("span", "task-id", task.id));
  if (task.id === project.next_task_id) meta.append(node("span", "pill", "下一项"));
  link.append(meta, node("strong", "task-card-title", task.title));
  const note = task.blocked_reason || (task.completed_at ? localDate(task.completed_at) : "");
  if (note) link.append(node("span", "task-card-note", note));
  return link;
}

function renderProject(project) {
  const title = hero(project.name, project.summary);
  title.classList.add("project-hero");
  const updated = [project.stage, localDate(project.updated_at)].filter(Boolean);
  if (updated.length) title.firstChild.append(node("p", "updated", updated.join(" · 更新于 ")));
  const actions = node("div", "hero-actions");
  actions.append(badge(project.status));
  if (project.writable) {
    const add = node("button", "button button-primary", "＋ 新建任务");
    add.type = "button";
    add.addEventListener("click", () => openCreate(project));
    actions.append(add);
  }
  title.append(actions);

  const section = node("section", "project-board");
  section.append(sectionHead("任务看板", project.writable ? "" : "只读项目"));
  if (boardProjectId !== project.project_id) {
    boardProjectId = project.project_id;
    boardFilter = boardStates.find((state) => project.tasks.some((task) => task.status === state)) || "todo";
  }
  const filters = node("div", "board-filters");
  filters.setAttribute("role", "group");
  filters.setAttribute("aria-label", "筛选任务状态");
  const board = node("div", "board");
  board.dataset.filter = boardFilter;
  for (const state of boardStates) {
    const tasks = project.tasks.filter((task) => task.status === state);
    const filter = node("button", "board-filter");
    filter.type = "button";
    filter.dataset.state = state;
    filter.setAttribute("aria-pressed", String(boardFilter === state));
    filter.append(node("span", "", labels[state]), node("span", "filter-count", tasks.length));
    filter.addEventListener("click", () => {
      boardFilter = state;
      board.dataset.filter = state;
      for (const button of filters.children) button.setAttribute("aria-pressed", String(button === filter));
    });
    filters.append(filter);
    const lane = node("section", "lane");
    lane.dataset.tone = state;
    const heading = node("div", "lane-head");
    heading.append(mark("status-dot", "", state), node("h3", "", labels[state]), node("span", "lane-count", tasks.length));
    lane.append(heading);
    if (tasks.length) lane.append(...tasks.map((task) => taskCard(project, task)));
    else lane.append(node("p", "lane-empty", "暂无任务"));
    board.append(lane);
  }
  section.append(filters, board);
  const cancelled = project.tasks.filter((task) => task.status === "cancelled");
  if (cancelled.length) {
    const details = node("details", "cancelled");
    details.append(node("summary", "", "已取消 · " + cancelled.length), ...cancelled.map((task) => taskCard(project, task)));
    section.append(details);
  }
  content.replaceChildren(title, section);
}

function safeExternalUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function appendInline(paragraph, text) {
  const tokens = /\x60([^\x60\n]+)\x60|\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    paragraph.append(text.slice(offset, match.index));
    if (match[1]) {
      paragraph.append(node("code", "", match[1]));
    } else {
      const url = safeExternalUrl(match[3]);
      if (url) {
        const link = linked("", match[2], url);
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        paragraph.append(link);
      } else {
        paragraph.append(match[2]);
      }
    }
    offset = match.index + match[0].length;
  }
  paragraph.append(text.slice(offset));
}

function appendDetail(target, body) {
  const lines = body.trim().split(/\n\s*\n/);
  for (const block of lines) {
    const text = block.replace(/^<!--[^\n]*-->\s*/gm, "").trim();
    if (!text || /^#\s/.test(text)) continue;
    const heading = text.match(/^#{2,6}\s+([^\n]+)(?:\n([\s\S]*))?$/);
    if (heading) target.append(node("h3", "", heading[1]));
    const paragraph = heading ? heading[2] : text;
    if (paragraph) {
      const item = node("p");
      appendInline(item, paragraph);
      target.append(item);
    }
  }
}

async function openTask(project, task) {
  taskRequest?.abort();
  const request = new AbortController();
  taskRequest = request;
  element("task-project").textContent = project.name;
  element("task-meta").replaceChildren(node("span", "task-id", task.id), badge(task.status));
  element("task-title").textContent = task.title;
  element("copy-status").textContent = "";
  const copy = element("copy-command");
  copy.hidden = true;
  const body = element("task-body");
  body.replaceChildren(node("p", "muted", "正在读取任务详情…"));
  if (!taskDialog.open) taskDialog.showModal();
  const params = new URLSearchParams({ project: project.project_id, task: task.id });
  try {
    const data = await api("/api/task?" + params, { signal: request.signal });
    if (request.signal.aborted) return;
    if (data.workflow && task.status === "todo") {
      const { script, project: directory } = data.workflow;
      const command = [
        "请执行智能体看板中的任务 " + task.id + "。",
        "项目目录：" + directory,
        "任务工具：" + script,
        "使用本机 Python 运行任务工具。先用 task show 传入项目目录和任务编号读取详情，再用 task start 领取并取得 run_id。验证后将执行结果写到 Markdown 文件，用 task finish 传入项目目录、任务编号和 run_id，并通过 --record 指定结果文件。若受阻，改用 task block 并通过 --reason 填写原因。",
      ].join("\n");
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(command);
          element("copy-status").textContent = "已复制";
        } catch {
          element("copy-status").textContent = command;
        }
      };
      copy.hidden = false;
    }
    body.replaceChildren();
    if (task.blocked_reason) body.append(node("h3", "", "阻塞原因"), node("p", "", task.blocked_reason));
    if (data.body) appendDetail(body, data.body);
    if (data.url) {
      const link = linked("", "打开外部任务详情", data.url);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      body.append(link);
    }
    if (data.error || (!data.body && !data.url)) {
      body.append(node("p", "muted", data.error || "此任务只有索引记录。"));
    }
  } catch (error) {
    if (!request.signal.aborted) body.replaceChildren(node("p", "muted", error.message));
  }
}

function render() {
  if (!hasLoaded) return;
  const { projectId, taskId } = route();
  const project = projects.find((item) => item.project_id === projectId);
  renderNavigation(project);
  if (project) renderProject(project);
  else renderOverview();
  const task = project?.tasks.find((item) => item.id === taskId);
  if (task) {
    openTask(project, task);
  } else if (taskDialog.open) {
    taskRequest?.abort();
    taskDialog.close();
  }
  const unavailable = projectId && !project ? "该项目当前无法打开。" : "";
  const missing = project && taskId && !task ? "该任务当前无法打开。" : "";
  notify([unavailable, missing, ...issues].filter(Boolean).join(" · "), unavailable || missing || issues.length ? "error" : "info");
}

async function refresh(interactive = false) {
  const button = element("refresh");
  button.disabled = true;
  try {
    ({ projects, issues, directories: registeredDirectories } = await api("/api/projects"));
    hasLoaded = true;
    render();
    if (interactive && element("message").hidden) notify("已刷新项目数据");
    return true;
  } catch {
    notify("无法读取本地项目数据，请确认看板正在运行后刷新。", "error");
    if (!hasLoaded) content.replaceChildren();
    return false;
  } finally {
    button.disabled = false;
  }
}

function openCreate(project) {
  createProject = project;
  requestId = crypto.randomUUID();
  form.reset();
  element("create-error").hidden = true;
  element("create-project").textContent = project.name;
  createDialog.showModal();
  form.elements.title.focus();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector("[type=submit]");
  if (submit.disabled) return;
  const errorMessage = element("create-error");
  const fields = Object.fromEntries(new FormData(form));
  const project = createProject;
  const payload = {
    project_id: project.project_id, request_id: requestId,
    title: fields.title.trim(), scope: fields.scope.trim(),
    acceptance: fields.acceptance.trim(), set_next: fields.set_next === "on",
  };
  if (!payload.title) {
    errorMessage.textContent = "请填写任务标题。";
    errorMessage.hidden = false;
    return;
  }
  errorMessage.hidden = true;
  submit.disabled = true;
  try {
    const task = await api("/api/tasks", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    createDialog.close();
    if (await refresh()) {
      boardFilter = "todo";
      location.hash = projectLink(project, task);
    } else {
      notify("任务 " + task.id + " 已保存，请刷新查看。");
    }
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
  } finally {
    submit.disabled = false;
  }
});

createDialog.addEventListener("cancel", (event) => {
  if (form.querySelector("[type=submit]").disabled) event.preventDefault();
});
directoriesDialog.addEventListener("cancel", (event) => {
  if (scanningDirectories || removingDirectory) event.preventDefault();
});
for (const close of document.querySelectorAll("[data-close]")) {
  close.addEventListener("click", () => {
    const dialog = close.closest("dialog");
    if (dialog === createDialog && form.querySelector("[type=submit]").disabled) return;
    if (dialog === directoriesDialog && (scanningDirectories || removingDirectory)) return;
    dialog.close();
  });
}
taskDialog.addEventListener("close", () => {
  const { projectId, taskId } = route();
  if (taskId && !taskDialog.open) {
    taskRequest?.abort();
    history.replaceState(null, "", "#project/" + encodeURIComponent(projectId));
    const link = [...content.querySelectorAll(".task-card")].find((card) => card.hash === "#project/" + encodeURIComponent(projectId) + "/" + encodeURIComponent(taskId));
    link?.focus();
  }
});
element("refresh").addEventListener("click", () => refresh(true));
window.addEventListener("hashchange", render);
refresh();
