import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import QRCode from "qrcode";
import { initHaki, setHakiInputs, setHakiPaused } from "./haki";

/* ---------- 类型 ---------- */
interface ProjectToday {
  cwd: string;
  tokens: number;
  edits: number;
  first_ts: string;
  last_ts: string;
}
interface ModelStat {
  model: string;
  tokens: number;
}
interface SourceUsage {
  source: string; // claude | codex | grok | …
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  total: number;
  sessions: number;
  models: ModelStat[];
}
interface UsageToday {
  input: number;
  output: number;
  cache_write: number;
  cache_read: number;
  all: number; // Claude 侧合计(兼容旧字段)
  sessions: number;
  scanned_files: number;
  projects: string[];
  per_project: ProjectToday[];
  models: ModelStat[];
  sources: SourceUsage[];
  /// 今日分时用量:本地时区 24 小时分桶,含全部来源
  hourly?: number[];
}
interface AgentProc {
  agent: string;
  pid: number;
  cwd: string | null;
  project: string | null;
  branch: string | null;
  dirty_files: number;
  insertions: number;
  deletions: number;
}
/// session 条上可开关的字段,顺序即设置里的展示顺序
type FieldKey = "task" | "folder" | "branch" | "diff" | "usage";
const FIELD_LABELS: Record<FieldKey, string> = {
  task: "任务概述",
  folder: "所在文件夹",
  branch: "分支",
  diff: "改动",
  usage: "耗时 · tokens",
};
const DEFAULT_FIELDS: Record<FieldKey, boolean> = {
  task: true,
  folder: true,
  branch: true,
  diff: true,
  usage: true,
};
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
  /// 从主办方文档推断出的提交材料清单(没有文档则用默认三件套)
  checklist?: string[];
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
/* 多来源用量:sources 存在时合并 claude + codex,否则退回旧的 claude-only 字段 */
const SOURCE_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok", gemini: "Gemini" };
const usageTotal = (u: UsageToday): number =>
  u.sources?.length ? u.sources.reduce((s, x) => s + x.total, 0) : u.all;
const usageSessions = (u: UsageToday): number =>
  u.sources?.length ? u.sources.reduce((s, x) => s + x.sessions, 0) : u.sessions;
/** 有多个来源出数时给出 "Claude 63.5M · Codex 1.2M" 的细分,单一来源返回空 */
const usageBreakdown = (u: UsageToday): string => {
  const parts = (u.sources ?? [])
    .filter((s) => s.total > 0)
    .map((s) => `${SOURCE_LABELS[s.source] ?? s.source} ${fmt(s.total)}`);
  return parts.length > 1 ? parts.join(" · ") : "";
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
let showUsage = false;
/// vibe-usage daemon 落盘的额度快照(claude/codex 两家 schema 不同,按原样透传)
let limits: Record<string, any> = {};
const openRows = new Set<string>();
let fields = { ...DEFAULT_FIELDS, ...store.get<Partial<Record<FieldKey, boolean>>>("fields", {}) };
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
/// Haki 舞台条高度。展开态 scrollHeight 已包含 stage,只抬上限,勿再叠加
const STAGE_H = 44;
let lastFitH = 0; // 高度没变就不发 setSize IPC:render 每 15s 跑一次,窗口操作是跨进程调用
async function fitWindow() {
  const h = expanded ? Math.min(document.body.scrollHeight + 12, 620 + STAGE_H) : 64 + STAGE_H;
  if (h === lastFitH) return;
  lastFitH = h;
  await getCurrentWindow().setSize(new LogicalSize(660, h));
}

/* ---------- Haki 输入同步 ---------- */
/// 把 mode/agent 运行态/比赛进度推给小人。"在运行"用 dotState 而非进程存在:
/// 挂着等输入的 CLI 不算干活,confirm/done 时小人闲下来反而是"该我上场"的提醒
function hakiSync() {
  const running = agents.some((a) => dotState(a) === "running");
  let progress: number | null = null;
  if (mode === "hackathon" && event) {
    const s = new Date(event.start).getTime();
    const e = new Date(event.end).getTime();
    progress = e > s ? Math.min(1, Math.max(0, (Date.now() - s) / (e - s))) : 1;
  }
  setHakiInputs({ mode, agentRunning: running, progress });
}

/* ---------- 数据刷新 ---------- */
async function refreshUsage() {
  try {
    usage = await invoke<UsageToday>("usage_today");
    repos = await invoke<RepoToday[]>("dev_today", { paths: usage.projects });
    void refreshRepoCommits();
  } catch (e) {
    console.error(e);
  }
  render();
}

async function refreshLimits() {
  try {
    // gemini 走网络(Google 配额接口,后端缓存 60s),失败不拖累本地快照
    const [rl, gm] = await Promise.all([
      invoke<Record<string, any>>("rate_limits"),
      invoke<any>("gemini_quota").catch(() => null),
    ]);
    limits = rl;
    if (gm) limits.gemini = gm;
  } catch (e) {
    console.error(e);
  }
  render();
}

async function refreshAgents() {
  try {
    agents = await invoke<AgentProc[]>("running_agents");
    const statuses: Record<string, AgentStatus> = {};
    // 以前这里只查 claude,codex 那几行的任务概述才会一直空着
    await Promise.all(
      agents
        .filter((a) => a.cwd)
        .map(async (a) => {
          try {
            statuses[a.cwd!] = await invoke<AgentStatus>("agent_status", {
              cwd: a.cwd,
              agent: a.agent,
            });
          } catch {
            /* 该目录没有会话记录,忽略 */
          }
        })
    );
    agentStatus = statuses;
  } catch (e) {
    console.error(e);
  }
  hakiSync();
  render();
}

/* ---------- 设置:字段开关 ---------- */
function renderFieldToggles() {
  const box = document.getElementById("field-toggles");
  if (!box) return;
  box.innerHTML = (Object.keys(FIELD_LABELS) as FieldKey[])
    .map(
      (k) => `
      <div class="row check-item field-toggle" data-k="${k}">
        <span class="icon ${fields[k] ? "check" : "dots"}">${fields[k] ? "✓" : "⠿"}</span>
        <span class="label ${fields[k] ? "" : "strike"}">${FIELD_LABELS[k]}</span>
      </div>`
    )
    .join("");
  box.querySelectorAll<HTMLElement>(".field-toggle").forEach((el) => {
    el.addEventListener("click", () => {
      const k = el.dataset.k as FieldKey;
      fields[k] = !fields[k];
      store.set("fields", fields);
      renderFieldToggles();
      render();
    });
  });
}

/* ---------- agent logo ---------- */
/* 各模型公司官方 logo(simple-icons 单色矢量路径,24x24 viewBox) */
const BRAND_LOGOS: Record<string, { d: string; color: string; fr?: string }> = {
  openai: { color: "#E8E8E8", d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" },
  claude: { color: "#D97757", d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" },
  gemini: { color: "#7C9CFF", d: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" },
  qwen: { color: "#615CED", d: "M23.919 14.545 20.817 9.17l1.47-2.544a.56.56 0 0 0 0-.566l-1.633-2.83a.57.57 0 0 0-.49-.283h-6.207L12.487.402a.57.57 0 0 0-.49-.284H8.732a.56.56 0 0 0-.49.284L5.139 5.775h-2.94a.56.56 0 0 0-.49.284L.077 8.887a.56.56 0 0 0 0 .567L3.18 14.83l-1.47 2.545a.56.56 0 0 0 0 .566l1.634 2.83a.57.57 0 0 0 .49.283h6.205l1.47 2.545a.57.57 0 0 0 .49.284h3.266a.57.57 0 0 0 .49-.284l3.104-5.375h2.94a.57.57 0 0 0 .49-.283l1.634-2.828a.55.55 0 0 0-.004-.568M8.733.686l1.634 2.828-1.634 2.828H21.8L20.164 9.17H7.425L5.63 6.06Zm1.306 19.801-6.205-.002 1.634-2.83h3.265L2.201 6.344h3.267q3.182 5.517 6.367 11.032zm10.124-5.66L18.53 12l-6.532 11.315-1.634-2.83c2.129-3.673 4.25-7.351 6.373-11.028h3.592l3.102 5.374z" },
  deepseek: { color: "#4D6BFE", d: "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45" },
  kimi: { color: "#E8E8E8", d: "M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441" },
  minimax: { color: "#FF4A59", d: "M11.43 3.92a.86.86 0 1 0-1.718 0v14.236a1.999 1.999 0 0 1-3.997 0V9.022a.86.86 0 1 0-1.718 0v3.87a1.999 1.999 0 0 1-3.997 0V11.49a.57.57 0 0 1 1.139 0v1.404a.86.86 0 0 0 1.719 0V9.022a1.999 1.999 0 0 1 3.997 0v9.134a.86.86 0 0 0 1.719 0V3.92a1.998 1.998 0 1 1 3.996 0v11.788a.57.57 0 1 1-1.139 0zm10.572 3.105a2 2 0 0 0-1.999 1.997v7.63a.86.86 0 0 1-1.718 0V3.923a1.999 1.999 0 0 0-3.997 0v16.16a.86.86 0 0 1-1.719 0V18.08a.57.57 0 1 0-1.138 0v2a1.998 1.998 0 0 0 3.996 0V3.92a.86.86 0 0 1 1.719 0v12.73a1.999 1.999 0 0 0 3.996 0V9.023a.86.86 0 1 1 1.72 0v6.686a.57.57 0 0 0 1.138 0V9.022a2 2 0 0 0-1.998-1.997" },
  mistral: { color: "#FA520F", d: "M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z" },
  copilot: { color: "#E8E8E8", d: "M23.922 16.997C23.061 18.492 18.063 22.02 12 22.02 5.937 22.02.939 18.492.078 16.997A.641.641 0 0 1 0 16.741v-2.869a.883.883 0 0 1 .053-.22c.372-.935 1.347-2.292 2.605-2.656.167-.429.414-1.055.644-1.517a10.098 10.098 0 0 1-.052-1.086c0-1.331.282-2.499 1.132-3.368.397-.406.89-.717 1.474-.952C7.255 2.937 9.248 1.98 11.978 1.98c2.731 0 4.767.957 6.166 2.093.584.235 1.077.546 1.474.952.85.869 1.132 2.037 1.132 3.368 0 .368-.014.733-.052 1.086.23.462.477 1.088.644 1.517 1.258.364 2.233 1.721 2.605 2.656a.841.841 0 0 1 .053.22v2.869a.641.641 0 0 1-.078.256Zm-11.75-5.992h-.344a4.359 4.359 0 0 1-.355.508c-.77.947-1.918 1.492-3.508 1.492-1.725 0-2.989-.359-3.782-1.259a2.137 2.137 0 0 1-.085-.104L4 11.746v6.585c1.435.779 4.514 2.179 8 2.179 3.486 0 6.565-1.4 8-2.179v-6.585l-.098-.104s-.033.045-.085.104c-.793.9-2.057 1.259-3.782 1.259-1.59 0-2.738-.545-3.508-1.492a4.359 4.359 0 0 1-.355-.508Zm2.328 3.25c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm-5 0c.549 0 1 .451 1 1v2c0 .549-.451 1-1 1-.549 0-1-.451-1-1v-2c0-.549.451-1 1-1Zm3.313-6.185c.136 1.057.403 1.913.878 2.497.442.544 1.134.938 2.344.938 1.573 0 2.292-.337 2.657-.751.384-.435.558-1.15.558-2.361 0-1.14-.243-1.847-.705-2.319-.477-.488-1.319-.862-2.824-1.025-1.487-.161-2.192.138-2.533.529-.269.307-.437.808-.438 1.578v.021c0 .265.021.562.063.893Zm-1.626 0c.042-.331.063-.628.063-.894v-.02c-.001-.77-.169-1.271-.438-1.578-.341-.391-1.046-.69-2.533-.529-1.505.163-2.347.537-2.824 1.025-.462.472-.705 1.179-.705 2.319 0 1.211.175 1.926.558 2.361.365.414 1.084.751 2.657.751 1.21 0 1.902-.394 2.344-.938.475-.584.742-1.44.878-2.497Z" },
  cursor: { color: "#E8E8E8", d: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23" },
  trae: { color: "#E8E8E8", d: "M24 20.5H3.5V17H0V3.5h24ZM3.5 17h17V7h-17Zm8.5-5-2.5 2.5L7 12l2.5-2.5Zm7 0-2.5 2.5L14 12l2.5-2.5z" },
  baidu: { color: "#2932E1", d: "M9.154 0C7.71 0 6.54 1.658 6.54 3.707c0 2.051 1.171 3.71 2.615 3.71 1.446 0 2.614-1.659 2.614-3.71C11.768 1.658 10.6 0 9.154 0zm7.025.594C14.86.58 13.347 2.589 13.2 3.927c-.187 1.745.25 3.487 2.179 3.735 1.933.25 3.175-1.806 3.422-3.364.252-1.555-.995-3.364-2.362-3.674a1.218 1.218 0 0 0-.261-.03zM3.582 5.535a2.811 2.811 0 0 0-.156.008c-2.118.19-2.428 3.24-2.428 3.24-.287 1.41.686 4.425 3.297 3.864 2.617-.561 2.262-3.68 2.183-4.362-.125-1.018-1.292-2.773-2.896-2.75zm16.534 1.753c-2.308 0-2.617 2.119-2.617 3.616 0 1.43.121 3.425 2.988 3.362 2.867-.063 2.553-3.238 2.553-3.988 0-.745-.62-2.99-2.924-2.99zm-8.264 2.478c-1.424.014-2.708.925-3.323 1.947-1.118 1.868-2.863 3.05-3.112 3.363-.25.309-3.61 2.116-2.864 5.42.746 3.301 3.365 3.237 3.365 3.237s1.93.19 4.171-.31c2.24-.495 4.17.123 4.17.123s5.233 1.748 6.665-1.616c1.43-3.364-.808-5.109-.808-5.109s-2.99-2.306-4.736-4.798c-1.072-1.665-2.348-2.268-3.528-2.257zm-2.234 3.84l1.542.024v8.197H7.758c-1.47-.291-2.055-1.292-2.13-1.462-.072-.173-.488-.976-.268-2.343.635-2.049 2.447-2.196 2.447-2.196h1.81zm3.964 2.39v3.881c.096.413.612.488.612.488h1.614v-4.343h1.689v5.782h-3.915c-1.517-.39-1.59-1.465-1.59-1.465v-4.317zm-5.458 1.147c-.66.197-.978.708-1.05.928-.076.22-.247.78-.1 1.269.294 1.095 1.248 1.144 1.248 1.144h1.37v-3.34z" },
  windsurf: { color: "#58E5BB", d: "M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z" },
  opencode: { color: "#E8E8E8", d: "M22 24H2V0h20zM17 4.8H7v14.4h10z" },
  zhipu: { color: "#3859FF", d: "M11.991 23.503a.24.24 0 00-.244.248.24.24 0 00.244.249.24.24 0 00.245-.249.24.24 0 00-.22-.247l-.025-.001zM9.671 5.365a1.697 1.697 0 011.099 2.132l-.071.172-.016.04-.018.054c-.07.16-.104.32-.104.498-.035.71.47 1.279 1.186 1.314h.366c1.309.053 2.338 1.173 2.286 2.523-.052 1.332-1.152 2.38-2.478 2.327h-.174c-.715.018-1.274.64-1.239 1.368 0 .124.018.23.053.337.209.373.54.658.96.8.75.23 1.517-.125 1.9-.782l.018-.035c.402-.64 1.17-.96 1.92-.711.854.284 1.378 1.226 1.099 2.167a1.661 1.661 0 01-2.077 1.102 1.711 1.711 0 01-.907-.711l-.017-.035c-.2-.323-.463-.58-.851-.711l-.056-.018a1.646 1.646 0 00-1.954.746 1.66 1.66 0 01-1.065.764 1.677 1.677 0 01-1.989-1.279c-.209-.906.332-1.83 1.257-2.043a1.51 1.51 0 01.296-.035h.018c.68-.071 1.151-.622 1.116-1.333a1.307 1.307 0 00-.227-.693 2.515 2.515 0 01-.366-1.403 2.39 2.39 0 01.366-1.208c.14-.195.21-.444.227-.693.018-.71-.506-1.261-1.186-1.332l-.07-.018a1.43 1.43 0 01-.299-.07l-.05-.019a1.7 1.7 0 01-1.047-2.114 1.68 1.68 0 012.094-1.101zm-5.575 10.11c.26-.264.639-.367.994-.27.355.096.633.379.728.74.095.362-.007.748-.267 1.013-.402.41-1.053.41-1.455 0a1.062 1.062 0 010-1.482zm14.845-.294c.359-.09.738.024.992.297.254.274.344.665.237 1.025-.107.36-.396.634-.756.718-.551.128-1.1-.22-1.23-.781a1.05 1.05 0 01.757-1.26zm-.064-4.39c.314.32.49.753.49 1.206 0 .452-.176.886-.49 1.206-.315.32-.74.5-1.185.5-.444 0-.87-.18-1.184-.5a1.727 1.727 0 010-2.412 1.654 1.654 0 012.369 0zm-11.243.163c.364.484.447 1.128.218 1.691a1.665 1.665 0 01-2.188.923c-.855-.36-1.26-1.358-.907-2.228a1.68 1.68 0 011.33-1.038c.593-.08 1.183.169 1.547.652zm11.545-4.221c.368 0 .708.2.892.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.892.524c-.568 0-1.03-.47-1.03-1.048 0-.579.462-1.048 1.03-1.048zm-14.358 0c.368 0 .707.2.891.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.891.524c-.569 0-1.03-.47-1.03-1.048 0-.579.461-1.048 1.03-1.048zm10.031-1.475c.925 0 1.675.764 1.675 1.706s-.75 1.705-1.675 1.705-1.674-.763-1.674-1.705c0-.942.75-1.706 1.674-1.706zm-2.626-.684c.362-.082.653-.356.761-.718a1.062 1.062 0 00-.238-1.028 1.017 1.017 0 00-.996-.294c-.547.14-.881.7-.752 1.257.13.558.675.907 1.225.783zm0 16.876c.359-.087.644-.36.75-.72a1.062 1.062 0 00-.237-1.019 1.018 1.018 0 00-.985-.301 1.037 1.037 0 00-.762.717c-.108.361-.017.754.239 1.028.245.263.606.377.953.305l.043-.01zM17.19 3.5a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64a.631.631 0 00-.628.64c0 .355.28.64.628.64zm-10.38 0a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64a.631.631 0 00-.628.64c0 .355.279.64.628.64zm-5.182 7.852a.631.631 0 00-.628.64c0 .354.28.639.628.639a.63.63 0 00.627-.606l.001-.034a.62.62 0 00-.628-.64zm5.182 9.13a.631.631 0 00-.628.64c0 .355.279.64.628.64a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm10.38.018a.631.631 0 00-.628.64c0 .355.28.64.628.64a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64zm5.182-9.148a.631.631 0 00-.628.64c0 .354.279.639.628.639a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm-.384-4.992a.24.24 0 00.244-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249c0 .142.122.249.244.249zM11.991.497a.24.24 0 00.245-.248A.24.24 0 0011.99 0a.24.24 0 00-.244.249c0 .133.108.236.223.247l.021.001zM2.011 6.36a.24.24 0 00.245-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249.24.24 0 00.244.249zm0 11.263a.24.24 0 00-.243.248.24.24 0 00.244.249.24.24 0 00.244-.249.252.252 0 00-.244-.248zm19.995-.018a.24.24 0 00-.245.248.24.24 0 00.245.25.24.24 0 00.244-.25.252.252 0 00-.244-.248z", fr: "evenodd" },
  grok: { color: "#E8E8E8", d: "M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815", fr: "evenodd" },
  doubao: { color: "#3C8CFF", d: "M5.31 15.756c.172-3.75 1.883-5.999 2.549-6.739-3.26 2.058-5.425 5.658-6.358 8.308v1.12C1.501 21.513 4.226 24 7.59 24a6.59 6.59 0 002.2-.375c.353-.12.7-.248 1.039-.378.913-.899 1.65-1.91 2.243-2.992-4.877 2.431-7.974.072-7.763-4.5l.002.001z M22.57 10.283c-1.212-.901-4.109-2.404-7.397-2.8.295 3.792.093 8.766-2.1 12.773a12.782 12.782 0 01-2.244 2.992c3.764-1.448 6.746-3.457 8.596-5.219 2.82-2.683 3.353-5.178 3.361-6.66a2.737 2.737 0 00-.216-1.084v-.002zM14.303 1.867C12.955.7 11.248 0 9.39 0 7.532 0 5.883.677 4.545 1.807 2.791 3.29 1.627 5.557 1.5 8.125v9.201c.932-2.65 3.097-6.25 6.357-8.307.5-.318 1.025-.595 1.569-.829 1.883-.801 3.878-.932 5.746-.706-.222-2.83-.718-5.002-.87-5.617h.001z M17.305 4.961a199.47 199.47 0 01-1.08-1.094c-.202-.213-.398-.419-.586-.622l-1.333-1.378c.151.615.648 2.786.869 5.617 3.288.395 6.185 1.898 7.396 2.8-1.306-1.275-3.475-3.487-5.266-5.323z", fr: "evenodd" },
  goose: { color: "#E8E8E8", d: "M21.595 23.61c1.167-.254 2.405-.944 2.405-.944l-2.167-1.784a12.124 12.124 0 01-2.695-3.131 12.127 12.127 0 00-3.97-4.049l-.794-.462a1.115 1.115 0 01-.488-.815.844.844 0 01.154-.575c.413-.582 2.548-3.115 2.94-3.44.503-.416 1.065-.762 1.586-1.159.074-.056.148-.112.221-.17.003-.002.007-.004.009-.007.167-.131.325-.272.45-.438.453-.524.563-.988.59-1.193-.061-.197-.244-.639-.753-1.148.319.02.705.272 1.056.569.235-.376.481-.773.727-1.171.165-.266-.08-.465-.086-.471h-.001V3.22c-.007-.007-.206-.25-.471-.086-.567.35-1.134.702-1.639 1.021 0 0-.597-.012-1.305.599a2.464 2.464 0 00-.438.45l-.007.009c-.058.072-.114.147-.17.221-.397.521-.743 1.083-1.16 1.587-.323.391-2.857 2.526-3.44 2.94a.842.842 0 01-.574.153 1.115 1.115 0 01-.815-.488l-.462-.794a12.123 12.123 0 00-4.049-3.97 12.133 12.133 0 01-3.13-2.695L1.332 0S.643 1.238.39 2.405c.352.428 1.27 1.49 2.34 2.302C1.58 4.167.73 3.75.06 3.4c-.103.765-.063 1.92.043 2.816.726.317 1.961.806 3.219 1.066-1.006.236-2.11.278-2.961.262.15.554.358 1.119.64 1.688.119.263.25.52.39.77.452.125 2.222.383 3.164.171l-2.51.897a27.776 27.776 0 002.544 2.726c2.031-1.092 2.494-1.241 4.018-2.238-2.467 2.008-3.108 2.828-3.8 3.67l-.483.678c-.25.351-.469.725-.65 1.117-.61 1.31-1.47 4.1-1.47 4.1-.154.486.202.842.674.674 0 0 2.79-.861 4.1-1.47.392-.182.766-.4 1.118-.65l.677-.483c.227-.187.453-.37.701-.586 0 0 1.705 2.02 3.458 3.349l.896-2.511c-.211.942.046 2.712.17 3.163.252.142.509.272.772.392.569.28 1.134.49 1.688.64-.016-.853.026-1.956.261-2.962.26 1.258.75 2.493 1.067 3.219.895.106 2.051.146 2.816.043a73.87 73.87 0 01-1.308-2.67c.811 1.07 1.874 1.988 2.302 2.34h-.001z", fr: "evenodd" },
  amp: { color: "#E8E8E8", d: "M15.087 23.18L12.03 24l-2.097-7.823-5.738 5.738-2.251-2.251 5.718-5.719-7.769-2.082.82-3.057 11.294 3.08 3.08 11.295z M19.505 18.762l-3.057.82-2.564-9.573-9.572-2.564.819-3.057 11.295 3.079 3.08 11.295z M23.893 14.374l-3.057.82-2.565-9.572L8.7 3.057 9.52 0l11.295 3.08 3.079 11.294z", fr: "evenodd" },
};

/// agent/模型名 → 品牌 key。先精确匹配 CLI 名,再按子串匹配模型名(如 deepseek-chat、qwen3-coder)。
const BRAND_ALIAS: Record<string, string> = {
  claude: "claude",
  codex: "openai",
  gemini: "gemini",
  opencode: "opencode",
};
const BRAND_KEYWORDS: [string, string][] = [
  ["claude", "claude"], ["anthropic", "claude"],
  ["gpt", "openai"], ["openai", "openai"], ["codex", "openai"],
  ["gemini", "gemini"],
  ["qwen", "qwen"], ["tongyi", "qwen"],
  ["deepseek", "deepseek"],
  ["kimi", "kimi"], ["moonshot", "kimi"],
  ["doubao", "doubao"], ["bytedance", "doubao"],
  ["trae", "trae"],
  ["minimax", "minimax"],
  ["mistral", "mistral"],
  ["copilot", "copilot"],
  ["cursor", "cursor"],
  ["windsurf", "windsurf"],
  ["ernie", "baidu"], ["wenxin", "baidu"], ["baidu", "baidu"],
  ["glm", "zhipu"], ["zhipu", "zhipu"], ["chatglm", "zhipu"],
  ["grok", "grok"], ["xai", "grok"],
  ["goose", "goose"],
  ["amp", "amp"],
];

function brandKey(name: string): string | undefined {
  const low = name.toLowerCase();
  if (BRAND_ALIAS[low]) return BRAND_ALIAS[low];
  const hit = BRAND_KEYWORDS.find(([kw]) => low.includes(kw));
  return hit?.[1];
}

/// 用官方 logo 代替 CLI 名字。没收录的品牌(iFlow/aider 等)退回首字母,不至于空一块。
function agentLogo(agent: string): string {
  const key = brandKey(agent);
  const brand = key ? BRAND_LOGOS[key] : undefined;
  if (!brand) return `<span class="agent-logo letter">${esc(agent.slice(0, 1).toUpperCase())}</span>`;
  return `<svg class="agent-logo" viewBox="0 0 24 24" aria-label="${esc(agent)}"><path fill="${brand.color}"${brand.fr ? ` fill-rule="${brand.fr}" clip-rule="${brand.fr}"` : ""} d="${brand.d}"/></svg>`;
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
  const overlay = showSettings || showUsage;
  $("settings-view").classList.toggle("hidden", !showSettings);
  $("usage-view").classList.toggle("hidden", !showUsage);
  $("daily-view").classList.toggle("hidden", overlay || mode !== "daily");
  $("hackathon-view").classList.toggle("hidden", overlay || mode !== "hackathon");
  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
  // 打开的视图对应按钮高亮,文案变「✕」提示可关闭返回
  $("tab-usage").classList.toggle("active", showUsage);
  $("tab-usage").textContent = showUsage ? "用量 ✕" : "用量";
  $("tab-settings").classList.toggle("active", showSettings);
  $("tab-settings").textContent = showSettings ? "设置 ✕" : "设置";
  if (showUsage) renderUsage();
  if (!overlay) {
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
    $("pill-main").textContent = usage ? `今日 ${fmt(usageTotal(usage))} tokens` : "今日 —";
    const status = $("pill-status");
    const n = agents.length;
    status.textContent = n > 0 ? `${n} 个 agent 运行中` : "无 agent 运行";
    status.className = n > 0 ? "badge green" : "badge";
  }
}

/* ---------- Token 用量视图 ---------- */
/// API 牌价估算(USD/MTok),与 scripts/claude-usage.mjs 同口径;codex 按 GPT-5 档。仅作参考。
const EST_PRICE: Record<string, { i: number; o: number; cw: number; cr: number }> = {
  claude: { i: 15, o: 75, cw: 18.75, cr: 1.5 },
  codex: { i: 1.25, o: 10, cw: 0, cr: 0.125 },
};

interface ProfileStats {
  period_days: number;
  tokens: number;
  output: number;
  sessions: number;
  active_days: number;
  active_minutes: number;
  edits: number;
  models: ModelStat[];
  projects: { name: string; repo?: string | null; tokens: number; active_minutes: number; edits: number }[];
  sources: SourceUsage[];
}

type UsageRange = "today" | "7" | "30" | "90";
let usageRange: UsageRange = "today";
let distTab: "model" | "project" = "model";
/// 7D/30D/90D 聚合结果缓存,切换范围时按需拉取
const profiles: Partial<Record<UsageRange, ProfileStats>> = {};

async function ensureProfile(r: UsageRange) {
  if (r === "today" || profiles[r]) return;
  try {
    profiles[r] = await invoke<ProfileStats>("profile_stats", { days: Number(r) });
  } catch (e) {
    console.error(e);
  }
  render();
}

function estCost(sources: SourceUsage[]): number {
  return sources.reduce((sum, s) => {
    const p = EST_PRICE[s.source] ?? EST_PRICE.claude;
    return sum + (s.input * p.i + s.output * p.o + s.cache_write * p.cw + s.cache_read * p.cr) / 1e6;
  }, 0);
}

function fmtResetAt(ts: number | string | undefined): string {
  if (!ts) return "";
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  if (isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())} 重置`;
}

function fmtMinutes(min: number): string {
  return min >= 60 ? `${Math.floor(min / 60)}h ${Math.round(min % 60)}m` : `${Math.round(min)}m`;
}

function quotaBar(label: string, pct: number | undefined, resetAt: string, note?: string): string {
  if (pct == null)
    return `<div class="qrow"><span class="qwin mono">${label}</span><span class="sub">${note ?? "暂无数据"}</span></div>`;
  const p = Math.round(pct);
  const level = p >= 95 ? "danger" : p >= 80 ? "warn" : "";
  return `<div class="qrow" title="${resetAt}">
    <span class="qwin mono">${label}</span>
    <div class="qbar"><div class="qbar-fill ${level}" style="width:${Math.min(100, p)}%"></div></div>
    <span class="qpct mono ${level}">${p}%</span>
  </div>`;
}

function renderUsage() {
  // ── 额度卡:Claude / Codex 两家 schema 不同,分别取数 ──
  const cl = limits.claude;
  const cx = limits.codex;
  // Gemini:vibeusage 式配额百分比(每模型一条),凭证问题给出可操作的提示
  const gm = limits.gemini;
  const gmBody =
    gm?.status === "ok" && gm.buckets?.length
      ? gm.buckets
          .slice(0, 3)
          .map((b: any) =>
            quotaBar(esc(String(b.model).replace(/^gemini-/, "")), b.utilization, fmtResetAt(b.resetsAt)),
          )
          .join("")
      : quotaBar(
          "1d",
          undefined,
          "",
          gm?.status === "expired"
            ? "凭证已过期,跑一次 gemini 即恢复"
            : gm?.status === "error"
              ? "配额接口请求失败"
              : "未检测到 Gemini CLI 凭证",
        );
  const quotaCards = [
    `<div class="quota-card">
      <div class="qhead"><span class="logo-tile">${agentLogo("codex")}</span><span class="qname">Codex</span>
        ${cx?.resetCreditsCount ? `<span class="badge warn">重置券 ×${cx.resetCreditsCount}</span>` : ""}
        <span class="spacer"></span>
        ${cx?.planLabel ? `<span class="badge mono">${esc(cx.planLabel)}</span>` : ""}</div>
      ${
        cx?.fiveHourNotEnforced
          ? quotaBar("5h", undefined, "", "官方当前未启用")
          : quotaBar("5h", cx?.fiveHour?.utilization, fmtResetAt(cx?.fiveHour?.resetsAt))
      }
      ${quotaBar("7d", cx?.sevenDay?.utilization, fmtResetAt(cx?.sevenDay?.resetsAt))}
    </div>`,
    `<div class="quota-card">
      <div class="qhead"><span class="logo-tile">${agentLogo("claude")}</span><span class="qname">Claude</span>
        <span class="spacer"></span>
        ${cl?.model_id ? `<span class="badge mono">${esc(String(cl.model_id).replace(/^claude-/, ""))}</span>` : ""}</div>
      ${quotaBar("5h", cl?.five_hour?.used_percentage, fmtResetAt(cl?.five_hour?.resets_at))}
      ${quotaBar("7d", cl?.seven_day?.used_percentage, fmtResetAt(cl?.seven_day?.resets_at))}
    </div>`,
    `<div class="quota-card">
      <div class="qhead"><span class="logo-tile">${agentLogo("gemini")}</span><span class="qname">Gemini</span>
        <span class="spacer"></span>
        ${gm?.plan ? `<span class="badge mono">${esc(gm.plan)}</span>` : ""}</div>
      ${gmBody}
    </div>`,
  ];
  // 一次可视 2 家,横向滑动查看更多;重渲染时保住滚动位置
  const qEl = $("u-quota");
  const keepScroll = qEl.scrollLeft;
  qEl.innerHTML = quotaCards.join("");
  qEl.scrollLeft = keepScroll;
  const qPages = Math.max(1, quotaCards.length - 1);
  $("u-quota-pager").classList.toggle("hidden", qPages <= 1);
  const qMax = Math.max(1, qEl.scrollWidth - qEl.clientWidth);
  const qCur = Math.min(qPages - 1, Math.round((qEl.scrollLeft / qMax) * (qPages - 1)));
  $("qp-dots").innerHTML = Array.from({ length: qPages }, (_, i) =>
    `<span class="qp-dot ${i === qCur ? "on" : ""}" data-page="${i}"></span>`).join("");

  // ── 时间范围 ──
  document.querySelectorAll<HTMLButtonElement>("#u-range .range-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.range === usageRange);
  });
  const p = usageRange === "today" ? null : profiles[usageRange];
  const loading = usageRange !== "today" && !p;
  const srcs: SourceUsage[] = usageRange === "today" ? (usage?.sources ?? []) : (p?.sources ?? []);

  // ── 统计卡 ──
  if ((usageRange === "today" && !usage) || loading) {
    $("u-stats").innerHTML = `<div class="row"><span class="sub">统计中…</span></div>`;
  } else {
    const total = usageRange === "today" ? usageTotal(usage!) : (p?.tokens ?? 0);
    const cacheRead = srcs.reduce((s, x) => s + x.cache_read, 0);
    const activeMin =
      usageRange === "today"
        ? usage!.per_project.reduce(
            (s, x) => s + Math.max(0, new Date(x.last_ts).getTime() - new Date(x.first_ts).getTime()) / 60_000,
            0,
          )
        : (p?.active_minutes ?? 0);
    const stat = (label: string, value: string, cls = "") =>
      `<div class="stat-card"><span class="stat-label">${label}</span><span class="stat-value mono ${cls}">${value}</span></div>`;
    $("u-stats").innerHTML = [
      stat("预估费用", `$${estCost(srcs).toFixed(2)}`, "green"),
      stat("总 Token", fmt(total)),
      stat("缓存 Token", fmt(cacheRead)),
      stat("活跃时长", fmtMinutes(activeMin), "blue"),
    ].join("");
  }

  // ── 每小时趋势:今日分时用量柱状图(仅"今天"范围有分时数据) ──
  const hourly = usage?.hourly ?? [];
  const showHourly = usageRange === "today" && hourly.some((v) => v > 0);
  $("u-hourly-card").classList.toggle("hidden", !showHourly);
  if (showHourly) {
    const max = Math.max(...hourly);
    $("u-hourly-max").textContent = `峰值 ${fmt(max)}`;
    $("u-hourly").innerHTML = hourly
      .map(
        (v, h) =>
          `<div class="hbar-wrap" title="${String(h).padStart(2, "0")}:00 · ${fmt(v)} tokens">` +
          `<div class="hbar" style="height:${v ? Math.max(6, Math.round((v / max) * 100)) : 0}%"></div></div>`,
      )
      .join("");
  }

  // ── 用量分布:模型 / 项目 ──
  document.querySelectorAll<HTMLButtonElement>("#u-dist-seg .range-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.dist === distTab);
  });
  let rows: { logo: string; name: string; tokens: number; sub?: string }[] = [];
  if (distTab === "model") {
    rows = srcs
      .flatMap((s) => s.models.map((m) => ({ ...m, source: s.source })))
      .filter((m) => m.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .map((m) => ({
        logo: agentLogo(m.model === "unknown" ? m.source : m.model),
        name: m.model === "unknown" ? (SOURCE_LABELS[m.source] ?? m.source) : m.model,
        tokens: m.tokens,
      }));
  } else if (usageRange === "today") {
    rows = (usage?.per_project ?? [])
      .filter((x) => x.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .map((x) => ({
        logo: `<span class="agent-logo letter">${esc((x.cwd.split("/").pop() ?? "?").slice(0, 1).toUpperCase())}</span>`,
        name: x.cwd.split("/").pop() ?? x.cwd,
        tokens: x.tokens,
      }));
  } else {
    rows = (p?.projects ?? [])
      .filter((x) => x.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens)
      .map((x) => ({
        logo: `<span class="agent-logo letter">${esc(x.name.slice(0, 1).toUpperCase())}</span>`,
        name: x.name,
        tokens: x.tokens,
        sub: fmtMinutes(x.active_minutes),
      }));
  }
  if (loading) {
    $("u-dist").innerHTML = `<div class="row"><span class="sub">统计中…</span></div>`;
  } else if (rows.length === 0) {
    $("u-dist").innerHTML = `<div class="row"><span class="sub">该时段暂无用量</span></div>`;
  } else {
    const max = rows[0].tokens;
    $("u-dist").innerHTML = rows
      .slice(0, 8)
      .map(
        (r) => `<div class="model-row">
          ${r.logo}
          <span class="model-name" title="${esc(r.name)}">${esc(r.name)}</span>
          ${r.sub ? `<span class="model-sub mono">${r.sub}</span>` : ""}
          <div class="qbar slim"><div class="qbar-fill" style="width:${Math.max(2, Math.round((r.tokens / max) * 100))}%"></div></div>
          <span class="qpct mono">${fmt(r.tokens)}</span>
        </div>`,
      )
      .join("");
  }

  // ── 底部:快照时间 ──
  const capturedAt = cl?.captured_at
    ? new Date(cl.captured_at * 1000)
    : cx?.fetchedAt
      ? new Date(cx.fetchedAt)
      : null;
  $("u-sync-dot").className = capturedAt ? "sync-dot ok" : "sync-dot";
  $("u-synced").textContent = capturedAt
    ? `上次同步: ${Math.max(0, Math.round((Date.now() - capturedAt.getTime()) / 60_000))} 分钟前 · 费用为 API 牌价估算`
    : "未检测到 vibe-usage 额度快照,只展示本地统计";
}

function renderDaily() {
  $("d-tokens").textContent = usage
    ? [
        `${fmt(usageTotal(usage))} tokens`,
        usageBreakdown(usage),
        `${usageSessions(usage)} 会话`,
      ]
        .filter(Boolean)
        .join(" · ")
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
        const st = a.cwd ? agentStatus[a.cwd] : undefined;
        const open = openRows.has(key);

        // 主行右侧:改动优先(它比 token 更能说明这个会话干了什么)
        const diffTxt =
          a.dirty_files > 0
            ? `${a.dirty_files} 改动${a.insertions || a.deletions ? ` +${a.insertions}/-${a.deletions}` : ""}`
            : "";
        const usageTxt = p ? `${durationText(p)} · ${fmt(p.tokens)} tokens` : "";
        const right = [fields.diff ? diffTxt : "", fields.usage ? usageTxt : ""]
          .filter(Boolean)
          .join(" · ");

        // 次行:目录 + 分支
        const metaBits: string[] = [];
        if (fields.folder && a.project) metaBits.push(esc(a.project));
        if (fields.branch && a.branch) metaBits.push(`⑂ ${esc(a.branch)}`);
        const metaLine = metaBits.length
          ? `<div class="agent-meta sub mono">${metaBits.join("  ")}</div>`
          : "";

        // 任务概述占主行,这是最该被看到的一条
        const task = fields.task ? st?.last_task?.trim() : "";
        const taskLine = fields.task
          ? `<span class="agent-task ${task ? "" : "muted"}">${esc(task || "暂无任务记录")}</span>`
          : "";

        const detail = open
          ? `<div class="agent-detail">
               <div class="detail-line"><span class="detail-k">完整任务</span>${esc(st?.last_task || "(暂无任务记录)")}</div>
               <div class="detail-line"><span class="detail-k">目录</span><span class="mono">${esc(a.cwd ?? "—")}</span></div>
               <div class="detail-line"><span class="detail-k">分支</span><span class="mono">${esc(a.branch ?? "—")}</span></div>
               <div class="detail-line"><span class="detail-k">状态</span>${DOT_LABEL[state]}</div>
             </div>`
          : "";
        return `
      <div class="agent-row" data-key="${esc(key)}" data-cwd="${esc(a.cwd ?? "")}">
        <div class="row agent-main">
          <span class="dot ${state}"></span>
          ${agentLogo(a.agent)}
          ${taskLine}
          <span class="spacer"></span>
          <span class="sub mono agent-right">${esc(right)}</span>
          <span class="chev-sm">${open ? "⌄" : "›"}</span>
        </div>
        ${metaLine}
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
  $("h-tokens").textContent = usage
    ? `${fmt(usageTotal(usage))} tokens · ${usageSessions(usage)} 会话`
    : "—";
  renderMilestones();
  $("ms-tips").textContent = nm ? `下一步:${nm.title}` : "节点已全部走完";

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

  // 项目进度:优先用手动绑定的仓库,没绑则退回今天 commit 最多的仓库
  const bound = store.get<string>("raceRepo", "");
  const top = repos.find((r) => r.path === bound) ?? repos[0];
  $("h-repo-bind").textContent = bound ? "换绑仓库" : "绑定仓库";
  $("repo-tips").textContent = top
    ? `${top.name} · 今日 ${top.commits_today} 次${top.unpushed ? ` · ${top.unpushed} 未推` : ""}`
    : "绑定仓库后展示真实 commit/push";
  $("h-repo-name").textContent = top ? top.name : "最近 commit";
  if (top && top.last_commit_min !== null) {
    const min = top.last_commit_min;
    $("h-commit").textContent = `${min < 60 ? `${min} 分钟前` : `${Math.floor(min / 60)} 小时前`} · ${esc(top.last_message).slice(0, 24)}`;
    $("h-commit-count").textContent = `今日 ${top.commits_today} 次${top.unpushed ? ` · ${top.unpushed} 未推` : " · 已全部推送"}`;
    const icon = $("h-commit-icon");
    icon.className = min > 45 ? "icon warn" : "icon check";
    icon.textContent = min > 45 ? "!" : "✓";
  } else {
    $("h-commit").textContent = bound ? "该仓库今天暂无 commit" : "暂无记录,可绑定仓库";
    $("h-commit-count").textContent = "—";
  }
  // commit/push 明细列表(需后端 repo_commits 命令,没有则只显示上面的汇总行)
  $("h-commits").innerHTML = repoCommits.length
    ? repoCommits
        .map((c) => {
          const t = new Date(c.ts);
          const pad = (n: number) => String(n).padStart(2, "0");
          return `<div class="commit-row">
            <span class="commit-dot ${c.pushed ? "pushed" : ""}"></span>
            <span class="sub mono">${pad(t.getHours())}:${pad(t.getMinutes())}</span>
            <span class="commit-msg">${esc(c.message)}</span>
            <span class="badge mono ${c.pushed ? "green" : "yellow"}">${c.pushed ? "已推送" : "未推送"}</span>
          </div>`;
        })
        .join("")
    : "";

  renderChecklist();
}

/* ---------- 项目进度:绑定仓库的 commit/push 明细 ---------- */
interface RepoCommit {
  ts: string;
  message: string;
  pushed: boolean;
}
let repoCommits: RepoCommit[] = [];

/// 拉绑定仓库的 commit 明细。后端还没有 repo_commits 命令时静默降级(只显示汇总行)
async function refreshRepoCommits() {
  const bound = store.get<string>("raceRepo", "") || repos[0]?.path;
  if (!bound || mode !== "hackathon" || !event) {
    repoCommits = [];
    return;
  }
  try {
    repoCommits = await invoke<RepoCommit[]>("repo_commits", { path: bound, limit: 8 });
  } catch {
    repoCommits = [];
  }
  if (expanded && mode === "hackathon") render();
}

function renderChecklist() {
  const items = event?.checklist ?? DEFAULT_CHECKLIST;
  const checked = store.get<boolean[]>("checklist", items.map(() => false));
  $("cl-tips").textContent = `已完成 ${checked.filter(Boolean).length}/${items.length}`;
  $("checklist").innerHTML = items.map(
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

function inferChecklist(doc: string): string[] {
  const d = doc.toLowerCase();
  const items: string[] = [];

  // 逐个判断交付物关键词,有就加对应条目(保持"提交 GitHub 仓库 → PPT → Demo"顺序)
  if (/github|仓库|repo|代码|源码|git/.test(d)) items.push("提交 GitHub 代码仓库");
  if (/ppt|路演|答辩|演讲|slides|演示文稿/.test(d)) items.push("路演 PPT 2 分钟准备");
  if (/demo|视频|录屏|展示|demo视频|演示视频/.test(d)) items.push("路演视频 Demo 一份");

  // 文档没提供任何线索 → 默认 3 条
  if (items.length === 0) return [...DEFAULT_CHECKLIST];

  // 补全缺失的默认项(文档可能只提了其中一两个)
  for (const def of DEFAULT_CHECKLIST) {
    if (!items.includes(def)) items.push(def);
  }
  // 保持原始顺序
  return DEFAULT_CHECKLIST.filter((c) => items.includes(c));
}

/// 把用户输入的时间文本解析成 ISO 字符串(本地时区)。支持:
///   「8月25日 18:00」「8.25 18:00」「明天 18:00」「今天 09:00」「18:00」「2026-08-25T18:00」
/// 解析失败返回 null。
function parseDateInput(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;

  // 已经是 ISO 格式(含 T),直接补秒返回
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const now = new Date();
  const hhmm = s.match(/(\d{1,2})[:：](\d{2})/); // 时间
  const h = hhmm ? Number(hhmm[1]) : 0;
  const m = hhmm ? Number(hhmm[2]) : 0;

  let day: Date;
  // 「今天/明天」相对日
  if (/明天/.test(s)) {
    day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  } else if (/今天|现在/.test(s)) {
    day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else {
    // 「M月D日」或「M.D」绝对日
    const md = s.match(/(\d{1,2})月\s*(\d{1,2})日?/) || s.match(/(\d{1,2})\.(\d{1,2})/);
    if (md) {
      const mon = Number(md[1]) - 1;
      const dd = Number(md[2]);
      day = new Date(now.getFullYear(), mon, dd);
    } else if (hhmm) {
      // 只给了时间,默认今天
      day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else {
      return null;
    }
  }

  day.setHours(h, m, 0, 0);
  if (Number.isNaN(day.getTime())) return null;
  return day.toISOString();
}

/// ISO → datetime-local 控件值(本地时区 YYYY-MM-DDTHH:mm),「修改比赛信息」回填用
function toLocalInputValue(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function saveEvent() {
  const name = ($("ev-name") as HTMLInputElement).value.trim();
  const endRaw = ($("ev-end") as HTMLInputElement).value;
  const doc = ($("ev-doc") as HTMLTextAreaElement)?.value.trim() ?? "";

  const end = parseDateInput(endRaw);
  const hint = $("ev-plan-hint");
  if (!name || !end) {
    // WKWebView 的 datetime-local 分段没填完时 .value 为空串(界面上却像填了)
    hint.textContent = !name
      ? "请先填写比赛名称"
      : ($("ev-end") as HTMLInputElement).validity?.badInput
        ? "截止时间没填完整(每一段都要选),或点上面的快捷按钮"
        : "请选择提交截止时间,或点上面的快捷按钮";
    hint.classList.add("hint-error");
    return;
  }
  hint.textContent = "";
  hint.classList.remove("hint-error");

  const checklist = inferChecklist(doc);
  event = { name, start: new Date().toISOString(), end, doc, checklist };
  store.set("event", event);
  store.set("checklist", checklist.map(() => false));
  notifiedMilestones.clear();
  store.set("notified_ms", []);
  hakiSync();
  render();
  await planMilestones();
}

/* ---------- 赛事问答(本地检索,不调大模型) ---------- */

/// FAQ 意图:问题里出现 kw 中的词 → 触发,在文档里找含 search 词的句子
interface FaqIntent {
  kw: string[];
  search: string[];
}
const FAQ_INTENTS: FaqIntent[] = [
  { kw: ["token", "api", "key", "密钥", "额度", "赞助", "领取", "领用", "接入"], search: ["token", "api", "key", "密钥", "额度", "赞助", "领"] },
  { kw: ["提交", "交作品", "截止", "deadline", "上传", "作品"], search: ["提交", "截止", "上传", "作品", "交"] },
  { kw: ["签到", "入场", "地点", "地址", "在哪", "哪里", "现场", "路线"], search: ["签到", "入场", "地点", "地址", "现场", "馆", "楼", "路线"] },
  { kw: ["组队", "报名", "队伍", "队友", "注册"], search: ["组队", "报名", "队伍", "注册"] },
  { kw: ["微信", "联系", "群", "主办", "官方", "客服", "咨询", "二维码"], search: ["微信", "联系", "群", "主办", "客服", "咨询", "二维码"] },
  { kw: ["路演", "演示", "答辩", "评审"], search: ["路演", "演示", "答辩", "评审"] },
  { kw: ["时间", "几点", "什么时候", "日程", "安排"], search: ["时间", "日程", "安排"] },
];

/// 把文档切成句子(按换行/标点)
function splitDocSentences(doc: string): string[] {
  return doc
    .split(/[\n\r;；。!！?？]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/// 判断句子是不是「章节标题噪声」:去掉编号后是很短的短语、且没有句尾标点
/// 例:「4. 交通与入场」「三、参赛须知」→ true;「地点在XX大厦3楼」→ false
function isHeadingNoise(s: string): boolean {
  const body = s.replace(/^\s*[\d一二三四五六七八九十百]+[.、)）:：]\s*/, "").trim();
  if (!body) return true; // 纯编号
  // 剩余很短(<12 字)且无句末标点 → 当作标题,不作为答案返回
  return body.length <= 12 && !/[。！？!?；;]$/.test(s);
}

/// 从文档或节点里抽主办方联系方式(微信/群/电话),兜底话术用
function extractContact(doc: string, milestones: Milestone[]): string | null {
  const pool = splitDocSentences(doc).concat(
    (milestones ?? []).flatMap((m) => [m.title, m.action])
  );
  for (const s of pool) {
    const m = s.match(/(微信|vx|weixin|群|电话|手机|tel|二维码)[:：]?\s*[^\s,，;；。]{2,30}/i);
    if (m) return m[0];
  }
  return null;
}

/// 本地检索:在预埋文档 + 已排节点里找答案。找到返回答案,找不到返回 null。
/// 策略:先意图命中(结构化、快),再按「句子与问题重合度」打分取最优,文档确实没有才兜底。
function searchDocLocally(q: string): string | null {
  const doc = event?.doc ?? "";
  const milestones = event?.milestones ?? [];
  const ql = q.toLowerCase();

  // 文档句子 + 节点文本(标题 + 动作)都作为可检索池
  const docSentences = splitDocSentences(doc);
  const nodeTexts: string[] = milestones.flatMap((m) => [
    `${m.title} ${m.action}`,
    `${m.at} ${m.title}`,
  ]);

  // 过滤掉章节标题类噪声(如「4. 交通与入场」),避免把无头标题当答案返回
  const isClean = (s: string) => !isHeadingNoise(s);

  // 问题里抽出的检索词(去掉停用词、非空)
  const stop = new Set(["请问", "怎么", "如何", "哪里", "在哪", "什么", "多少", "几点", "什么时候", "帮我", "一下", "可以", "能", "不", "我", "我们", "需要", "请", "问", "的", "吗", "呢", "啊", "是", "有", "要", "一下"]);
  const qTokens = [...new Set(
    ql
      .replace(/[，。！？、：:；;,.!?()（）]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !stop.has(w))
  )];

  // 给候选句子打分:命中一个检索词 +1,命中意图检索词额外 +2
  const scoreOf = (s: string): number => {
    const sl = s.toLowerCase();
    if (!isClean(s)) return -1; // 标题噪声直接淘汰
    let score = 0;
    for (const t of qTokens) {
      if (sl.includes(t)) score += 1;
    }
    // 意图命中额外加权
    const hit = FAQ_INTENTS.find((it) => it.kw.some((k) => ql.includes(k)));
    if (hit) {
      for (const sw of hit.search) {
        if (sl.includes(sw.toLowerCase())) score += 2;
      }
    }
    return score;
  };

  // 节点文本(结构化,最相关)优先,其次文档句子
  const pool: { s: string; score: number }[] = [
    ...nodeTexts.map((s) => ({ s, score: scoreOf(s) })),
    ...docSentences.map((s) => ({ s, score: scoreOf(s) })),
  ];

  const best = pool
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  return best?.s ?? null;
}

/// 兜底话术:文档里没写时的统一提示
function fallbackAnswer(): string {
  const contact = extractContact(event?.doc ?? "", event?.milestones ?? []);
  if (contact) {
    return `文档里没写这个。可联系主办方:${contact}`;
  }
  return "文档里没写这个,请咨询主办方(群里 @ 主办方或添加微信)。";
}

/// CLI 问答可用性缓存:"ok" 用过且成功;"missing" 探测过没装;无值则未知(会先试一次)
function cliQaState(): string {
  return store.get<string>("cliQa", "");
}

function guideHtml(): string {
  return `<div class="qa-guide">没装 coding agent CLI,当前用本地文档检索回答。<span class="link" id="qa-goto-settings">安装 CLI 解锁智能问答 →</span></div>`;
}

function bindGuideLink(out: HTMLElement) {
  out.querySelector<HTMLElement>("#qa-goto-settings")?.addEventListener("click", () => {
    showSettings = true;
    showUsage = false;
    renderFieldToggles();
    render();
  });
}

async function askHackathon() {
  if (!event) return;
  const input = $("h-ask") as HTMLInputElement;
  const q = input.value.trim();
  if (!q) return;
  const out = $("h-ask-out");
  out.classList.remove("hidden");

  // 有 claude 在跑必然装了 CLI;标记过 missing 且没看到 CLI 进程就不再白试
  const claudeRunning = agents.some((a) => a.agent === "claude");
  const tryCli = cliQaState() !== "missing" || claudeRunning;

  if (tryCli) {
    out.textContent = "Haki 思考中…";
    await fitWindow();
    try {
      const ans = await invoke<string>("ask_hackathon", {
        question: q,
        name: event.name,
        doc: event.doc ?? "",
        milestones: JSON.stringify(event.milestones ?? []),
      });
      store.set("cliQa", "ok");
      out.textContent = ans;
      input.value = "";
      await fitWindow();
      return;
    } catch (e) {
      // 没装 CLI → 记住,之后直接走本地检索;其他错误(超时/额度)本次也降级
      if (String(e).includes("确认已安装")) store.set("cliQa", "missing");
    }
  }

  // 本地检索兜底:FAQ 意图 + 句子打分,秒回
  const hit = searchDocLocally(q);
  out.innerHTML = `${esc(hit ?? fallbackAnswer())}${cliQaState() === "missing" ? guideHtml() : ""}`;
  bindGuideLink(out);
  input.value = "";
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
  setHakiPaused(next); // 面板展开时小人定格,收起后继续动
  $("pill").classList.toggle("hidden", expanded);
  $("panel").classList.toggle("hidden", !expanded);
  render();
  await fitWindow();
}

/* ---------- 启动 ---------- */
/// 悬浮窗没有 devtools 入口,运行时 JS 错误落到状态徽标上,否则表现就是「按钮点不动」
function surfaceError(msg: string) {
  const s = document.getElementById("pill-status");
  if (s) {
    s.textContent = `JS错误: ${msg.slice(0, 60)}`;
    s.className = "badge red";
  }
  console.error(msg);
}
window.addEventListener("error", (e) => surfaceError(e.message));
window.addEventListener("unhandledrejection", (e) => {
  const r = String((e as PromiseRejectionEvent).reason ?? "");
  // Tauri invoke 的业务失败各自有 catch,这里只兜真正的代码错误
  if (r.includes("TypeError") || r.includes("ReferenceError")) surfaceError(r);
});

window.addEventListener("DOMContentLoaded", () => {
  $("pill").addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest(".badge")) return;
    void setExpanded(true);
  });
  // 展开/收起热区 = 整个品牌区(箭头+logo+标题),不再只有箭头可点
  $("panel-brand").addEventListener("click", () => void setExpanded(false));

  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((b) => {
    b.addEventListener("click", () => {
      mode = b.dataset.mode as Mode;
      store.set("mode", mode);
      showSettings = false;
      showUsage = false;
      hakiSync();
      render();
    });
  });

  // 网站入口 + 设置
  document.querySelectorAll<HTMLButtonElement>(".tab[data-url]").forEach((b) => {
    b.addEventListener("click", () => void openUrl(b.dataset.url!));
  });
  $("tab-settings").addEventListener("click", () => {
    showSettings = !showSettings;
    showUsage = false;
    if (showSettings) renderFieldToggles();
    render();
  });
  $("tab-usage").addEventListener("click", () => {
    showUsage = !showUsage;
    showSettings = false;
    if (showUsage) void refreshLimits();
    render();
  });
  // 额度卡横向滑动:滚动时同步圆点;点圆点平滑滚过去
  const quotaEl = $("u-quota");
  quotaEl.addEventListener("scroll", () => {
    const dots = document.querySelectorAll<HTMLElement>(".qp-dot");
    if (!dots.length) return;
    const max = Math.max(1, quotaEl.scrollWidth - quotaEl.clientWidth);
    const cur = Math.min(dots.length - 1, Math.round((quotaEl.scrollLeft / max) * (dots.length - 1)));
    dots.forEach((d, i) => d.classList.toggle("on", i === cur));
  }, { passive: true });
  $("qp-dots").addEventListener("click", (e) => {
    const dot = (e.target as HTMLElement).closest<HTMLElement>(".qp-dot");
    if (!dot) return;
    const dots = document.querySelectorAll(".qp-dot").length;
    const max = quotaEl.scrollWidth - quotaEl.clientWidth;
    quotaEl.scrollTo({ left: (Number(dot.dataset.page) / Math.max(1, dots - 1)) * max, behavior: "smooth" });
  });
  // 鼠标用户也能按住拖动滑
  let qDrag: { x: number; left: number } | null = null;
  quotaEl.addEventListener("pointerdown", (e) => { qDrag = { x: e.clientX, left: quotaEl.scrollLeft }; });
  window.addEventListener("pointermove", (e) => { if (qDrag) quotaEl.scrollLeft = qDrag.left - (e.clientX - qDrag.x); });
  window.addEventListener("pointerup", () => { qDrag = null; });
  $("u-refresh").addEventListener("click", () => {
    void refreshLimits();
    void refreshUsage();
    if (usageRange !== "today") {
      delete profiles[usageRange];
      void ensureProfile(usageRange);
    }
  });
  document.querySelectorAll<HTMLButtonElement>("#u-range .range-btn").forEach((b) => {
    b.addEventListener("click", () => {
      usageRange = b.dataset.range as UsageRange;
      void ensureProfile(usageRange);
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("#u-dist-seg .range-btn").forEach((b) => {
    b.addEventListener("click", () => {
      distTab = b.dataset.dist as "model" | "project";
      render();
    });
  });
  renderFieldToggles();
  // 设置页:CLI 检测状态(Rust 侧 available_clis 探测安装,进程列表判断运行中)
  const updateCliStatus = async () => {
    const has = (n: string) => agents.some((a) => a.agent === n);
    let installed: string[] = [];
    try {
      installed = await invoke<string[]>("available_clis");
    } catch {
      /* 旧后端没有该命令,退回进程判断 */
    }
    const label = (n: string) => (has(n) ? "运行中 ✓" : installed.includes(n) ? "已安装 ✓" : "未检测到");
    $("s-cli-claude").textContent = label("claude");
    $("s-cli-codex").textContent = label("codex");
    $("s-cli-gemini").textContent = label("gemini");
  };
  updateCliStatus();
  setInterval(updateCliStatus, 15_000);
  $("tab-settings").addEventListener("click", updateCliStatus); // 打开设置即时刷新
  document.querySelectorAll<HTMLButtonElement>("[data-open-url]").forEach((b) => {
    b.addEventListener("click", () => void openUrl(b.dataset.openUrl!));
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
  // 截止时间快捷按钮:点一下填好选择器(今晚=23:59,其余当天 18:00)
  document.querySelectorAll<HTMLButtonElement>("#ev-end-quick .chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      const days = Number(btn.dataset.days ?? 0);
      const d = new Date();
      d.setDate(d.getDate() + days);
      if (days === 0) d.setHours(23, 59, 0, 0);
      else d.setHours(18, 0, 0, 0);
      ($("ev-end") as HTMLInputElement).value = toLocalInputValue(d.toISOString());
      document.querySelectorAll<HTMLButtonElement>("#ev-end-quick .chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });
  // 比赛面板模块排序:按住 ⋮⋮ 上下拖动。纯 pointer 事件驱动,只在拖动瞬间工作,无常驻开销
  const MOD_DEFAULT = ["qa", "ms", "cl", "work", "repo"];
  const modBlocks = () =>
    [...document.querySelectorAll<HTMLElement>("#event-live [data-key]")];
  const applyModOrder = () => {
    const order = store.get<string[]>("modOrder", MOD_DEFAULT);
    const blocks = modBlocks();
    const anchor = blocks[0]?.parentElement?.querySelector("#ev-edit")?.closest(".row") ?? null;
    const parent = blocks[0]?.parentElement;
    if (!parent) return;
    for (const key of order) {
      const b = blocks.find((x) => x.dataset.key === key);
      if (b) parent.insertBefore(b, anchor);
    }
  };
  applyModOrder();
  document.querySelectorAll<HTMLElement>(".mod-drag").forEach((handle) => {
    handle.addEventListener("click", (e) => e.stopPropagation()); // 把手不触发折叠
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const block = handle.closest<HTMLElement>("[data-key]")!;
      block.classList.add("mod-dragging");
      const move = (ev: PointerEvent) => {
        // 越过相邻块中线即交换位置,DOM 操作次数极少
        for (const other of modBlocks()) {
          if (other === block) continue;
          const r = other.getBoundingClientRect();
          const mid = r.top + r.height / 2;
          const br = block.getBoundingClientRect();
          if (br.top > r.top && ev.clientY < mid) {
            other.parentElement!.insertBefore(block, other);
            break;
          }
          if (br.top < r.top && ev.clientY > mid) {
            other.parentElement!.insertBefore(block, other.nextSibling);
            break;
          }
        }
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        block.classList.remove("mod-dragging");
        store.set("modOrder", modBlocks().map((b) => b.dataset.key!)); // 记住新顺序
        void fitWindow();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  });

  // 比赛面板模块折叠:icon 标题 tips,点开看完整功能,开合状态记住
  const modOpen = store.get<Record<string, boolean>>("modOpen", {});
  document.querySelectorAll<HTMLElement>(".toggle-head[data-mod]").forEach((head) => {
    const key = head.dataset.mod!;
    const apply = () => {
      const open = !!modOpen[key];
      $(`${key}-body`).classList.toggle("hidden", !open);
      $(`${key}-chev`).textContent = open ? "⌄" : "›";
    };
    apply();
    head.addEventListener("click", () => {
      modOpen[key] = !modOpen[key];
      store.set("modOpen", modOpen);
      apply();
      void fitWindow();
    });
  });
  $("h-replan").addEventListener("click", () => void planMilestones());
  // 项目进度:绑定/换绑仓库
  $("h-repo-bind").addEventListener("click", () => {
    const box = $("h-repo-bindbox");
    const opening = box.classList.contains("hidden");
    if (opening) {
      const bound = store.get<string>("raceRepo", "");
      const sel = $("h-repo-select") as HTMLSelectElement;
      sel.innerHTML = repos.length
        ? repos.map((r) => `<option value="${esc(r.path)}" ${r.path === bound ? "selected" : ""}>${esc(r.name)}</option>`).join("")
        : `<option value="">今天还没有检测到开发中的仓库</option>`;
    }
    box.classList.toggle("hidden", !opening);
    void fitWindow();
  });
  $("h-repo-save").addEventListener("click", () => {
    const v = ($("h-repo-select") as HTMLSelectElement).value;
    if (v) store.set("raceRepo", v);
    $("h-repo-bindbox").classList.add("hidden");
    void refreshRepoCommits();
    render();
  });
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
    ($("ev-end") as HTMLInputElement).value = toLocalInputValue(event.end);
    ($("ev-doc") as HTMLTextAreaElement).value = event.doc ?? "";
    event = null;
    render();
  });
  $("ev-finish").addEventListener("click", () => {
    event = null;
    store.del("event");
    mode = "daily";
    store.set("mode", mode);
    hakiSync();
    render();
  });

  initHaki();
  hakiSync();
  void setExpanded(false);
  void refreshUsage();
  void refreshAgents();
  void refreshLimits();
  setInterval(() => void refreshUsage(), 60_000); // 用量/仓库:每分钟
  setInterval(() => void refreshLimits(), 300_000); // 额度快照:每 5 分钟
  setInterval(() => void refreshAgents(), 15_000); // agent 进程:每 15 秒
  setInterval(() => void nightlyCheck(), 60_000); // 22:00 每日总结提醒
  setInterval(() => {
    if (mode === "hackathon" && event) {
      renderPill();
      hakiSync(); // 每秒推最新 progress,小人位置钉住倒计时
    }
    if (expanded && mode === "hackathon" && event) $("h-countdown").textContent = countdownText() ?? "已截止";
  }, 1000); // 倒计时每秒走
  setInterval(() => checkMilestoneAlerts(), 30_000); // 赛程节点提醒
});
