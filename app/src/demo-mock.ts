/* 浏览器可交互演示的 Mock IPC 层。
 * 在 main.ts 之前执行(demo.ts 的 import 顺序保证),把 Tauri invoke 全部
 * 换成演示数据——真实 UI、假数据,零后端依赖,可嵌入官网。
 * 注意:仅 demo.html 引用,正式应用(index.html)完全不经过这里。 */

const now = Date.now();
const H = 3600_000;
const iso = (t: number) => new Date(t).toISOString();

/* ---------- 演示数据 ---------- */
const hourly = [0, 0, 0, 0, 0, 0, 0, 0, 3.2, 12.5, 28.4, 41.2, 55.6, 52.1, 38.9, 44.3, 31.7, 18.2, 9.4, 14.8, 22.1, 17.6, 8.3, 2.1].map(
  (v) => Math.round(v * 1e6),
);

const usageToday = {
  input: 3200000,
  output: 2380000,
  cache_write: 18400000,
  cache_read: 243400000,
  all: 238000000,
  sessions: 12,
  scanned_files: 87,
  projects: ["/Users/demo/haki-desktop", "/Users/demo/hackertrip-miniprogram", "/Users/demo/inflow-x"],
  per_project: [
    { cwd: "/Users/demo/haki-desktop", tokens: 148200000, edits: 210, first_ts: iso(now - 9 * H), last_ts: iso(now - 5 * 60000) },
    { cwd: "/Users/demo/hackertrip-miniprogram", tokens: 62100000, edits: 96, first_ts: iso(now - 7 * H), last_ts: iso(now - 40 * 60000) },
    { cwd: "/Users/demo/inflow-x", tokens: 57100000, edits: 61, first_ts: iso(now - 5 * H), last_ts: iso(now - 2 * H) },
  ],
  models: [],
  hourly,
  sources: [
    {
      source: "claude", input: 2100000, output: 1480000, cache_write: 18400000, cache_read: 216000000, total: 238000000, sessions: 9,
      models: [
        { model: "claude-fable-5", tokens: 186200000 },
        { model: "claude-sonnet-5", tokens: 39500000 },
        { model: "claude-haiku-4-5", tokens: 12300000 },
      ],
    },
    {
      source: "codex", input: 1100000, output: 900000, cache_write: 0, cache_read: 27400000, total: 29400000, sessions: 3,
      models: [{ model: "gpt-5.2-codex", tokens: 29400000 }],
    },
  ],
};

const profileOf = (days: number) => ({
  period_days: days,
  tokens: 238000000 * Math.min(days, 14) * 0.6,
  output: 2380000 * days,
  sessions: 12 * Math.min(days, 14),
  active_days: Math.min(days, 11),
  active_minutes: 540 * Math.min(days, 11),
  edits: 210 * Math.min(days, 11),
  skills: [],
  models: [],
  projects: [
    { name: "haki-desktop", repo: "github.com/Jayden72Huang/haki-desktop", tokens: 148200000 * Math.min(days, 9), active_minutes: 320 * Math.min(days, 9), edits: 150 },
    { name: "hackertrip-miniprogram", repo: "github.com/Jayden72Huang/hackertrip", tokens: 62100000 * Math.min(days, 9), active_minutes: 180 * Math.min(days, 9), edits: 80 },
  ],
  sources: usageToday.sources,
});

const rateLimits = {
  claude: {
    five_hour: { used_percentage: 36, resets_at: (now + 2.4 * H) / 1000 },
    seven_day: { used_percentage: 20, resets_at: (now + 70 * H) / 1000 },
    model_id: "claude-fable-5",
    captured_at: (now - 3 * 60000) / 1000,
  },
  codex: {
    planLabel: "Prolite",
    resetCreditsCount: 1,
    fiveHourNotEnforced: true,
    sevenDay: { utilization: 87, resetsAt: iso(now + 96 * H), windowDuration: 604800 },
    fetchedAt: iso(now - 3 * 60000),
  },
};

const providers = [
  { id: "zhipu", name: "智谱 GLM", base_url: "https://open.bigmodel.cn/api/anthropic", target_cli: "claude", key_url: "https://open.bigmodel.cn", model: "glm-4.7", note: "", sponsored: true, sponsor_note: "AdventureX 2026 参赛选手专属:凭参赛码到 2 楼签到台领取 API Key" },
  { id: "kimi", name: "Kimi (Moonshot)", base_url: "https://api.moonshot.cn/anthropic", target_cli: "claude", key_url: "https://platform.moonshot.cn", model: "kimi-k2", note: "支持 Anthropic 兼容端点", sponsored: false, sponsor_note: "" },
  { id: "deepseek", name: "DeepSeek", base_url: "https://api.deepseek.com/anthropic", target_cli: "claude", key_url: "https://platform.deepseek.com", model: "deepseek-chat", note: "性价比高,适合跑量", sponsored: false, sponsor_note: "" },
  { id: "qwen", name: "通义 Qwen", base_url: "https://dashscope.aliyuncs.com", target_cli: "claude", key_url: "https://bailian.console.aliyun.com", model: "qwen3-coder", note: "阿里云百炼领取", sponsored: false, sponsor_note: "" },
];
let demoProvider: { cli: string; base_url: string | null; provider_id: string | null; name: string | null } = {
  cli: "claude", base_url: null, provider_id: null, name: null,
};

const repoCommits = [
  { ts: iso(now - 8 * 60000), message: "feat: 赛事问答本地检索秒回", pushed: false },
  { ts: iso(now - 42 * 60000), message: "feat: 项目进度绑定真实 commit/push", pushed: true },
  { ts: iso(now - 95 * 60000), message: "fix: 额度卡滑动保留位置", pushed: true },
  { ts: iso(now - 3 * H), message: "feat: Token 一键接入向导", pushed: true },
];

const askAnswers: [RegExp, string][] = [
  [/token|key|领/i, "赞助商 Token 在 2 楼签到台领取,报队伍编号找工作人员激活;领到后在设置 → 赞助商 Token 接入里一键写入 CLI。"],
  [/提交|作品|交/, "作品在 8月24日 18:00 前提交到 hackertrip.space/submit,需要 GitHub 仓库链接 + 3 分钟 Demo 视频;比赛面板的「交作品」模块可以拖文件夹自动提取。"],
];

/* ---------- Mock invoke ---------- */
function mockInvoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "usage_today": return Promise.resolve(usageToday);
    case "profile_stats": return Promise.resolve(profileOf(Number(args?.days ?? 7)));
    case "rate_limits": return Promise.resolve(rateLimits);
    case "gemini_quota": return Promise.resolve({ status: "ok", buckets: [
      { model: "gemini-3-pro", utilization: 24, resetsAt: iso(now + 20 * H) },
      { model: "gemini-3-flash", utilization: 7, resetsAt: iso(now + 20 * H) },
    ]});
    case "running_agents": return Promise.resolve([
      { agent: "claude", pid: 4021, cwd: "/Users/demo/haki-desktop", project: "haki-desktop", branch: "feat/race-mode", dirty_files: 4, insertions: 1118, deletions: 7 },
      { agent: "codex", pid: 4188, cwd: "/Users/demo/inflow-x", project: "inflow-x", branch: "main", dirty_files: 2, insertions: 233, deletions: 41 },
    ]);
    case "agent_status": return Promise.resolve({ status: "running", last_task: "实现赛事问答 CLI 智能路由", last_ts: iso(now) });
    case "dev_today": return Promise.resolve([
      { path: "/Users/demo/haki-desktop", name: "haki-desktop", commits_today: 5, unpushed: 1, last_commit_min: 8, last_message: "feat: 赛事问答本地检索秒回" },
      { path: "/Users/demo/inflow-x", name: "inflow-x", commits_today: 2, unpushed: 0, last_commit_min: 95, last_message: "fix: 渲染抖动" },
    ]);
    case "repo_commits": return Promise.resolve(repoCommits);
    case "available_clis": return Promise.resolve(["claude", "codex", "gemini"]);
    case "provider_profiles": return Promise.resolve(providers);
    case "current_provider": return Promise.resolve({ ...demoProvider, cli: String(args?.cli ?? "claude") });
    case "apply_provider": {
      const p = providers.find((x) => x.id === args?.providerId);
      demoProvider = { cli: String(args?.cli ?? "claude"), base_url: p?.base_url ?? null, provider_id: p?.id ?? null, name: p?.name ?? null };
      return Promise.resolve(`已接入 ${p?.name ?? "供应商"}(演示环境,未写入任何真实配置;备份 settings.json.haki-bak-demo)`);
    }
    case "restore_provider":
      demoProvider = { cli: String(args?.cli ?? "claude"), base_url: null, provider_id: null, name: null };
      return Promise.resolve("已还原官方配置(演示环境)");
    case "ask_hackathon": {
      const q = String(args?.question ?? "");
      const hit = askAnswers.find(([re]) => re.test(q));
      return new Promise((r) => setTimeout(() => r(hit ? hit[1] : "文档里没写这个,建议在赛事群里 @ 主办方确认;也可以把主办方文档贴进比赛设置,我就能直接答了。"), 900));
    }
    case "fetch_event_doc":
      return new Promise((r) => setTimeout(() => r("AdventureX 2026 参赛须知:赞助商 Token 领取:2 楼签到台。作品提交:hackertrip.space/submit,截止 8月24日 18:00,需 GitHub 仓库 + 3 分钟 Demo 视频。路演每队 2 分钟。"), 700));
    case "app_meta": return Promise.resolve({ version: "0.1.0-demo" });
    case "sync_profile": return Promise.resolve('{"ok":true}');
    default:
      // 打开外链等插件调用:opener 转成浏览器新标签,其余静默放行
      if (cmd === "plugin:opener|open_url" && args?.url) {
        window.open(String(args.url), "_blank", "noopener");
        return Promise.resolve(null);
      }
      return Promise.resolve(null);
  }
}

(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
  metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main", windowLabel: "main" } },
  transformCallback: () => 0,
  invoke: mockInvoke,
};

/* ---------- 演示环境预置 ---------- */
try {
  localStorage.setItem("event", JSON.stringify({
    name: "AdventureX 2026",
    start: iso(now - 6 * H),
    end: iso(now + 8 * H),
    doc: "赞助商 Token 领取:2 楼签到台,报队伍编号找工作人员。作品提交:hackertrip.space/submit,截止 8月24日 18:00,需 GitHub 仓库 + 3 分钟 Demo 视频。路演每队 2 分钟,评审看完成度与创意。",
    checklist: ["线上 demo 可访问", "README 补齐运行说明", "演示视频 ≤ 3 分钟", "完成平台提交"],
    milestones: [
      { at: iso(now - 4 * H), title: "完成立项与组队确认", action: "锁定一句话方案,写进 README", critical: false },
      { at: iso(now + 1 * H), title: "核心功能可跑通", action: "主流程端到端演示一遍", critical: false },
      { at: iso(now + 5 * H), title: "提交材料准备", action: "录 Demo 视频 + 整理仓库 README", critical: true },
      { at: iso(now + 8 * H), title: "提交截止", action: "平台上传作品,确认提交成功", critical: true },
    ],
  }));
  localStorage.setItem("checklist", JSON.stringify([true, true, false, false]));
  if (!localStorage.getItem("mode")) localStorage.setItem("mode", JSON.stringify("daily"));
  localStorage.removeItem("cliQa");
} catch { /* 隐私模式等场景下静默 */ }

/* ---------- 演示页外观:窗口居中 + 提示条 ---------- */
document.addEventListener("DOMContentLoaded", () => {
  const style = document.createElement("style");
  style.textContent = `
    body { width: 660px; margin: 0 auto; padding-top: 18px;
      background: radial-gradient(90% 60% at 80% -10%, rgba(139,79,232,.25), transparent 60%), #0a0710 !important; }
    .demo-hint { position: fixed; left: 50%; transform: translateX(-50%); bottom: 12px; z-index: 99;
      font: 12px/1.6 ui-monospace, monospace; color: #948e9e; background: rgba(16,12,24,.9);
      border: 1px solid rgba(139,79,232,.35); border-radius: 999px; padding: 6px 18px; white-space: nowrap; }
    .demo-hint b { color: #cbb2f7; font-weight: 500; }
  `;
  document.head.appendChild(style);
  const hint = document.createElement("div");
  hint.className = "demo-hint";
  hint.innerHTML = "🎮 可交互演示 · 数据为演示数据 · 点胶囊展开 → 试试 <b>用量</b> / <b>比赛</b> / <b>设置里的 Token 接入</b>";
  document.body.appendChild(hint);
});

export {};
