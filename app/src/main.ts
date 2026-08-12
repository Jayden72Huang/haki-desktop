import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/* ---------- 类型 ---------- */
interface ProjectToday {
  cwd: string;
  tokens: number;
  edits: number;
  first_ts: string;
  last_ts: string;
}
interface UsageToday {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  all: number;
  sessions: number;
  scanned_files: number;
  projects: string[];
  per_project: ProjectToday[];
}
interface AgentProc {
  agent: string;
  pid: number;
  cwd: string | null;
  project: string | null;
}
interface AgentStatus {
  status: "running" | "needs_input" | "done";
  last_task: string;
  last_ts: string;
}
interface RepoToday {
  path: string;
  name: string;
  commits_today: number;
  unpushed: number;
  last_commit_min: number | null;
  last_message: string;
}
interface HackEvent {
  name: string;
  start: string; // ISO
  end: string; // ISO
}

type Mode = "daily" | "hackathon";

/* ---------- 工具 ---------- */
const $ = (id: string) => document.getElementById(id)!;
const fmt = (n: number): string => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(n);
};
const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const store = {
  get<T>(key: string, def: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : def;
    } catch {
      return def;
    }
  },
  set(key: string, val: unknown) {
    localStorage.setItem(key, JSON.stringify(val));
  },
  del(key: string) {
    localStorage.removeItem(key);
  },
};

/* ---------- 全局状态 ---------- */
let mode: Mode = store.get<Mode>("mode", "daily");
let expanded = false;
let usage: UsageToday | null = null;
let agents: AgentProc[] = [];
let agentStatus: Record<string, AgentStatus> = {};
let repos: RepoToday[] = [];
let event = store.get<HackEvent | null>("event", null);
const openRows = new Set<string>();

const PHASES = [
  { name: "立项", ratio: 0.15 },
  { name: "核心功能", ratio: 0.45 },
  { name: "打磨", ratio: 0.25 },
  { name: "提交材料", ratio: 0.15 },
];
const DEFAULT_CHECKLIST = ["线上 demo 可访问", "README 补齐运行说明", "演示视频 ≤ 3 分钟", "完成平台提交"];

/* ---------- 窗口尺寸 ---------- */
async function fitWindow() {
  const h = expanded ? Math.min(document.body.scrollHeight + 12, 620) : 64;
  await getCurrentWindow().setSize(new LogicalSize(660, h));
}

/* ---------- 数据刷新 ---------- */
async function refreshUsage() {
  try {
    usage = await invoke<UsageToday>("usage_today");
    repos = await invoke<RepoToday[]>("dev_today", { paths: usage.projects });
  } catch (e) {
    console.error(e);
  }
  render();
}

async function refreshAgents() {
  try {
    agents = await invoke<AgentProc[]>("running_agents");
    const statuses: Record<string, AgentStatus> = {};
    await Promise.all(
      agents
        .filter((a) => a.agent === "claude" && a.cwd)
        .map(async (a) => {
          try {
            statuses[a.cwd!] = await invoke<AgentStatus>("agent_status", { cwd: a.cwd });
          } catch {
            /* 该目录没有会话记录,忽略 */
          }
        })
    );
    agentStatus = statuses;
  } catch (e) {
    console.error(e);
  }
  render();
}

/* ---------- agent 行状态与展示 ---------- */
type DotState = "running" | "confirm" | "done-new" | "done-seen";

function dotState(a: AgentProc): DotState {
  const st = a.cwd ? agentStatus[a.cwd] : undefined;
  if (!st) return "running"; // 无会话信息(如 codex),进程在即视为运行中
  if (st.status === "running") return "running";
  if (st.status === "needs_input") return "confirm";
  const viewed = store.get<Record<string, string>>("viewedAt", {});
  return a.cwd && viewed[a.cwd] && viewed[a.cwd] >= st.last_ts ? "done-seen" : "done-new";
}

const DOT_LABEL: Record<DotState, string> = {
  running: "运行中",
  confirm: "待确认",
  "done-new": "已完成 · 未查看",
  "done-seen": "已完成",
};

function durationText(p: ProjectToday): string {
  const min = Math.max(1, Math.round((new Date(p.last_ts).getTime() - new Date(p.first_ts).getTime()) / 60_000));
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
}

function markViewed(cwd: string) {
  const st = agentStatus[cwd];
  if (!st) return;
  const viewed = store.get<Record<string, string>>("viewedAt", {});
  viewed[cwd] = st.last_ts;
  store.set("viewedAt", viewed);
}

/* ---------- 渲染 ---------- */
function render() {
  renderPill();
  if (!expanded) return;
  $("daily-view").classList.toggle("hidden", mode !== "daily");
  $("hackathon-view").classList.toggle("hidden", mode !== "hackathon");
  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  if (mode === "daily") renderDaily();
  else renderHackathon();
  void fitWindow();
}

function renderPill() {
  if (mode === "hackathon" && event) {
    const left = countdownText();
    $("pill-title").textContent = event.name;
    $("pill-main").textContent = left ? `距提交 ${left}` : "已截止";
    const status = $("pill-status");
    const ms = new Date(event.end).getTime() - Date.now();
    if (ms <= 0) {
      status.textContent = "已结束";
      status.className = "badge";
    } else if (ms < 2 * 3600_000) {
      status.textContent = "最后冲刺";
      status.className = "badge red";
    } else {
      status.textContent = "进行中";
      status.className = "badge green";
    }
  } else {
    $("pill-title").textContent = "HackerTrip";
    $("pill-main").textContent = usage ? `今日 ${fmt(usage.all)} tokens` : "今日 —";
    const status = $("pill-status");
    const n = agents.length;
    status.textContent = n > 0 ? `${n} 个 agent 运行中` : "无 agent 运行";
    status.className = n > 0 ? "badge green" : "badge";
  }
}

function renderDaily() {
  $("d-tokens").textContent = usage
    ? `${fmt(usage.all)} tokens · ${usage.sessions} 会话`
    : "—";

  const al = $("agent-list");
  if (agents.length === 0) {
    al.innerHTML = `<div class="row"><span class="sub">当前没有检测到运行中的 coding agent</span></div>`;
  } else {
    al.innerHTML = agents
      .map((a) => {
        const key = `${a.agent}:${a.cwd ?? a.pid}`;
        const state = dotState(a);
        const p = usage?.per_project.find((x) => x.cwd === a.cwd);
        const meta = p
          ? `${p.edits} 处改动 · ${durationText(p)} · ${fmt(p.tokens)} tokens`
          : "—";
        const st = a.cwd ? agentStatus[a.cwd] : undefined;
        const open = openRows.has(key);
        const detail = open
          ? `<div class="agent-detail">
               <div class="detail-line"><span class="detail-k">当前任务</span>${esc(st?.last_task || "(暂无任务记录)")}</div>
               <div class="detail-line"><span class="detail-k">目录</span><span class="mono">${esc(a.cwd ?? "—")}</span></div>
               <div class="detail-line"><span class="detail-k">状态</span>${DOT_LABEL[state]}</div>
             </div>`
          : "";
        return `
      <div class="agent-row" data-key="${esc(key)}" data-cwd="${esc(a.cwd ?? "")}">
        <div class="row">
          <span class="dot ${state}"></span>
          <span class="label strong">${esc(a.agent)}</span>
          <span class="sub">${esc(a.project ?? "")}</span>
          <span class="spacer"></span>
          <span class="sub mono">${meta}</span>
          <span class="chev-sm">${open ? "⌄" : "›"}</span>
        </div>
        ${detail}
      </div>`;
      })
      .join("");
    al.querySelectorAll<HTMLElement>(".agent-row").forEach((el) => {
      el.addEventListener("click", () => {
        const key = el.dataset.key!;
        if (openRows.has(key)) {
          openRows.delete(key);
        } else {
          openRows.add(key);
          if (el.dataset.cwd) markViewed(el.dataset.cwd); // 展开即视为已查看
        }
        render();
      });
    });
  }

  const rl = $("repo-list");
  const active = repos.filter((r) => r.commits_today > 0 || r.unpushed > 0);
  if (active.length === 0) {
    rl.innerHTML = `<div class="row"><span class="sub">今天还没有 commit 记录</span></div>`;
  } else {
    rl.innerHTML = active
      .slice(0, 6)
      .map(
        (r) => `
      <div class="row">
        <span class="icon check">✓</span>
        <span class="label">${esc(r.name)}</span>
        <span class="sub">${esc(r.last_message.slice(0, 28))}</span>
        <span class="spacer"></span>
        <span class="badge mono">${r.commits_today} commits</span>
        ${r.unpushed > 0 ? `<span class="badge mono yellow">${r.unpushed} 未 push</span>` : ""}
      </div>`
      )
      .join("");
  }
}

/* ---------- 每日 AI 总结 ---------- */
function summaryPayload(): string {
  return JSON.stringify({
    date: new Date().toISOString().slice(0, 10),
    tokens: usage ? { all: usage.all, output: usage.output, sessions: usage.sessions } : null,
    repos: repos
      .filter((r) => r.commits_today > 0 || r.unpushed > 0)
      .map((r) => ({ name: r.name, commits: r.commits_today, unpushed: r.unpushed, last: r.last_message })),
    runningAgents: agents.map((a) => ({ agent: a.agent, project: a.project })),
  });
}

async function generateSummary() {
  const btn = $("summary-btn") as HTMLButtonElement;
  const out = $("summary-out");
  btn.disabled = true;
  btn.textContent = "生成中…(调用本机 claude)";
  out.classList.remove("hidden");
  out.textContent = "";
  try {
    const text = await invoke<string>("ai_daily_summary", { data: summaryPayload() });
    out.textContent = text;
  } catch (e) {
    out.textContent = `生成失败:${e}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "生成今日 AI 总结";
    void fitWindow();
  }
}

/* ---------- 每晚 22:00 总结通知 ---------- */
async function ensureNotifyPermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

async function nightlyCheck() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getHours() < 22) return;
  if (store.get<string>("notifiedDate", "") === today) return;
  store.set("notifiedDate", today);
  if (!(await ensureNotifyPermission())) return;
  const commits = repos.reduce((s, r) => s + r.commits_today, 0);
  sendNotification({
    title: "今日开发总结",
    body: `${commits} commits · ${usage ? fmt(usage.all) : "—"} tokens,打开面板生成 AI 总结`,
  });
}

/* ---------- 比赛模式 ---------- */
function countdownText(): string | null {
  if (!event) return null;
  let ms = new Date(event.end).getTime() - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3600_000);
  ms -= h * 3600_000;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms - m * 60_000) / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(h)}:${p(m)}:${p(s)}`;
}

function renderHackathon() {
  const hasEvent = !!event;
  $("event-form").classList.toggle("hidden", hasEvent);
  $("event-live").classList.toggle("hidden", !hasEvent);
  if (!event) return;

  $("h-countdown").textContent = countdownText() ?? "已截止";
  $("h-tokens").textContent = usage ? `${fmt(usage.all)} tokens · ${usage.sessions} 会话` : "—";

  // 阶段进度
  const start = new Date(event.start).getTime();
  const end = new Date(event.end).getTime();
  const progress = Math.min(1, Math.max(0, (Date.now() - start) / (end - start)));
  let acc = 0;
  $("h-phases").innerHTML = PHASES.map((ph) => {
    const from = acc;
    acc += ph.ratio;
    const cls = progress >= acc ? "done" : progress > from ? "now" : "";
    return `<div class="phase ${cls}"><div class="bar"></div><div class="name">${ph.name}</div></div>`;
  }).join("");

  // commit 状态(取今天 commit 最多的仓库)
  const top = repos[0];
  if (top && top.last_commit_min !== null) {
    const min = top.last_commit_min;
    $("h-commit").textContent = `${min < 60 ? `${min} 分钟前` : `${Math.floor(min / 60)} 小时前`} · ${top.name}`;
    $("h-commit-count").textContent = `今日 ${top.commits_today} 次`;
    const icon = $("h-commit-icon");
    icon.className = min > 45 ? "icon warn" : "icon check";
    icon.textContent = min > 45 ? "!" : "✓";
  } else {
    $("h-commit").textContent = "暂无记录";
    $("h-commit-count").textContent = "—";
  }

  renderChecklist();
}

function renderChecklist() {
  const checked = store.get<boolean[]>("checklist", DEFAULT_CHECKLIST.map(() => false));
  $("checklist").innerHTML = DEFAULT_CHECKLIST.map(
    (item, i) => `
    <div class="row check-item" data-i="${i}">
      <span class="icon ${checked[i] ? "check" : "dots"}">${checked[i] ? "✓" : "⠿"}</span>
      <span class="label ${checked[i] ? "strike" : ""}">${item}</span>
    </div>`
  ).join("");
  document.querySelectorAll<HTMLElement>(".check-item").forEach((el) => {
    el.addEventListener("click", () => {
      const i = Number(el.dataset.i);
      const c = store.get<boolean[]>("checklist", DEFAULT_CHECKLIST.map(() => false));
      c[i] = !c[i];
      store.set("checklist", c);
      renderChecklist();
    });
  });
}

function saveEvent() {
  const name = ($("ev-name") as HTMLInputElement).value.trim();
  const start = ($("ev-start") as HTMLInputElement).value;
  const end = ($("ev-end") as HTMLInputElement).value;
  if (!name || !end) return;
  event = { name, start: start || new Date().toISOString(), end };
  store.set("event", event);
  store.set("checklist", DEFAULT_CHECKLIST.map(() => false));
  render();
}

/* ---------- 展开/收起 ---------- */
async function setExpanded(next: boolean) {
  expanded = next;
  $("pill").classList.toggle("hidden", expanded);
  $("panel").classList.toggle("hidden", !expanded);
  render();
  await fitWindow();
}

/* ---------- 启动 ---------- */
window.addEventListener("DOMContentLoaded", () => {
  $("pill").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".badge")) return;
    void setExpanded(true);
  });
  $("collapse-btn").addEventListener("click", () => void setExpanded(false));

  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      mode = b.dataset.mode as Mode;
      store.set("mode", mode);
      render();
    });
  });

  $("summary-btn").addEventListener("click", () => void generateSummary());
  $("ev-save").addEventListener("click", saveEvent);
  $("ev-edit").addEventListener("click", () => {
    if (!event) return;
    ($("ev-name") as HTMLInputElement).value = event.name;
    ($("ev-start") as HTMLInputElement).value = event.start.slice(0, 16);
    ($("ev-end") as HTMLInputElement).value = event.end.slice(0, 16);
    event = null;
    render();
  });
  $("ev-finish").addEventListener("click", () => {
    event = null;
    store.del("event");
    mode = "daily";
    store.set("mode", mode);
    render();
  });

  void setExpanded(false);
  void refreshUsage();
  void refreshAgents();
  setInterval(() => void refreshUsage(), 60_000); // 用量/仓库:每分钟
  setInterval(() => void refreshAgents(), 15_000); // agent 进程:每 15 秒
  setInterval(() => void nightlyCheck(), 60_000); // 22:00 每日总结提醒
  setInterval(() => {
    if (mode === "hackathon" && event) renderPill();
    if (expanded && mode === "hackathon" && event) $("h-countdown").textContent = countdownText() ?? "已截止";
  }, 1000); // 倒计时每秒走
});
