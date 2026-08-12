#!/usr/bin/env node
/**
 * 解析 ~/.claude/projects 下的会话日志(jsonl),统计真实 token 用量。
 * 输出:总量、按天、按模型、按项目的聚合,以及会话数/活跃天数。
 *
 * 用法:
 *   node claude-usage.mjs [--days 30] [--json 输出路径]
 */
import { readdirSync, statSync, createReadStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const getArg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const DAYS = Number(getArg("days", 30));
const JSON_OUT = getArg("json", null);

const ROOT = join(homedir(), ".claude", "projects");
const cutoff = Date.now() - DAYS * 24 * 3600 * 1000;

// API 牌价估算(USD / MTok)。未知模型按 opus 档估。仅作参考,不作计费依据。
const PRICING = {
  opus: { in: 15, out: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  sonnet: { in: 3, out: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { in: 1, out: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};
const priceFor = (model) => {
  const m = (model || "").toLowerCase();
  if (m.includes("haiku")) return PRICING.haiku;
  if (m.includes("sonnet")) return PRICING.sonnet;
  return PRICING.opus; // opus / fable / 未知,按最高档估
};

// 收集所有 jsonl 文件(按 mtime 过滤,老文件跳过,加速扫描)
const files = [];
for (const dir of readdirSync(ROOT)) {
  const dirPath = join(ROOT, dir);
  let entries;
  try {
    entries = readdirSync(dirPath);
  } catch {
    continue; // 不是目录
  }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const p = join(dirPath, f);
    const st = statSync(p);
    if (st.mtimeMs >= cutoff) files.push({ path: p, project: dir, size: st.size });
  }
}

const day = (ts) => ts.slice(0, 10);
const emptyTok = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 });
const add = (agg, u, model) => {
  const price = priceFor(model);
  agg.input += u.input_tokens || 0;
  agg.output += u.output_tokens || 0;
  agg.cacheWrite += u.cache_creation_input_tokens || 0;
  agg.cacheRead += u.cache_read_input_tokens || 0;
  agg.cost +=
    ((u.input_tokens || 0) * price.in +
      (u.output_tokens || 0) * price.out +
      (u.cache_creation_input_tokens || 0) * price.cacheWrite +
      (u.cache_read_input_tokens || 0) * price.cacheRead) /
    1e6;
};

const total = emptyTok();
const byDay = new Map();
const byModel = new Map();
const byProject = new Map();
const sessions = new Set();
const activeMinutes = new Set(); // "日期T小时:分" 粒度估算活跃时长
const seen = new Set(); // 去重:同一 message.id + requestId 会因流式写入重复出现

async function parseFile({ path, project }) {
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"usage"')) continue; // 快速跳过无用行
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "assistant" || !obj.message?.usage) continue;
    const ts = obj.timestamp;
    if (!ts || new Date(ts).getTime() < cutoff) continue;
    const dedupKey = `${obj.message.id || ""}:${obj.requestId || obj.uuid}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const u = obj.message.usage;
    const model = obj.message.model || "unknown";
    add(total, u, model);

    const d = day(ts);
    if (!byDay.has(d)) byDay.set(d, emptyTok());
    add(byDay.get(d), u, model);
    if (!byModel.has(model)) byModel.set(model, emptyTok());
    add(byModel.get(model), u, model);
    if (!byProject.has(project)) byProject.set(project, emptyTok());
    add(byProject.get(project), u, model);

    if (obj.sessionId) sessions.add(obj.sessionId);
    activeMinutes.add(ts.slice(0, 16));
  }
}

console.error(`扫描 ${files.length} 个会话文件(近 ${DAYS} 天有更新)...`);
for (const f of files) await parseFile(f);

const sum = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;
const fmt = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);

const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
const today = new Date().toISOString().slice(0, 10);
const result = {
  generatedAt: new Date().toISOString(),
  rangeDays: DAYS,
  totals: {
    ...total,
    allTokens: sum(total),
    sessions: sessions.size,
    activeDays: byDay.size,
    activeHours: Math.round((activeMinutes.size / 60) * 10) / 10,
    estCostUSD: Math.round(total.cost * 100) / 100,
  },
  today: byDay.get(today) ? { ...byDay.get(today), allTokens: sum(byDay.get(today)) } : null,
  byDay: days.map(([d, t]) => ({ date: d, ...t, allTokens: sum(t) })),
  byModel: [...byModel.entries()]
    .sort((a, b) => sum(b[1]) - sum(a[1]))
    .map(([m, t]) => ({ model: m, ...t, allTokens: sum(t) })),
  topProjects: [...byProject.entries()]
    .sort((a, b) => sum(b[1]) - sum(a[1]))
    .slice(0, 10)
    .map(([p, t]) => ({ project: p, ...t, allTokens: sum(t) })),
};

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(result, null, 2));
  console.error(`已写入 ${JSON_OUT}`);
}

console.log(`\n=== 近 ${DAYS} 天 Claude Code 用量(真实数据)===`);
console.log(`总 Token:     ${fmt(result.totals.allTokens)}(输出 ${fmt(total.output)} / 缓存读 ${fmt(total.cacheRead)})`);
console.log(`预估费用:     $${result.totals.estCostUSD}(按 API 牌价估算)`);
console.log(`会话数:       ${result.totals.sessions}`);
console.log(`活跃:         ${result.totals.activeDays} 天 / 约 ${result.totals.activeHours} 小时`);
if (result.today) console.log(`今天:         ${fmt(result.today.allTokens)} tokens`);
console.log(`\n按模型:`);
for (const m of result.byModel.slice(0, 6)) console.log(`  ${m.model.padEnd(32)} ${fmt(m.allTokens).padStart(8)}  (输出 ${fmt(m.output)})`);
console.log(`\nToken 消耗前 5 的项目:`);
for (const p of result.topProjects.slice(0, 5)) console.log(`  ${p.project.slice(0, 56).padEnd(58)} ${fmt(p.allTokens).padStart(8)}`);
console.log(`\n最近 14 天趋势:`);
const recent = result.byDay.slice(-14);
const max = Math.max(...recent.map((d) => d.allTokens), 1);
for (const d of recent) {
  const bar = "█".repeat(Math.max(1, Math.round((d.allTokens / max) * 40)));
  console.log(`  ${d.date}  ${bar} ${fmt(d.allTokens)}`);
}
