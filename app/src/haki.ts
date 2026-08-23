/* ---------- Haki 像素小人 ----------
 * 站在显示栏顶部 stage 条上的吉祥物,动画思路移植自 lil-agents:
 * 预渲染的 sprite 循环播放,代码只负责位移,用梯形速度曲线让脚步节奏与位移对齐。
 *
 * 状态映射:
 *   daily    + agent 运行 → push   来回推箱子
 *   daily    + 空闲       → switch 原地玩 Switch
 *   hackathon+ agent 运行 → code   桌前敲代码(位置=倒计时进度)
 *   hackathon+ 空闲       → sleep  睡觉(位置=倒计时进度)
 */
import pushUrl from "./assets/haki/push.png";
import switchUrl from "./assets/haki/switch.png";
import codeUrl from "./assets/haki/code.png";
import sleepUrl from "./assets/haki/sleep.png";

export type HakiState = "push" | "switch" | "code" | "sleep";

export interface HakiInputs {
  mode: "daily" | "hackathon";
  agentRunning: boolean;
  /** 比赛倒计时进度 0..1;非比赛模式或无赛事时为 null */
  progress: number | null;
}

interface AnimDef {
  url: string;
  frames: number;
  fps: number;
  fw: number; // 显示宽 px
  fh: number; // 显示高 px
  /** 仅 push:走多少像素切一帧,让脚步与位移物理对齐 */
  pxPerFrame?: number;
  /** 素材帧内角色不居中时的翻转补偿(lil-agents 的 flipXOffset) */
  flipXOffset?: number;
}

const ANIMS: Record<HakiState, AnimDef> = {
  push: { url: pushUrl, frames: 4, fps: 8, fw: 40, fh: 40, pxPerFrame: 5 },
  switch: { url: switchUrl, frames: 4, fps: 3, fw: 40, fh: 40 },
  code: { url: codeUrl, frames: 4, fps: 5, fw: 64, fh: 40 },
  sleep: { url: sleepUrl, frames: 4, fps: 1.2, fw: 40, fh: 40 },
};

const STAGE_W = 660;
const EDGE_PAD = 12;
const SPEED = 28; // px/s 巡航速度
const WALK_MIN = 0.35, WALK_MAX = 0.65; // 单次行走距离占可行走宽度比例
const PAUSE_MIN = 5000, PAUSE_MAX = 12000; // 走完随机歇 5~12s
const IDLE_CONFIRM_POLLS = 2; // 干活→闲需连续 2 次轮询(≈30s)确认,防 15s 轮询抖动

/* 梯形速度曲线(移植 lil-agents movementPosition):
 * 前 A 段匀加速(½at²)、中段匀速、末 D 段匀减速;输入时间进度 p∈[0,1],
 * 输出归一化位移 ∈[0,1],峰值速度 V 由总面积=1 归一化得出 */
const A = 0.3, D = 0.3;
const V = 1 / (1 - (A + D) / 2);
function trapezoid(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (p <= A) return (V * p * p) / (2 * A);
  if (p <= 1 - D) return (V * A) / 2 + V * (p - A);
  const q = 1 - p;
  return 1 - (V * q * q) / (2 * D);
}

/* ---------- 内部状态 ---------- */
let el: HTMLElement;
let state: HakiState = "switch";
let inputs: HakiInputs = { mode: "daily", agentRunning: false, progress: null };
let forced: Partial<HakiInputs> | null = null; // __haki.force 调试用
let idleStreak = 0; // 连续几次轮询看到"空闲"
let smoothedRunning = false; // 滞回后的 agentRunning

let x = EDGE_PAD; // 小人左边缘 px
let dir: 1 | -1 = 1; // 1 朝右
let frame = 0;
let frameClock = 0; // 秒,fps 型动画的帧计时
let walkedPx = 0; // push 状态累计位移,驱动步频
let lastTs = 0;

type Walk = { fromX: number; dist: number; dur: number; t0: number } | null;
let walk: Walk = null;
let pauseUntil = 0;

const usable = (s: HakiState) => STAGE_W - ANIMS[s].fw - 2 * EDGE_PAD;

/* ---------- 状态机 ---------- */
function resolveState(i: HakiInputs): HakiState {
  if (i.mode === "hackathon" && i.progress != null) return i.agentRunning ? "code" : "sleep";
  return i.agentRunning ? "push" : "switch";
}

function applyState(next: HakiState) {
  if (next === state) return;
  state = next;
  frame = 0;
  frameClock = 0;
  walk = null; // 中断当前行走计划
  pauseUntil = 0;
  if (state === "code" || state === "sleep") dir = 1; // 场景型动画固定朝右
  const a = ANIMS[state];
  el.style.width = `${a.fw}px`;
  el.style.height = `${a.fh}px`;
  el.style.backgroundImage = `url(${a.url})`;
  el.style.backgroundSize = `${a.fw * a.frames}px ${a.fh}px`;
  x = Math.min(x, EDGE_PAD + usable(state)); // 换宽帧后防越界
  paint();
  schedule(0); // 状态切换即时生效,取消可能长达数秒的休眠定时器
}

/* ---------- push:走-停调度(移植 lil-agents startWalk) ---------- */
function planWalk(now: number) {
  const u = usable("push");
  const posP = (x - EDGE_PAD) / u;
  dir = posP > 0.85 ? -1 : posP < 0.15 ? 1 : Math.random() < 0.5 ? -1 : 1;
  let dist = (WALK_MIN + Math.random() * (WALK_MAX - WALK_MIN)) * u;
  // 夹到边界内
  dist = dir > 0 ? Math.min(dist, EDGE_PAD + u - x) : Math.min(dist, x - EDGE_PAD);
  if (dist < 20) {
    dir = -dir as 1 | -1; // 距离太短说明贴边了,掉头
    dist = dir > 0 ? Math.min(dist + 80, EDGE_PAD + u - x) : Math.min(dist + 80, x - EDGE_PAD);
  }
  walk = { fromX: x, dist, dur: (dist / SPEED) * 1000 * V, t0: now };
}

/* ---------- 帧调度 ----------
 * 素材只有 1.2~8fps,60fps 常驻 rAF 是纯浪费:只在 push 行走段用 rAF 保平滑,
 * 其余按素材帧率 setTimeout 唤醒,行走间歇直接睡到 pauseUntil。
 * 空闲态 CPU 唤醒从 60/s 降到 1.2~5/s */
let pending: number | "raf" | null = null; // 在途的下一帧(timer id 或 raf 标记)

function schedule(delayMs: number) {
  if (pending === "raf") return; // rAF 已在途,最快路径已排上
  if (typeof pending === "number") clearTimeout(pending);
  if (delayMs <= 16) {
    pending = "raf";
    requestAnimationFrame(tick);
  } else {
    pending = window.setTimeout(() => {
      pending = "raf";
      requestAnimationFrame(tick);
    }, delayMs);
  }
}

/// 面板展开时暂停动画(定格当前帧),避免与内容渲染抢帧造成卡顿
let animPaused = false;
export function setHakiPaused(p: boolean) {
  if (animPaused === p) return;
  animPaused = p;
  if (typeof pending === "number") {
    clearTimeout(pending);
    pending = null;
  }
  if (!p) {
    lastTs = 0; // 恢复时重置时钟,防止大 dt 跳帧
    schedule(0);
  }
}

/* ---------- 每帧更新 ---------- */
function tick(ts: number) {
  pending = null;
  if (animPaused) return; // 暂停:不推进也不再排下一帧,定格在当前画面
  const dt = lastTs ? Math.min(ts - lastTs, 2000) : 16; // 低频唤醒 dt 可到秒级,夹住防极端跳变
  lastTs = ts;
  const a = ANIMS[state];

  if (state === "push") {
    if (walk) {
      const p = (ts - walk.t0) / walk.dur;
      const nx = walk.fromX + dir * walk.dist * trapezoid(p);
      walkedPx += Math.abs(nx - x);
      x = nx;
      frame = Math.floor(walkedPx / (a.pxPerFrame ?? 5)) % a.frames; // 步频跟位移走
      if (p >= 1) {
        walk = null;
        frame = 0;
        pauseUntil = ts + PAUSE_MIN + Math.random() * (PAUSE_MAX - PAUSE_MIN);
      }
    } else if (ts >= pauseUntil) {
      planWalk(ts);
    }
  } else {
    // fps 型动画(switch/code/sleep)
    frameClock += dt / 1000;
    frame = Math.floor(frameClock * a.fps) % a.frames;
    if (state === "code" || state === "sleep") {
      // 位置钉住倒计时进度,指数缓动跟随(时间常数 1.5s)
      const prog = (forced?.progress ?? inputs.progress) ?? 0;
      const targetX = EDGE_PAD + prog * usable(state);
      x += (targetX - x) * (1 - Math.exp(-dt / 1500));
    }
  }
  paint();
  // push 行走段满帧保平滑;间歇睡到 pauseUntil;fps 型按素材帧率唤醒
  if (state === "push") schedule(walk ? 0 : Math.max(60, pauseUntil - ts));
  else schedule(1000 / a.fps);
}

let lastPaint = ""; // 帧没变就不碰 style,避免无谓的样式重算
function paint() {
  const a = ANIMS[state];
  const key = `${state}|${x.toFixed(1)}|${dir}|${frame}`;
  if (key === lastPaint) return;
  lastPaint = key;
  el.style.transform = `translateX(${x.toFixed(1)}px) scaleX(${dir})`;
  el.style.backgroundPositionX = `${-frame * a.fw}px`;
}

/* ---------- 对外 API ---------- */
export function setHakiInputs(i: HakiInputs) {
  // 滞回:闲→干活立即生效,干活→闲需连续 IDLE_CONFIRM_POLLS 次确认
  if (i.agentRunning) {
    idleStreak = 0;
    smoothedRunning = true;
  } else if (smoothedRunning && ++idleStreak >= IDLE_CONFIRM_POLLS) {
    smoothedRunning = false;
  }
  inputs = { ...i, agentRunning: smoothedRunning };
  if (!forced) applyState(resolveState(inputs));
}

export function initHaki() {
  el = document.getElementById("haki")!;
  // 初始状态立即上妆(applyState 对相同状态短路,这里手动补一次)
  const a = ANIMS[state];
  el.style.width = `${a.fw}px`;
  el.style.height = `${a.fh}px`;
  el.style.backgroundImage = `url(${a.url})`;
  el.style.backgroundSize = `${a.fw * a.frames}px ${a.fh}px`;
  paint();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      lastTs = 0; // 回前台重置时钟
      schedule(0);
    }
  });
  schedule(0);
  // devtools 调试:__haki.force({mode,agentRunning,progress}) 锁定输入,force() 恢复
  (window as unknown as Record<string, unknown>).__haki = {
    force: (f?: Partial<HakiInputs>) => {
      forced = f ?? null;
      if (forced) applyState(resolveState({ ...inputs, ...forced } as HakiInputs));
      else applyState(resolveState(inputs));
    },
    state: () => ({ state, x, dir, inputs, smoothedRunning }),
  };
}
