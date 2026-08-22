import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import QRCode from "qrcode";

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
interface Milestone {
  at: string; // ISO
  title: string;
  action: string;
  critical: boolean;
}
interface HackEvent {
  name: string;
  start: string; // ISO
  end: string; // ISO
  doc?: string; // 主办方文档原文,问答时作为上下文
  milestones?: Milestone[];
}
interface WorkDraft {
  name: string;
  summary: string;
  repo: string;
  demo: string;
  techStack: string[];
  cover?: string;
  localPath?: string;
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
let showSettings = false;
const openRows = new Set<string>();
let workOpen = false;
let workDraft: WorkDraft | null = null;
/// 已经弹过提醒的节点(按 at 去重),避免每秒 tick 重复通知
const notifiedMilestones = new Set<string>(store.get<string[]>("notified_ms", []));

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
  $("settings-view").classList.toggle("hidden", !showSettings);
  $("daily-view").classList.toggle("hidden", showSettings || mode !== "daily");
  $("hackathon-view").classList.toggle("hidden", showSettings || mode !== "hackathon");
  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  if (!showSettings) {
    if (mode === "daily") renderDaily();
    else renderHackathon();
  }
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
/** 轻量 markdown 渲染:先转义 HTML,再处理加粗/分隔线/序号行,足够覆盖总结输出 */
function mdLite(src: string): string {
  return esc(src)
    .replace(/^-{3,}\s*$/gm, "<hr>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/^(\d+)\.\s+/gm, '<span class="md-num">$1.</span> ')
    .replace(/\n/g, "<br>");
}

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
    out.innerHTML = mdLite(text);
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

async function notify(title: string, body: string) {
  if (!(await ensureNotifyPermission())) return;
  sendNotification({ title, body });
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

/// 下一个还没到的节点
function nextMilestone(): Milestone | null {
  const list = event?.milestones ?? [];
  const now = Date.now();
  for (const m of list) {
    const t = new Date(m.at).getTime();
    if (!Number.isNaN(t) && t > now) return m;
  }
  return null;
}

/// 节点到点提醒:critical 节点提前 30 分钟提醒,普通节点到点提醒
function checkMilestoneAlerts() {
  if (!event?.milestones) return;
  const now = Date.now();
  for (const m of event.milestones) {
    const t = new Date(m.at).getTime();
    if (Number.isNaN(t)) continue;
    const lead = m.critical ? 30 * 60_000 : 0;
    const fireAt = t - lead;
    // 只在刚跨过触发点的 2 分钟窗口内提醒,避免开机就把过期节点全弹一遍
    if (now >= fireAt && now - fireAt < 2 * 60_000 && !notifiedMilestones.has(m.at)) {
      notifiedMilestones.add(m.at);
      store.set("notified_ms", [...notifiedMilestones]);
      void notify(
        m.critical ? `⚠️ ${m.title}` : m.title,
        lead > 0 ? `30 分钟后截止 · ${m.action}` : m.action
      );
    }
  }
}

function renderMilestones() {
  const list = event?.milestones ?? [];
  const box = $("h-milestones");
  if (!list.length) {
    box.innerHTML = `<div class="row"><span class="sub">还没有赛程节点。点右上「重新规划」,贴上主办方文档让本地 CLI 排一份。</span></div>`;
    return;
  }
  const now = Date.now();
  box.innerHTML = list
    .map((m) => {
      const t = new Date(m.at).getTime();
      const past = !Number.isNaN(t) && t <= now;
      const time = Number.isNaN(t)
        ? m.at
        : new Date(t).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
      return `
      <div class="row ms-item ${past ? "past" : ""}">
        <span class="ms-dot ${m.critical ? "critical" : ""} ${past ? "past" : ""}"></span>
        <span class="ms-time mono sub">${esc(time)}</span>
        <span class="label ${past ? "strike" : ""}">${esc(m.title)}</span>
        <span class="spacer"></span>
        <span class="sub ms-action">${esc(m.action)}</span>
      </div>`;
    })
    .join("");
}

function renderHackathon() {
  const hasEvent = !!event;
  $("event-form").classList.toggle("hidden", hasEvent);
  $("event-live").classList.toggle("hidden", !hasEvent);
  if (!event) return;

  $("h-countdown").textContent = countdownText() ?? "已截止";
  // 倒计时旁边跟一句「下一个节点是什么」,比只有截止时间更有指导性
  const nm = nextMilestone();
  const sub = $("h-countdown").nextElementSibling;
  if (sub) sub.textContent = nm ? `距提交截止 · 下一步:${nm.title}` : "距作品提交截止";
  $("h-tokens").textContent = usage ? `${fmt(usage.all)} tokens · ${usage.sessions} 会话` : "—";
  renderMilestones();

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

async function saveEvent() {
  const name = ($("ev-name") as HTMLInputElement).value.trim();
  const start = ($("ev-start") as HTMLInputElement).value;
  const end = ($("ev-end") as HTMLInputElement).value;
  const doc = ($("ev-doc") as HTMLTextAreaElement)?.value.trim() ?? "";
  if (!name || !end) return;
  event = { name, start: start || new Date().toISOString(), end, doc };
  store.set("event", event);
  store.set("checklist", DEFAULT_CHECKLIST.map(() => false));
  notifiedMilestones.clear();
  store.set("notified_ms", []);
  render();
  await planMilestones();
}

/* ---------- 赛事问答 ---------- */
async function askHackathon() {
  if (!event) return;
  const input = $("h-ask") as HTMLInputElement;
  const q = input.value.trim();
  if (!q) return;
  const out = $("h-ask-out");
  out.classList.remove("hidden");
  out.textContent = "本地 CLI 思考中…";
  await fitWindow();
  try {
    const ans = await invoke<string>("ask_hackathon", {
      question: q,
      name: event.name,
      doc: event.doc ?? "",
      milestones: JSON.stringify(event.milestones ?? []),
    });
    out.textContent = ans;
    input.value = "";
  } catch (e) {
    out.textContent = `问失败:${String(e).slice(0, 160)}`;
  }
  await fitWindow();
}

/* ---------- 交作品 ---------- */
/// Tauri 的拖放事件走窗口级 API,HTML5 的 drop 事件在 webview 里拿不到真实路径
async function setupWorkDrop() {
  await getCurrentWindow().onDragDropEvent(async (e) => {
    if (e.payload.type === "over") {
      $("work-drop").classList.add("hover");
      return;
    }
    if (e.payload.type === "leave") {
      $("work-drop").classList.remove("hover");
      return;
    }
    if (e.payload.type !== "drop") return;
    $("work-drop").classList.remove("hover");
    const p = e.payload.paths?.[0];
    if (!p) return;
    // 拖进来时如果面板没展开到交作品,自动帮他打开
    if (!workOpen) {
      workOpen = true;
      $("work-body").classList.remove("hidden");
      $("work-chev").textContent = "⌄";
    }
    await extractWork(p);
  });
}

async function extractWork(path: string) {
  const drop = $("work-drop");
  drop.classList.remove("hidden");
  drop.innerHTML = `正在读项目并交给本地 CLI 提炼…<div class="sub">${esc(path)}</div>`;
  await fitWindow();
  try {
    const raw = await invoke<string>("extract_work", { path });
    const w = JSON.parse(raw) as WorkDraft;
    workDraft = w;
    ($("w-name") as HTMLInputElement).value = w.name ?? "";
    ($("w-summary") as HTMLTextAreaElement).value = w.summary ?? "";
    ($("w-repo") as HTMLInputElement).value = w.repo ?? "";
    ($("w-demo") as HTMLInputElement).value = w.demo ?? "";
    ($("w-stack") as HTMLInputElement).value = (w.techStack ?? []).join(", ");
    drop.classList.add("hidden");
    $("work-form").classList.remove("hidden");
    $("w-status").textContent = "确认无误后提交";
  } catch (e) {
    drop.innerHTML = `提取失败:${esc(String(e).slice(0, 140))}<div class="sub">换个目录再拖一次</div>`;
  }
  await fitWindow();
}

/// 提交前按小程序端 pairSync 的硬校验先拦一道,省得白跑一趟网络
function validateWork(w: WorkDraft): string | null {
  if (!w.name.trim()) return "作品名必填";
  const okUrl = (u: string) => /^https?:\/\//i.test(u.trim());
  if (!okUrl(w.repo) && !okUrl(w.demo)) return "仓库和 demo 至少要有一个 http(s) 链接";
  return null;
}

async function submitWork() {
  const w: WorkDraft = {
    name: ($("w-name") as HTMLInputElement).value.trim(),
    summary: ($("w-summary") as HTMLTextAreaElement).value.trim(),
    repo: ($("w-repo") as HTMLInputElement).value.trim(),
    demo: ($("w-demo") as HTMLInputElement).value.trim(),
    techStack: ($("w-stack") as HTMLInputElement).value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 6),
    cover: "",
  };
  const err = validateWork(w);
  const status = $("w-status");
  if (err) {
    status.textContent = err;
    return;
  }
  workDraft = w;
  const code = ($("w-paircode") as HTMLInputElement).value.trim();
  const syncUrl = store.get<string>("syncUrl", "");
  const syncToken = store.get<string>("syncToken", "");
  if (!syncUrl || !syncToken) {
    status.textContent = "先去设置里填 pairSync 触发器地址和同步密钥";
    return;
  }
  status.textContent = "上传中…";
  try {
    // 和 hackertrip-cli publish-work 同一条链路,作品落到待审核区
    const msg = await invoke<string>("push_work", {
      syncUrl,
      syncToken,
      pairCode: code,
      work: JSON.stringify({ ...w, awards: "" }),
    });
    status.textContent = msg;
    $("w-xhs-row").classList.remove("hidden");
    await notify("作品已上传", "去小程序「我的 → 作品」确认发布");
  } catch (e) {
    status.textContent = `提交失败:${String(e).slice(0, 140)}`;
  }
  await fitWindow();
}

/// 小红书没有第三方发布 API,这里只做文案生成 + 唤起,最后一步选手手动粘贴
async function genXhsCopy() {
  if (!workDraft) return;
  const out = $("w-xhs-out");
  out.classList.remove("hidden");
  out.textContent = "生成中…";
  await fitWindow();
  try {
    const text = await invoke<string>("ask_hackathon", {
      question:
        `帮我给这个黑客松作品写一条小红书笔记。作品名:${workDraft.name};` +
        `做了什么:${workDraft.summary};技术栈:${(workDraft.techStack ?? []).join("/")}。` +
        `要求:标题 20 字以内带钩子,正文 300 字以内分点讲清做了什么和踩了什么坑,结尾 5 个话题标签。` +
        `直接输出标题和正文,不要解释。`,
      name: event?.name ?? "黑客松",
      doc: event?.doc ?? "",
      milestones: "[]",
    });
    out.textContent = text;
    await navigator.clipboard.writeText(text).catch(() => {});
    const tip = document.createElement("div");
    tip.className = "sub";
    tip.textContent = "已复制到剪贴板,点这里唤起小红书粘贴";
    tip.style.cursor = "pointer";
    tip.addEventListener("click", () => void openUrl("https://creator.xiaohongshu.com/publish/publish"));
    out.appendChild(tip);
  } catch (e) {
    out.textContent = `生成失败:${String(e).slice(0, 140)}`;
  }
  await fitWindow();
}

/// 调本地 CLI 把赛事文档排成赛程节点
async function planMilestones() {
  if (!event) return;
  const hint = $("ev-plan-hint");
  const title = $("h-milestones-title");
  const busy = "正在让本地 CLI 排赛程…";
  hint.textContent = busy;
  $("h-milestones").innerHTML = `<div class="row"><span class="sub">${busy}</span></div>`;
  try {
    const raw = await invoke<string>("plan_hackathon", {
      name: event.name,
      start: event.start,
      end: event.end,
      doc: event.doc ?? "",
    });
    const parsed = JSON.parse(raw) as { milestones?: Milestone[] };
    const list = (parsed.milestones ?? [])
      .filter((m) => m && m.at && m.title)
      .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
    if (!list.length) throw new Error("CLI 没有排出任何节点");
    event.milestones = list;
    store.set("event", event);
    hint.textContent = "";
    if (title) title.classList.remove("err");
    render();
  } catch (e) {
    const msg = String(e);
    hint.textContent = "";
    $("h-milestones").innerHTML = `<div class="row"><span class="sub">排赛程失败:${esc(
      msg.slice(0, 120)
    )}</span></div>`;
    console.error(e);
  }
}

/* ---------- 账号绑定 ---------- */
function updateLoginStatus() {
  const bound = !!store.get<string>("apiKey", "");
  $("s-login-status").textContent = bound ? "已绑定 ✓" : "未绑定";
}

async function githubLogin() {
  const btn = $("s-login") as HTMLButtonElement;
  btn.disabled = true;
  $("s-login-status").textContent = "浏览器中完成 GitHub 授权…";
  try {
    const key = await invoke<string>("github_login", { endpointBase: null });
    store.set("apiKey", key);
    ($("s-apikey") as HTMLInputElement).value = key;
    updateLoginStatus();
    $("s-login-status").textContent = "已绑定 ✓";
    void syncNow(true); // 登录成功立即同步一次
  } catch (e) {
    $("s-login-status").textContent = `${e}`;
  } finally {
    btn.disabled = false;
  }
}

async function showPairCode() {
  const apiKey = store.get<string>("apiKey", "");
  if (!apiKey) {
    $("s-code").textContent = "先登录";
    return;
  }
  const btn = $("s-paircode") as HTMLButtonElement;
  btn.disabled = true;
  $("s-code").textContent = "……";
  try {
    const code = await invoke<string>("request_pair_code", { apiKey, endpointBase: null });
    $("s-code").textContent = code;
    // 同一个码渲染成二维码,小程序端 wx.scanCode 解析 ht-bind: 前缀
    const dataUrl = await QRCode.toDataURL(`ht-bind:${code}`, {
      width: 180,
      margin: 1,
      color: { dark: "#f2eef5", light: "#0a080e" },
    });
    ($("s-qr") as HTMLImageElement).src = dataUrl;
    $("s-qr-row").classList.remove("hidden");
    void fitWindow();
  } catch (e) {
    $("s-code").textContent = "失败";
    console.error(e);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 云端同步 ---------- */
function updateSyncStatus() {
  const last = store.get<string>("lastSyncAt", "");
  $("s-sync-status").textContent = last ? `上次同步 ${new Date(last).toLocaleString()}` : "尚未同步";
}

async function syncNow(silent: boolean) {
  const apiKey = store.get<string>("apiKey", "");
  if (!apiKey) {
    if (!silent) $("s-sync-status").textContent = "请先保存 API Key";
    return;
  }
  const btn = $("s-sync") as HTMLButtonElement;
  btn.disabled = true;
  if (!silent) $("s-sync-status").textContent = "聚合数据并上报中…";
  try {
    await invoke<string>("sync_profile", { apiKey, days: 30, endpoint: null });
    store.set("lastSyncAt", new Date().toISOString());
    store.set("lastSyncDay", new Date().toISOString().slice(0, 10));
    updateSyncStatus();
  } catch (e) {
    $("s-sync-status").textContent = `同步失败:${e}`;
  } finally {
    btn.disabled = false;
  }
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
      showSettings = false;
      render();
    });
  });

  // 网站入口 + 设置
  document.querySelectorAll<HTMLButtonElement>(".tab[data-url]").forEach((b) => {
    b.addEventListener("click", () => void openUrl(b.dataset.url!));
  });
  $("tab-settings").addEventListener("click", () => {
    showSettings = !showSettings;
    render();
  });
  $("s-quit").addEventListener("click", () => void getCurrentWindow().close());
  void invoke<Record<string, string>>("app_meta")
    .then((m) => ($("s-version").textContent = `v${m.version}`))
    .catch(() => {});

  // 账号绑定 + 云端同步
  const keyInput = $("s-apikey") as HTMLInputElement;
  keyInput.value = store.get<string>("apiKey", "");
  updateSyncStatus();
  updateLoginStatus();
  $("s-savekey").addEventListener("click", () => {
    store.set("apiKey", keyInput.value.trim());
    updateLoginStatus(); // 绑定状态行显示结果,同步行保留上次同步时间
    updateSyncStatus();
  });
  ($("s-syncurl") as HTMLInputElement).value = store.get<string>("syncUrl", "");
  ($("s-synctoken") as HTMLInputElement).value = store.get<string>("syncToken", "");
  $("s-savesync").addEventListener("click", () => {
    store.set("syncUrl", ($("s-syncurl") as HTMLInputElement).value.trim());
    store.set("syncToken", ($("s-synctoken") as HTMLInputElement).value.trim());
    ($("s-savesync") as HTMLButtonElement).textContent = "已保存";
    setTimeout(() => (($("s-savesync") as HTMLButtonElement).textContent = "保存"), 1500);
  });
  $("s-login").addEventListener("click", () => void githubLogin());
  $("s-paircode").addEventListener("click", () => void showPairCode());
  $("s-sync").addEventListener("click", () => void syncNow(false));

  // 每天首次启动自动同步一次(已绑定的情况下)
  const today = new Date().toISOString().slice(0, 10);
  if (store.get<string>("apiKey", "") && store.get<string>("lastSyncDay", "") !== today) {
    setTimeout(() => void syncNow(true), 5_000);
  }

  $("summary-btn").addEventListener("click", () => void generateSummary());
  $("ev-save").addEventListener("click", () => void saveEvent());
  $("h-replan").addEventListener("click", () => void planMilestones());
  $("h-ask-go").addEventListener("click", () => void askHackathon());
  $("h-ask").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void askHackathon();
  });
  $("work-toggle").addEventListener("click", () => {
    workOpen = !workOpen;
    $("work-body").classList.toggle("hidden", !workOpen);
    $("work-chev").textContent = workOpen ? "⌄" : "›";
    void fitWindow();
  });
  $("w-submit").addEventListener("click", () => void submitWork());
  $("w-redo").addEventListener("click", () => {
    workDraft = null;
    $("work-form").classList.add("hidden");
    $("work-drop").classList.remove("hidden");
    $("w-status").textContent = "";
    void fitWindow();
  });
  $("w-xhs").addEventListener("click", () => void genXhsCopy());
  void setupWorkDrop();
  $("ev-edit").addEventListener("click", () => {
    if (!event) return;
    ($("ev-name") as HTMLInputElement).value = event.name;
    ($("ev-start") as HTMLInputElement).value = event.start.slice(0, 16);
    ($("ev-end") as HTMLInputElement).value = event.end.slice(0, 16);
    ($("ev-doc") as HTMLTextAreaElement).value = event.doc ?? "";
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
  setInterval(() => checkMilestoneAlerts(), 30_000); // 赛程节点提醒
});
