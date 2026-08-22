use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, SystemTime};

/// 单个项目的今日数据
#[derive(Serialize, Default, Clone)]
pub struct ProjectToday {
    pub cwd: String,
    pub tokens: u64,
    /// 代码改动次数(Edit/Write 等工具调用数)
    pub edits: u32,
    pub first_ts: String,
    pub last_ts: String,
}

/// 今日 Claude Code 用量(解析 ~/.claude/projects 下最近有更新的会话日志)
#[derive(Serialize, Default)]
pub struct UsageToday {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub all: u64,
    pub sessions: usize,
    pub scanned_files: usize,
    /// 今日出现过的项目工作目录(来自日志里的 cwd 字段)
    pub projects: Vec<String>,
    pub per_project: Vec<ProjectToday>,
    /// Claude 侧按模型细分(经 router 跑的 deepseek/kimi 等也在这里,按 model 字段区分)
    pub models: Vec<ModelStat>,
    /// 各数据来源(claude / codex)的用量,前端据此展示多 CLI 合计
    pub sources: Vec<SourceUsage>,
}

const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];

fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

fn codex_sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("sessions"))
}

/// 递归找出 mtime 在 cutoff 之后的 .jsonl。
/// Claude 的 subagent 日志在 <项目>/<会话id>/subagents/ 第三层,
/// Codex 的在 sessions/YYYY/MM/DD/ 下,都必须递归才扫得全。
fn jsonl_files_since(root: &PathBuf, cutoff: SystemTime) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.extension().is_some_and(|e| e == "jsonl")
                && entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .map(|t| t >= cutoff)
                    .unwrap_or(false)
            {
                out.push(path);
            }
        }
    }
    out
}

/// 单一数据来源(claude / codex / …)的用量,按模型细分
#[derive(Serialize, Default, Clone)]
pub struct SourceUsage {
    pub source: String,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub total: u64,
    pub sessions: usize,
    pub models: Vec<ModelStat>,
}

fn models_sorted(m: HashMap<String, u64>) -> Vec<ModelStat> {
    let mut v: Vec<ModelStat> = m
        .into_iter()
        .map(|(model, tokens)| ModelStat { model, tokens })
        .collect();
    v.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    v
}

/// Codex 用量:解析 ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl。
/// 计算方法与 vibeusage/ccusage 同口径:累加每条 token_count 事件的
/// last_token_usage(单次增量),绝不能累加 total_token_usage(会话累计值)。
/// 模型名来自最近一条 turn_context 事件(token_count 本身不带模型)。
fn collect_codex_usage(since_ts: &str, mtime_cutoff: SystemTime) -> SourceUsage {
    let mut su = SourceUsage {
        source: "codex".into(),
        ..Default::default()
    };
    let Some(root) = codex_sessions_dir() else {
        return su;
    };
    if !root.is_dir() {
        return su;
    }
    let mut models: HashMap<String, u64> = HashMap::new();
    let mut sessions: HashSet<PathBuf> = HashSet::new();
    // resume 会把历史事件重放进新 rollout 文件,按 时间戳+累计值 全局去重
    let mut seen: HashSet<String> = HashSet::new();
    for path in jsonl_files_since(&root, mtime_cutoff) {
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        let mut current_model = String::from("gpt-unknown");
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let is_turn = line.contains("\"turn_context\"");
            if !is_turn && !line.contains("\"token_count\"") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if is_turn && v["type"] == "turn_context" {
                if let Some(m) = v["payload"]["model"].as_str() {
                    current_model = m.to_string();
                }
                continue;
            }
            if v["type"] != "event_msg" || v["payload"]["type"] != "token_count" {
                continue;
            }
            let ts = v["timestamp"].as_str().unwrap_or("");
            if ts < since_ts {
                continue;
            }
            let info = &v["payload"]["info"];
            let Some(last) = info["last_token_usage"].as_object() else {
                continue;
            };
            let cum = info["total_token_usage"]["total_tokens"]
                .as_u64()
                .unwrap_or(0);
            if !seen.insert(format!("{ts}:{cum}")) {
                continue;
            }
            let g = |k: &str| last.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            // codex 的 input_tokens 含缓存命中,拆开成与 Claude 一致的口径
            let cached = g("cached_input_tokens");
            let input = g("input_tokens").saturating_sub(cached);
            let output = g("output_tokens");
            let cache_write = g("cache_write_input_tokens");
            su.input += input;
            su.output += output;
            su.cache_read += cached;
            su.cache_write += cache_write;
            *models.entry(current_model.clone()).or_insert(0) +=
                input + output + cached + cache_write;
            sessions.insert(path.clone());
        }
    }
    su.total = su.input + su.output + su.cache_write + su.cache_read;
    su.sessions = sessions.len();
    su.models = models_sorted(models);
    su
}

fn grok_sessions_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".grok").join("sessions"))
}

/// Grok CLI 用量:~/.grok/sessions/<url编码的项目路径>/<会话id>/updates.jsonl。
/// 每次用户 prompt 结束会落一条 turn_completed 事件,usage 是该轮整个
/// agentic 循环的增量(实测多轮数值不递增,非累计值),modelUsage 按模型细分。
/// 事件时间戳是 unix 秒;按 prompt_id 全局去重防 resume 重放。
fn collect_grok_usage(since_epoch: i64, mtime_cutoff: SystemTime) -> SourceUsage {
    let mut su = SourceUsage {
        source: "grok".into(),
        ..Default::default()
    };
    let Some(root) = grok_sessions_dir() else {
        return su;
    };
    if !root.is_dir() {
        return su;
    }
    let mut models: HashMap<String, u64> = HashMap::new();
    let mut sessions: HashSet<PathBuf> = HashSet::new();
    let mut seen: HashSet<String> = HashSet::new();
    for path in jsonl_files_since(&root, mtime_cutoff) {
        // chat_history.jsonl 等文件会把 turn_completed 内嵌进消息文本,只认 updates.jsonl
        if path.file_name().is_none_or(|n| n != "updates.jsonl") {
            continue;
        }
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if !line.contains("turn_completed") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let update = &v["params"]["update"];
            if update["sessionUpdate"] != "turn_completed" {
                continue;
            }
            let ts = v["timestamp"].as_i64().unwrap_or(0);
            if ts < since_epoch {
                continue;
            }
            let key = update["prompt_id"]
                .as_str()
                .map(String::from)
                .unwrap_or_else(|| format!("{}:{ts}", path.display()));
            if !seen.insert(key) {
                continue;
            }
            let usage = &update["usage"];
            // 优先 modelUsage 按模型分账,没有就整轮记到 grok-unknown
            let per_model: Vec<(String, &serde_json::Value)> = match usage["modelUsage"].as_object()
            {
                Some(m) if !m.is_empty() => m.iter().map(|(k, v)| (k.clone(), v)).collect(),
                _ => vec![("grok-unknown".to_string(), usage)],
            };
            for (model, mu) in per_model {
                let g = |k: &str| mu[k].as_u64().unwrap_or(0);
                // grok 的 inputTokens 含缓存命中,拆开成与 Claude 一致的口径
                let cached = g("cachedReadTokens");
                let input = g("inputTokens").saturating_sub(cached);
                let output = g("outputTokens");
                let cache_write = g("cacheCreationTokens");
                su.input += input;
                su.output += output;
                su.cache_read += cached;
                su.cache_write += cache_write;
                *models.entry(model).or_insert(0) += input + output + cached + cache_write;
            }
            if let Some(dir) = path.parent() {
                sessions.insert(dir.to_path_buf());
            }
        }
    }
    su.total = su.input + su.output + su.cache_write + su.cache_read;
    su.sessions = sessions.len();
    su.models = models_sorted(models);
    su
}

/// 本地时区今天零点的 unix 秒(grok 日志用 epoch 时间戳)
fn local_today_start_epoch() -> i64 {
    use chrono::TimeZone;
    let midnight = chrono::Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("00:00:00 恒为合法时间");
    chrono::Local
        .from_local_datetime(&midnight)
        .single()
        .map(|dt| dt.timestamp())
        .unwrap_or(0)
}

/// 本地时区今天零点对应的 UTC 时间串(日志时间戳是 UTC ISO,前缀可比较)
/// 与 dev_today 里 git --since=midnight 的本地口径保持一致
fn local_today_start_utc() -> String {
    use chrono::TimeZone;
    let midnight = chrono::Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("00:00:00 恒为合法时间");
    chrono::Local
        .from_local_datetime(&midnight)
        .single()
        .map(|dt| {
            dt.with_timezone(&chrono::Utc)
                .format("%Y-%m-%dT%H:%M:%S")
                .to_string()
        })
        .unwrap_or_else(|| chrono::Utc::now().format("%Y-%m-%dT00:00:00").to_string())
}

#[tauri::command]
fn usage_today() -> Result<UsageToday, String> {
    let root = claude_projects_dir().ok_or("找不到用户目录")?;
    let today_start = local_today_start_utc();
    // 只扫最近 48h 内有写入的文件,今日数据必然在其中
    let cutoff = SystemTime::now() - Duration::from_secs(48 * 3600);

    let mut result = UsageToday::default();
    let mut sessions: HashSet<String> = HashSet::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut projects: HashSet<String> = HashSet::new();
    let mut per_project: HashMap<String, ProjectToday> = HashMap::new();
    let mut models: HashMap<String, u64> = HashMap::new();

    for path in jsonl_files_since(&root, cutoff) {
        result.scanned_files += 1;
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if !line.contains("\"usage\"") {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if v["type"] != "assistant" {
                continue;
            }
            let ts = v["timestamp"].as_str().unwrap_or("");
            if ts < today_start.as_str() {
                continue;
            }
            let Some(usage) = v["message"]["usage"].as_object() else {
                continue;
            };
            // 流式写入会让同一条消息重复出现,按 message.id + requestId 去重
            let key = format!(
                "{}:{}",
                v["message"]["id"].as_str().unwrap_or(""),
                v["requestId"]
                    .as_str()
                    .unwrap_or_else(|| v["uuid"].as_str().unwrap_or(""))
            );
            if !seen.insert(key) {
                continue;
            }
            let g = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            let line_tokens = g("input_tokens")
                + g("output_tokens")
                + g("cache_creation_input_tokens")
                + g("cache_read_input_tokens");
            result.input += g("input_tokens");
            result.output += g("output_tokens");
            result.cache_write += g("cache_creation_input_tokens");
            result.cache_read += g("cache_read_input_tokens");
            if let Some(model) = v["message"]["model"].as_str() {
                if model != "<synthetic>" {
                    *models.entry(model.to_string()).or_insert(0) += line_tokens;
                }
            }
            if let Some(sid) = v["sessionId"].as_str() {
                sessions.insert(sid.to_string());
            }
            if let Some(cwd) = v["cwd"].as_str() {
                if !cwd.is_empty() {
                    projects.insert(cwd.to_string());
                    let p = per_project
                        .entry(cwd.to_string())
                        .or_insert_with(|| ProjectToday {
                            cwd: cwd.to_string(),
                            first_ts: ts.to_string(),
                            last_ts: ts.to_string(),
                            ..Default::default()
                        });
                    p.tokens += line_tokens;
                    if ts < p.first_ts.as_str() {
                        p.first_ts = ts.to_string();
                    }
                    if ts > p.last_ts.as_str() {
                        p.last_ts = ts.to_string();
                    }
                    if let Some(content) = v["message"]["content"].as_array() {
                        for item in content {
                            if item["type"] == "tool_use"
                                && item["name"]
                                    .as_str()
                                    .is_some_and(|n| EDIT_TOOLS.contains(&n))
                            {
                                p.edits += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    result.all = result.input + result.output + result.cache_write + result.cache_read;
    result.sessions = sessions.len();
    result.projects = projects.into_iter().collect();
    let mut pp: Vec<ProjectToday> = per_project.into_values().collect();
    pp.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    result.per_project = pp;
    result.models = models_sorted(models);

    let claude_source = SourceUsage {
        source: "claude".into(),
        input: result.input,
        output: result.output,
        cache_write: result.cache_write,
        cache_read: result.cache_read,
        total: result.all,
        sessions: result.sessions,
        models: result.models.clone(),
    };
    let codex_source = collect_codex_usage(&today_start, cutoff);
    let grok_source = collect_grok_usage(local_today_start_epoch(), cutoff);
    result.sources = vec![claude_source, codex_source, grok_source];
    Ok(result)
}

/// coding agent 当前会话状态(读取该项目最新会话日志的尾部)
#[derive(Serialize)]
pub struct AgentStatus {
    /// running | needs_input | done
    pub status: String,
    /// 正在执行/最近一次的任务(最后一条用户指令)
    pub last_task: String,
    pub last_ts: String,
}

fn encode_project_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn codex_home() -> Option<PathBuf> {
    std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codex")))
}

/// codex 会往对话里以 role=user 注入一堆系统内容(插件清单、AGENTS.md、历史回放),
/// 直接拿来当「任务」会显示成一坨配置文本,这里按开头特征剔掉。
const CODEX_NOISE_PREFIXES: &[&str] = &[
    "the following is the codex agent history",
    "# agents.md instructions",
    "<",
    "you are codex",
    "recommended_plugins",
];

/// 取会话的首条真实用户指令。
///
/// 取首条而不是末条:首条是这个会话被派去做什么(任务概述),末条往往是
/// 中途的追问或系统回放,单独看不知所云。只扫开头 400 行,足够越过注入内容。
fn codex_first_user_msg(path: &std::path::Path) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    for line in BufReader::new(f).lines().map_while(Result::ok).take(400) {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let payload = &v["payload"];
        let t = if v["type"] == "response_item" && payload["role"] == "user" {
            payload["content"]
                .as_array()
                .and_then(|arr| {
                    arr.iter()
                        .find(|i| i["type"] == "input_text" || i["type"] == "text")
                })
                .and_then(|i| i["text"].as_str())
                .unwrap_or("")
        } else if v["type"] == "event_msg" && payload["type"] == "user_message" {
            payload["message"].as_str().unwrap_or("")
        } else {
            continue;
        };
        let t = t.trim();
        if t.is_empty() {
            continue;
        }
        let low = t.to_lowercase();
        if CODEX_NOISE_PREFIXES.iter().any(|p| low.starts_with(p)) {
            continue;
        }
        // 多行指令只取首行,session 条是单行展示
        let first_line = t.lines().find(|l| !l.trim().is_empty())?.trim();
        return Some(first_line.chars().take(180).collect());
    }
    None
}

/// codex 的会话记录不在 ~/.claude 下,所以之前 codex 那几行状态永远是空的。
///
/// rollout 文件首行就是 session_meta,里面带 cwd,所以只读首行就能判断这个会话
/// 属于哪个目录 —— 1000+ 个历史会话全读一遍是不可接受的。任务概述优先取
/// session_index.jsonl 里的 thread_name,没有再回退到首条用户指令。
fn codex_status(cwd: &str) -> Result<AgentStatus, String> {
    let home = codex_home().ok_or("找不到 CODEX_HOME")?;
    let sessions = home.join("sessions");

    // 收集 rollout 文件 + mtime。目录层级是 sessions/YYYY/MM/DD/
    let mut files: Vec<(PathBuf, SystemTime)> = Vec::new();
    let mut stack = vec![sessions];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "jsonl") {
                let m = e
                    .metadata()
                    .and_then(|m| m.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                files.push((p, m));
            }
        }
    }
    if files.is_empty() {
        return Err("没有 codex 会话记录".into());
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));

    // 只在最近 300 个会话里找,再旧的即使匹配也不是「当前正在跑的那个」
    let mut hit: Option<(String, SystemTime, PathBuf)> = None;
    for (path, mtime) in files.iter().take(300) {
        let Ok(f) = fs::File::open(path) else {
            continue;
        };
        let mut first = String::new();
        if BufReader::new(f).read_line(&mut first).is_err() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&first) else {
            continue;
        };
        if v["type"] != "session_meta" {
            continue;
        }
        if v["payload"]["cwd"].as_str() != Some(cwd) {
            continue;
        }
        let sid = v["payload"]["session_id"]
            .as_str()
            .or_else(|| v["payload"]["id"].as_str())
            .unwrap_or("")
            .to_string();
        hit = Some((sid, *mtime, path.clone()));
        break;
    }
    let (sid, mtime, path) = hit.ok_or("该目录暂无 codex 会话记录")?;

    let idle_secs = SystemTime::now()
        .duration_since(mtime)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // codex 的会话标题就是最贴切的「当前任务」
    let mut last_task = String::new();
    if !sid.is_empty() {
        if let Ok(f) = fs::File::open(home.join("session_index.jsonl")) {
            for line in BufReader::new(f).lines().map_while(Result::ok) {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if v["id"].as_str() == Some(sid.as_str()) {
                    last_task = v["thread_name"].as_str().unwrap_or("").to_string();
                    break;
                }
            }
        }
    }

    // 正在跑的会话往往还没有 thread_name(codex 是事后才给会话起标题的),
    // 而那恰恰是最需要显示任务的行,所以回退到最后一条真实用户指令。
    if last_task.trim().is_empty() {
        last_task = codex_first_user_msg(&path).unwrap_or_default();
    }

    // codex 没有 claude 那种「等确认」的显式标记,只按空闲时长判活跃
    let status = if idle_secs < 20 { "running" } else { "done" };
    Ok(AgentStatus {
        status: status.to_string(),
        last_task,
        last_ts: String::new(),
    })
}

#[tauri::command]
fn agent_status(cwd: String, agent: Option<String>) -> Result<AgentStatus, String> {
    use std::io::{Read, Seek, SeekFrom};

    if agent.as_deref() == Some("codex") {
        return codex_status(&cwd);
    }

    let root = claude_projects_dir().ok_or("找不到用户目录")?;
    let dir = root.join(encode_project_dir(&cwd));
    let mut latest: Option<(PathBuf, SystemTime)> = None;
    for e in fs::read_dir(&dir)
        .map_err(|_| "该项目暂无会话记录")?
        .flatten()
    {
        let p = e.path();
        if p.extension().is_none_or(|x| x != "jsonl") {
            continue;
        }
        let m = e
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        if latest.as_ref().map(|(_, lm)| m > *lm).unwrap_or(true) {
            latest = Some((p, m));
        }
    }
    let (path, mtime) = latest.ok_or("该项目暂无会话记录")?;
    let idle_secs = SystemTime::now()
        .duration_since(mtime)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    // 只读文件尾部 256KB,足够覆盖最近的对话
    let mut f = fs::File::open(&path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    let start = len.saturating_sub(256 * 1024);
    f.seek(SeekFrom::Start(start)).map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    f.read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw);
    let lines: Vec<&str> = text.lines().skip(if start > 0 { 1 } else { 0 }).collect();

    // 收集主对话轨道的 user/assistant 消息(排除子agent与元信息)
    let mut entries: Vec<serde_json::Value> = Vec::new();
    for line in &lines {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let t = v["type"].as_str().unwrap_or("");
        if (t == "user" || t == "assistant")
            && !v["isSidechain"].as_bool().unwrap_or(false)
            && !v["isMeta"].as_bool().unwrap_or(false)
        {
            entries.push(v);
        }
    }

    // 状态判定:20 秒内有写入=运行中;空闲且最后是带工具调用的 assistant=等确认;否则=完成
    let status = if idle_secs < 20 {
        "running"
    } else if entries.last().is_some_and(|last| {
        last["type"] == "assistant"
            && last["message"]["content"]
                .as_array()
                .is_some_and(|c| c.iter().any(|i| i["type"] == "tool_use"))
    }) {
        "needs_input"
    } else {
        "done"
    };

    // 最后一条真实用户指令作为「当前任务」
    let mut last_task = String::new();
    for v in entries.iter().rev() {
        if v["type"] != "user" {
            continue;
        }
        let content = &v["message"]["content"];
        let text = if let Some(s) = content.as_str() {
            s.to_string()
        } else if let Some(arr) = content.as_array() {
            arr.iter()
                .find(|i| i["type"] == "text")
                .and_then(|i| i["text"].as_str())
                .unwrap_or("")
                .to_string()
        } else {
            String::new()
        };
        let text = text.trim();
        if text.is_empty() || text.starts_with('<') {
            continue; // 跳过命令包装与工具结果
        }
        last_task = text.chars().take(180).collect();
        break;
    }

    let last_ts = entries
        .last()
        .and_then(|v| v["timestamp"].as_str())
        .unwrap_or("")
        .to_string();

    Ok(AgentStatus {
        status: status.to_string(),
        last_task,
        last_ts,
    })
}

/// 正在运行的 coding agent 进程
#[derive(Serialize)]
pub struct AgentProc {
    pub agent: String,
    pub pid: u32,
    pub cwd: Option<String>,
    pub project: Option<String>,
    /// 当前分支,detached HEAD 或非 git 目录为 None
    pub branch: Option<String>,
    /// 未提交的改动文件数(含未跟踪)
    pub dirty_files: u32,
    pub insertions: u32,
    pub deletions: u32,
}

/// 一个目录的 git 概况。`status --porcelain -b` 一次同时给出分支和改动文件,
/// 比分开调 rev-parse + status 少一次进程启动。
fn git_snapshot(path: &str) -> (Option<String>, u32, u32, u32) {
    let Some(status) = git(path, &["status", "--porcelain=v1", "-b"]) else {
        return (None, 0, 0, 0);
    };
    let mut branch = None;
    let mut dirty = 0u32;
    for (i, line) in status.lines().enumerate() {
        if i == 0 && line.starts_with("##") {
            // "## main...origin/main [ahead 1]" -> "main";"## HEAD (no branch)" -> None
            let b = line.trim_start_matches("##").trim();
            let b = b.split("...").next().unwrap_or(b).trim();
            if !b.is_empty() && !b.contains("(no branch)") {
                branch = Some(b.to_string());
            }
            continue;
        }
        if !line.trim().is_empty() {
            dirty += 1;
        }
    }
    // 行级增删只看已跟踪文件,未跟踪文件没有 diff 可言
    let (ins, del) = git(path, &["diff", "--numstat", "HEAD"])
        .map(|out| {
            let mut i = 0u32;
            let mut d = 0u32;
            for line in out.lines() {
                let mut it = line.split('\t');
                if let (Some(a), Some(b)) = (it.next(), it.next()) {
                    i += a.parse::<u32>().unwrap_or(0);
                    d += b.parse::<u32>().unwrap_or(0);
                }
            }
            (i, d)
        })
        .unwrap_or((0, 0));
    (branch, dirty, ins, del)
}

const AGENT_BINS: &[&str] = &[
    "claude", "codex", "aider", "gemini", "opencode", "amp", "goose",
];

/// lsof -F 会把非 ASCII 字节输出成 \xAB 转义,这里还原回 UTF-8(中文目录名)
fn decode_lsof_escapes(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 3 < bytes.len() && bytes[i + 1] == b'x' {
            if let Some(hex) = std::str::from_utf8(&bytes[i + 2..i + 4]).ok() {
                if let Ok(b) = u8::from_str_radix(hex, 16) {
                    out.push(b);
                    i += 4;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn cwd_of_pid(pid: u32) -> Option<String> {
    let out = Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| l.starts_with('n'))
        .map(|l| decode_lsof_escapes(&l[1..]))
}

#[tauri::command]
fn running_agents() -> Result<Vec<AgentProc>, String> {
    let out = Command::new("ps")
        .args(["-axo", "pid=,args="])
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);

    let mut found: Vec<AgentProc> = Vec::new();
    let mut dedupe: HashSet<(String, String)> = HashSet::new();

    for line in text.lines() {
        let line = line.trim_start();
        let Some((pid_str, args)) = line.split_once(' ') else {
            continue;
        };
        let Ok(pid) = pid_str.trim().parse::<u32>() else {
            continue;
        };
        let first = args.split_whitespace().next().unwrap_or("");
        let base = first.rsplit('/').next().unwrap_or("");
        let Some(agent) = AGENT_BINS.iter().find(|a| **a == base) else {
            continue;
        };
        let cwd = cwd_of_pid(pid);
        let project = cwd
            .as_deref()
            .map(|c| c.rsplit('/').next().unwrap_or(c).to_string());
        let key = (agent.to_string(), cwd.clone().unwrap_or_default());
        if !dedupe.insert(key) {
            continue; // 同一 agent 在同一目录的多个进程只记一条
        }
        let (branch, dirty_files, insertions, deletions) =
            cwd.as_deref().map(git_snapshot).unwrap_or((None, 0, 0, 0));
        found.push(AgentProc {
            agent: agent.to_string(),
            pid,
            cwd,
            project,
            branch,
            dirty_files,
            insertions,
            deletions,
        });
    }
    Ok(found)
}

/// 某个 git 仓库的今日开发数据
#[derive(Serialize)]
pub struct RepoToday {
    pub path: String,
    pub name: String,
    pub commits_today: u32,
    pub unpushed: u32,
    pub last_commit_min: Option<i64>,
    pub last_message: String,
}

fn git(path: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tauri::command]
fn dev_today(paths: Vec<String>) -> Vec<RepoToday> {
    let mut repos = Vec::new();
    let mut seen_roots: HashSet<String> = HashSet::new();
    for p in paths {
        if !std::path::Path::new(&p).is_dir() {
            continue;
        }
        // 归一到仓库根目录,避免子目录重复统计
        let Some(root) = git(&p, &["rev-parse", "--show-toplevel"]) else {
            continue;
        };
        if !seen_roots.insert(root.clone()) {
            continue;
        }
        let commits_today = git(&root, &["log", "--oneline", "--since=midnight"])
            .map(|s| {
                if s.is_empty() {
                    0
                } else {
                    s.lines().count() as u32
                }
            })
            .unwrap_or(0);
        let unpushed = git(&root, &["rev-list", "--count", "@{u}..HEAD"])
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let (last_commit_min, last_message) = git(&root, &["log", "-1", "--format=%ct|%s"])
            .and_then(|s| {
                let (ct, msg) = s.split_once('|')?;
                let ct: i64 = ct.parse().ok()?;
                let now = chrono::Utc::now().timestamp();
                Some((Some((now - ct) / 60), msg.to_string()))
            })
            .unwrap_or((None, String::new()));
        let name = root.rsplit('/').next().unwrap_or(&root).to_string();
        repos.push(RepoToday {
            path: root,
            name,
            commits_today,
            unpushed,
            last_commit_min,
            last_message,
        });
    }
    // commit 多的排前面
    repos.sort_by(|a, b| b.commits_today.cmp(&a.commits_today));
    repos
}

/// 调用本机 claude CLI 生成每日总结(headless 模式)
#[tauri::command]
async fn ai_daily_summary(data: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let prompt = format!(
            "你是开发者的每日复盘助手。以下是我今天的真实开发数据(JSON):\n{data}\n\n\
             请用中文输出简短的每日总结,固定四个部分,每部分 1-2 句:\n\
             1. 今日概览(commit/push/token 一句话)\n\
             2. 今日亮点\n\
             3. 值得沉淀为 skill 的重复流程(根据项目和会话情况推测,没有就说暂无)\n\
             4. 明日建议\n\
             直接输出四行编号内容。不要客套话,不要 markdown 加粗和标题,\
             不要在结尾附加任何分隔线、提示语或与总结无关的内容。"
        );
        let out = Command::new("claude")
            .args(["-p", &prompt])
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("调用 claude CLI 失败: {e}"))?;
        if !out.status.success() {
            return Err(format!(
                "claude CLI 返回错误: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============ 参赛模式:赛程规划与赛事问答 ============

/// 调本地 claude CLI(headless),返回原始 stdout。
/// stdin 必须显式关掉:否则 CLI 会等 3 秒 stdin 再放弃,每次调用白付 3 秒。
fn run_claude(prompt: &str) -> Result<String, String> {
    let out = Command::new("claude")
        .args(["-p", prompt])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("调用 claude CLI 失败(确认已安装 claude 命令): {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude CLI 返回错误: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// CLI 常把 JSON 裹在 ```json 里或前后带解释,这里剥出纯 JSON
fn extract_json(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")) {
        if let Some(end) = rest.rfind("```") {
            return rest[..end].trim().to_string();
        }
    }
    match (t.find('{'), t.rfind('}')) {
        (Some(a), Some(b)) if b > a => t[a..=b].to_string(),
        _ => t.to_string(),
    }
}

/// 把赛事文档解析成带时间的赛程节点。返回 JSON 字符串,前端自行解析。
#[tauri::command]
async fn plan_hackathon(
    name: String,
    start: String,
    end: String,
    doc: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let now = chrono::Local::now().to_rfc3339();
        let doc_part = if doc.trim().is_empty() {
            "(主办方文档未提供,只依据上面的起止时间做合理推导)".to_string()
        } else {
            format!("主办方赛事文档/群公告原文:\n---\n{doc}\n---")
        };
        let prompt = format!(
            "你是黑客松参赛教练。当前时间 {now}。\n\
             比赛名称: {name}\n比赛开始: {start}\n提交截止: {end}\n\n{doc_part}\n\n\
             请规划这场比赛的关键时间节点,输出**纯 JSON**,不要 markdown 代码块,不要任何解释文字。\n\
             格式: {{\"milestones\":[{{\"at\":\"ISO8601带时区\",\"title\":\"节点名\",\"action\":\"这个点选手要做什么(20字内)\",\"critical\":true}}]}}\n\
             要求:\n\
             1. at 必须落在比赛开始与提交截止之间(报名/材料准备类节点可早于开始)\n\
             2. critical=true 只给错过就无法挽回的硬节点(报名截止、提交截止、路演签到)\n\
             3. 文档里写明的时间必须原样保留,不要自己改;文档没写的才按经验推导\n\
             4. 6-10 个节点,按时间升序\n\
             5. action 写具体动作,不要写「继续开发」这种废话"
        );
        let raw = run_claude(&prompt)?;
        let json = extract_json(&raw);
        serde_json::from_str::<serde_json::Value>(&json).map_err(|e| {
            format!(
                "CLI 返回的不是合法 JSON({e})。原始输出前 300 字: {}",
                raw.chars().take(300).collect::<String>()
            )
        })?;
        Ok(json)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 赛事问答:带上赛事文档作为上下文,回答「赞助商 token 在哪领」这类问题
#[tauri::command]
async fn ask_hackathon(
    question: String,
    name: String,
    doc: String,
    milestones: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let doc_part = if doc.trim().is_empty() {
            "(选手没有提供主办方文档)".to_string()
        } else {
            format!("主办方赛事文档原文:\n---\n{doc}\n---")
        };
        let prompt = format!(
            "你是「{name}」这场黑客松的参赛助手,正在比赛现场帮选手快速答疑。\n\n\
             {doc_part}\n\n已规划的赛程节点(JSON): {milestones}\n\n\
             选手的问题: {question}\n\n\
             回答要求:\n\
             1. 用中文,3 句话以内,直接给答案和下一步动作\n\
             2. 文档里有明确写的,直接引用原文里的关键信息(地址、链接、时间、联系人)\n\
             3. 文档里没写的,明确说「文档里没写」,再给一句最合理的建议(比如去问主办方群里的谁)\n\
             4. 不要客套话,不要 markdown 标题和加粗,不要复述问题"
        );
        run_claude(&prompt)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============ 长期数据聚合与云端同步 ============

/// 单个项目的长期投入(只上报仓库名/统计值,本地路径不出机器)
#[derive(Serialize, Clone)]
pub struct ProjectStat {
    pub name: String,
    pub repo: Option<String>,
    pub tokens: u64,
    pub active_minutes: u32,
    pub edits: u32,
}

#[derive(Serialize, Default)]
pub struct SkillStat {
    pub name: String,
    pub count: u32,
}

#[derive(Serialize, Default, Clone)]
pub struct ModelStat {
    pub model: String,
    pub tokens: u64,
}

#[derive(Serialize)]
pub struct ProfileStats {
    pub period_days: u32,
    pub tokens: u64,
    pub output: u64,
    pub sessions: usize,
    pub active_days: usize,
    pub active_minutes: usize,
    pub edits: u32,
    pub skills: Vec<SkillStat>,
    pub models: Vec<ModelStat>,
    pub projects: Vec<ProjectStat>,
    /// 各数据来源(claude / codex)按模型细分的用量
    pub sources: Vec<SourceUsage>,
}

/// git remote URL 归一化成 github.com/owner/repo 形式
fn normalize_repo(url: &str) -> String {
    let mut s = url.trim().to_string();
    for prefix in ["https://", "http://", "ssh://git@", "git@"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.to_string();
            break;
        }
    }
    s = s.replacen(
        ':',
        "/",
        if s.contains(".com:") || s.contains(".org:") {
            1
        } else {
            0
        },
    );
    s.trim_end_matches(".git").trim_end_matches('/').to_string()
}

/// 内置命令不算 skill 使用
const BUILTIN_COMMANDS: &[&str] = &[
    "clear", "help", "login", "logout", "model", "config", "compact", "cost", "exit", "quit",
    "resume", "status", "init", "doctor", "memory", "context", "hooks", "agents", "mcp",
];

fn collect_profile_stats(days: u32) -> Result<ProfileStats, String> {
    let root = claude_projects_dir().ok_or("找不到用户目录")?;
    let cutoff_sys = SystemTime::now() - Duration::from_secs(days as u64 * 86400);
    let cutoff_day = (chrono::Utc::now() - chrono::Duration::days(days as i64))
        .format("%Y-%m-%d")
        .to_string();

    struct Proj {
        tokens: u64,
        edits: u32,
        minutes: HashSet<String>,
    }
    let mut per_cwd: HashMap<String, Proj> = HashMap::new();
    let mut models: HashMap<String, u64> = HashMap::new();
    let mut skills: HashMap<String, u32> = HashMap::new();
    let mut sessions: HashSet<String> = HashSet::new();
    let mut days_set: HashSet<String> = HashSet::new();
    let mut minutes_set: HashSet<String> = HashSet::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut total_tokens = 0u64;
    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut total_cache_write = 0u64;
    let mut total_cache_read = 0u64;
    let mut total_edits = 0u32;

    for path in jsonl_files_since(&root, cutoff_sys) {
        let Ok(file) = fs::File::open(&path) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            let has_usage = line.contains("\"usage\"");
            let has_command = line.contains("<command-name>");
            if !has_usage && !has_command {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let ts = v["timestamp"].as_str().unwrap_or("");
            if ts.is_empty() || ts[..10.min(ts.len())] < cutoff_day[..] {
                continue;
            }

            // skill 使用:用户消息里的 <command-name>/xxx</command-name>
            if has_command && v["type"] == "user" {
                if let Some(content) = v["message"]["content"].as_str() {
                    if let Some(name) = content
                        .split("<command-name>")
                        .nth(1)
                        .and_then(|s| s.split("</command-name>").next())
                    {
                        let name = name.trim().trim_start_matches('/').to_string();
                        if !name.is_empty() && !BUILTIN_COMMANDS.contains(&name.as_str()) {
                            *skills.entry(name).or_insert(0) += 1;
                        }
                    }
                }
                continue;
            }

            if v["type"] != "assistant" {
                continue;
            }
            let Some(usage) = v["message"]["usage"].as_object() else {
                continue;
            };
            let key = format!(
                "{}:{}",
                v["message"]["id"].as_str().unwrap_or(""),
                v["requestId"]
                    .as_str()
                    .unwrap_or_else(|| v["uuid"].as_str().unwrap_or(""))
            );
            if !seen.insert(key) {
                continue;
            }
            let g = |k: &str| usage.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
            let line_tokens = g("input_tokens")
                + g("output_tokens")
                + g("cache_creation_input_tokens")
                + g("cache_read_input_tokens");
            total_tokens += line_tokens;
            total_input += g("input_tokens");
            total_output += g("output_tokens");
            total_cache_write += g("cache_creation_input_tokens");
            total_cache_read += g("cache_read_input_tokens");
            days_set.insert(ts[..10].to_string());
            minutes_set.insert(ts[..16.min(ts.len())].to_string());
            if let Some(sid) = v["sessionId"].as_str() {
                sessions.insert(sid.to_string());
            }
            if let Some(model) = v["message"]["model"].as_str() {
                if model != "<synthetic>" {
                    *models.entry(model.to_string()).or_insert(0) += line_tokens;
                }
            }
            let mut edits = 0u32;
            if let Some(content) = v["message"]["content"].as_array() {
                for item in content {
                    if item["type"] == "tool_use"
                        && item["name"]
                            .as_str()
                            .is_some_and(|n| EDIT_TOOLS.contains(&n))
                    {
                        edits += 1;
                    }
                }
            }
            total_edits += edits;
            if let Some(cwd) = v["cwd"].as_str() {
                if !cwd.is_empty() {
                    let p = per_cwd.entry(cwd.to_string()).or_insert_with(|| Proj {
                        tokens: 0,
                        edits: 0,
                        minutes: HashSet::new(),
                    });
                    p.tokens += line_tokens;
                    p.edits += edits;
                    p.minutes.insert(ts[..16.min(ts.len())].to_string());
                }
            }
        }
    }

    let mut projects: Vec<ProjectStat> = per_cwd
        .into_iter()
        .map(|(cwd, p)| {
            let repo = git(&cwd, &["config", "--get", "remote.origin.url"])
                .filter(|s| !s.is_empty())
                .map(|u| normalize_repo(&u));
            let name = repo
                .as_deref()
                .and_then(|r| r.rsplit('/').next())
                .unwrap_or_else(|| cwd.rsplit('/').next().unwrap_or(&cwd))
                .to_string();
            ProjectStat {
                name,
                repo,
                tokens: p.tokens,
                active_minutes: p.minutes.len() as u32,
                edits: p.edits,
            }
        })
        .collect();
    projects.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    projects.truncate(20);

    let mut skills_vec: Vec<SkillStat> = skills
        .into_iter()
        .map(|(name, count)| SkillStat { name, count })
        .collect();
    skills_vec.sort_by(|a, b| b.count.cmp(&a.count));
    skills_vec.truncate(30);

    let models_vec = models_sorted(models);

    let claude_source = SourceUsage {
        source: "claude".into(),
        input: total_input,
        output: total_output,
        cache_write: total_cache_write,
        cache_read: total_cache_read,
        total: total_tokens,
        sessions: sessions.len(),
        models: models_vec.clone(),
    };
    let codex_source = collect_codex_usage(&format!("{cutoff_day}T00:00:00"), cutoff_sys);
    // 与 cutoff_day(UTC 零点)同口径的 epoch 秒
    let cutoff_epoch = (chrono::Utc::now() - chrono::Duration::days(days as i64))
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .expect("00:00:00 恒为合法时间")
        .and_utc()
        .timestamp();
    let grok_source = collect_grok_usage(cutoff_epoch, cutoff_sys);

    Ok(ProfileStats {
        period_days: days,
        tokens: total_tokens,
        output: total_output,
        sessions: sessions.len(),
        active_days: days_set.len(),
        active_minutes: minutes_set.len(),
        edits: total_edits,
        skills: skills_vec,
        models: models_vec,
        projects,
        sources: vec![claude_source, codex_source, grok_source],
    })
}

#[tauri::command]
async fn profile_stats(days: u32) -> Result<ProfileStats, String> {
    tauri::async_runtime::spawn_blocking(move || collect_profile_stats(days.clamp(1, 365)))
        .await
        .map_err(|e| e.to_string())?
}

/// 聚合并上报到 HackerTrip 云端(绑定 API Key 对应的账号)
#[tauri::command]
async fn sync_profile(
    api_key: String,
    days: u32,
    endpoint: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stats = collect_profile_stats(days.clamp(1, 365))?;
        let url =
            endpoint.unwrap_or_else(|| "https://hackertrip.space/api/desktop/stats".to_string());
        let payload = serde_json::json!({
            "periodDays": stats.period_days,
            "totals": {
                "tokens": stats.tokens,
                "output": stats.output,
                "sessions": stats.sessions,
                "activeDays": stats.active_days,
                "activeMinutes": stats.active_minutes,
                "edits": stats.edits,
            },
            "skills": stats.skills,
            "models": stats.models,
            "projects": stats.projects,
            // 多来源(claude/codex)按模型细分,老服务端不认识该字段会自动忽略
            "sources": stats.sources,
            "clientVersion": env!("CARGO_PKG_VERSION"),
        });
        let resp = ureq::post(&url)
            .header("Authorization", &format!("Bearer {}", api_key.trim()))
            .send_json(payload);
        match resp {
            Ok(mut r) => Ok(r
                .body_mut()
                .read_to_string()
                .unwrap_or_else(|_| "{\"ok\":true}".into())),
            Err(ureq::Error::StatusCode(code)) => {
                Err(format!("服务端返回 {code}(检查 API Key 是否有效)"))
            }
            Err(e) => Err(format!("网络请求失败: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============ GitHub 登录(浏览器授权 + 本地回环回调) ============

/// 打开浏览器走网站的 GitHub OAuth,本地起临时端口接收回调,拿回 API Key。
/// 全程密钥只经过 127.0.0.1 回环,不落中间服务。
#[tauri::command]
async fn github_login(endpoint_base: Option<String>) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::net::TcpListener;

    tauri::async_runtime::spawn_blocking(move || {
        let base = endpoint_base.unwrap_or_else(|| "https://hackertrip.space".to_string());
        let listener =
            TcpListener::bind("127.0.0.1:0").map_err(|e| format!("本地端口监听失败: {e}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        // state 防跨请求伪造:纳秒时间戳 + pid
        let state = format!(
            "{}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
            std::process::id()
        );

        let auth_url = format!("{base}/api/desktop/auth?state={state}&port={port}");
        Command::new("open")
            .arg(&auth_url)
            .spawn()
            .map_err(|e| format!("打开浏览器失败: {e}"))?;

        listener
            .set_nonblocking(false)
            .map_err(|e| e.to_string())?;
        // 10 分钟内等待浏览器回调(首次可能要走完整 GitHub 授权,耗时较长)
        let deadline = std::time::Instant::now() + Duration::from_secs(600);
        listener
            .set_nonblocking(true)
            .map_err(|e| e.to_string())?;
        let mut stream = loop {
            match listener.accept() {
                Ok((s, _)) => break s,
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    if std::time::Instant::now() > deadline {
                        return Err("等待登录超时,请重试(已在网站登录的话,重点一次按钮即可)".into());
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                Err(e) => return Err(format!("接收回调失败: {e}")),
            }
        };
        stream.set_nonblocking(false).map_err(|e| e.to_string())?;

        let mut buf = [0u8; 4096];
        let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
        let request = String::from_utf8_lossy(&buf[..n]);
        let first_line = request.lines().next().unwrap_or("");
        // 形如 GET /callback?key=ht_live_xxx&state=yyy HTTP/1.1
        let query = first_line
            .split_whitespace()
            .nth(1)
            .and_then(|p| p.split_once('?'))
            .map(|(_, q)| q)
            .unwrap_or("");
        let mut key = String::new();
        let mut got_state = String::new();
        for pair in query.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                match k {
                    "key" => key = v.to_string(),
                    "state" => got_state = v.to_string(),
                    _ => {}
                }
            }
        }

        let ok = !key.is_empty() && got_state == state && key.starts_with("ht_live_");
        let body = if ok {
            "<html><meta charset=utf-8><body style='background:#0a080e;color:#f2eef5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh'><div style='text-align:center'><h2>✅ 登录成功</h2><p>账号已绑定,可以回到 HackerTrip 桌面应用了</p></div></body></html>"
        } else {
            "<html><meta charset=utf-8><body style='background:#0a080e;color:#f2eef5;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh'><div style='text-align:center'><h2>登录失败</h2><p>请回到应用重试</p></div></body></html>"
        };
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .as_bytes(),
        );

        if ok {
            Ok(key)
        } else {
            Err("回调校验失败,请重试".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 用 API Key 找服务端要一个小程序绑定码(6 位,10 分钟有效)
#[tauri::command]
async fn request_pair_code(
    api_key: String,
    endpoint_base: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = endpoint_base.unwrap_or_else(|| "https://hackertrip.space".to_string());
        let resp = ureq::post(&format!("{base}/api/pair/code"))
            .header("Authorization", &format!("Bearer {}", api_key.trim()))
            .send_json(serde_json::json!({}));
        match resp {
            Ok(mut r) => {
                let text = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
                let v: serde_json::Value =
                    serde_json::from_str(&text).map_err(|e| e.to_string())?;
                v["code"]
                    .as_str()
                    .map(String::from)
                    .ok_or_else(|| format!("服务端响应异常: {text}"))
            }
            Err(ureq::Error::StatusCode(code)) => Err(format!("服务端返回 {code}(检查 API Key)")),
            Err(e) => Err(format!("网络请求失败: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ============ 作品提取:把本地项目变成可提交的参赛作品 ============

/// git remote 可能是 SSH 形式,而小程序端 pairSync 用 isHttpUrl 硬校验,
/// 非 http(s) 会被判成脏链接直接置空,所以这里统一转成 https。
fn remote_to_https(url: &str) -> String {
    let u = url.trim().trim_end_matches(".git");
    if let Some(rest) = u.strip_prefix("git@") {
        // git@github.com:owner/repo -> https://github.com/owner/repo
        if let Some((host, path)) = rest.split_once(':') {
            return format!("https://{host}/{path}");
        }
    }
    if let Some(rest) = u.strip_prefix("ssh://git@") {
        return format!("https://{rest}");
    }
    u.to_string()
}

/// 读项目里的关键文件,交给 CLI 提炼成参赛作品字段。
/// 输出必须凑齐 name + (repo 或 demo),否则小程序端会以 INVALID_WORK 拒收。
#[tauri::command]
async fn extract_work(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        if !p.is_dir() {
            return Err("拖进来的不是文件夹".to_string());
        }
        let root = git(&path, &["rev-parse", "--show-toplevel"]).unwrap_or_else(|| path.clone());
        let dir_name = root.rsplit('/').next().unwrap_or("").to_string();
        let repo = git(&root, &["remote", "get-url", "origin"])
            .map(|u| remote_to_https(&u))
            .unwrap_or_default();

        // README 取前 6000 字符够 CLI 判断项目在做什么了
        let mut readme = String::new();
        for cand in ["README.md", "readme.md", "README.MD", "README"] {
            if let Ok(s) = fs::read_to_string(p.join(cand)) {
                readme = s.chars().take(6000).collect();
                break;
            }
        }
        let pkg = fs::read_to_string(p.join("package.json"))
            .map(|s| s.chars().take(1500).collect::<String>())
            .unwrap_or_default();
        // 最近 15 条 commit 说明这个项目最近在干什么
        let commits = git(&root, &["log", "-15", "--format=%s"]).unwrap_or_default();

        if readme.is_empty() && pkg.is_empty() && commits.is_empty() {
            return Err("这个目录里没有 README / package.json / git 记录,提取不出作品信息".into());
        }

        let prompt = format!(
            "你是黑客松作品提交助手。下面是选手本地项目的真实信息,请提炼成参赛作品卡片。\n\n\
             目录名: {dir_name}\ngit 仓库地址: {}\n\n\
             README:\n---\n{readme}\n---\n\npackage.json:\n---\n{pkg}\n---\n\n\
             最近 commit:\n---\n{commits}\n---\n\n\
             输出**纯 JSON**,不要 markdown 代码块,不要解释文字:\n\
             {{\"name\":\"作品名(80字内)\",\"summary\":\"一句话讲清做了什么、解决什么问题(150字内)\",\
             \"repo\":\"仓库 http(s) 链接,没有就空字符串\",\"demo\":\"在线 demo http(s) 链接,README 里找不到就空字符串\",\
             \"techStack\":[\"技术栈\",\"最多6个\"],\"cover\":\"\"}}\n\
             要求:\n\
             1. name 必须有,不要直接用目录名,要像个作品名\n\
             2. summary 写实际做的东西,不要写「一个基于 React 的项目」这种空话\n\
             3. repo 和 demo 必须是 http:// 或 https:// 开头,拿不准就留空字符串,不要编造链接\n\
             4. techStack 从 package.json 依赖和 README 里提取真实用到的",
            if repo.is_empty() { "(无 git remote)" } else { &repo }
        );
        let raw = run_claude(&prompt)?;
        let json = extract_json(&raw);
        let mut v: serde_json::Value = serde_json::from_str(&json).map_err(|e| {
            format!(
                "CLI 返回的不是合法 JSON({e})。原始输出前 300 字: {}",
                raw.chars().take(300).collect::<String>()
            )
        })?;
        // CLI 可能漏掉或编造 repo,本地 git remote 是更可靠的事实来源
        if !repo.is_empty() {
            v["repo"] = serde_json::Value::String(repo);
        }
        v["localPath"] = serde_json::Value::String(root);
        Ok(v.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把作品推到小程序待审核区。
///
/// 走的是 pairSync 云函数的 HTTP 触发器,和 hackertrip-cli publish-work 同一条链路:
/// 配对码由选手在小程序「我的 → Skills 同步」生成(6 位),x-sync-token 是配对时给的 uploadToken。
/// 注意这和 request_pair_code 拿到的网站账号绑定码不是一回事,两者不能混用。
#[tauri::command]
async fn push_work(
    sync_url: String,
    sync_token: String,
    pair_code: String,
    work: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let url = sync_url.trim().to_string();
        let token = sync_token.trim().to_string();
        let code = pair_code.trim().to_string();
        if url.is_empty() {
            return Err("缺少 pairSync 触发器地址(在设置里填 HACKERTRIP_SYNC_URL)".into());
        }
        if token.is_empty() {
            return Err("缺少同步密钥(在设置里填 HACKERTRIP_SYNC_TOKEN)".into());
        }
        if code.len() != 6 || !code.chars().all(|c| c.is_ascii_digit()) {
            return Err("配对码必须是 6 位数字,在小程序「我的 → Skills 同步」生成".into());
        }
        let w: serde_json::Value =
            serde_json::from_str(&work).map_err(|e| format!("作品数据不是合法 JSON: {e}"))?;
        let now = chrono::Utc::now().timestamp_millis();
        let payload = serde_json::json!({
            "action": "push",
            "pairCode": code,
            "scan": {
                "source": "hackertrip-desktop",
                "syncedAt": now,
                "project": {
                    "name": w["name"],
                    "summary": w["summary"],
                    "description": w["summary"],
                    "techStack": w["techStack"],
                    "keywords": [],
                },
            },
            "works": [w],
        });
        match ureq::post(&url)
            .header("x-sync-token", &token)
            .send_json(payload)
        {
            Ok(mut r) => {
                let text = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
                let v: serde_json::Value =
                    serde_json::from_str(&text).map_err(|_| format!("服务端响应异常: {text}"))?;
                if v["ok"].as_bool() == Some(true) {
                    Ok("已上传,去小程序「我的 → 作品」确认发布".to_string())
                } else {
                    Err(v["message"]
                        .as_str()
                        .unwrap_or("服务端拒绝了这次提交")
                        .to_string())
                }
            }
            Err(ureq::Error::StatusCode(c)) => Err(format!("服务端返回 {c}(检查触发器地址与密钥)")),
            Err(e) => Err(format!("网络请求失败: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读 vibe-usage daemon 落在本地的额度快照(~/.vibe-usage/*-rate-limits.json)。
/// 没装 vibe-usage 时返回空对象,前端自己降级。
#[tauri::command]
fn rate_limits() -> HashMap<String, serde_json::Value> {
    let mut m = HashMap::new();
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return m;
    };
    let dir = home.join(".vibe-usage");
    for (key, file) in [
        ("claude", "claude-rate-limits.json"),
        ("codex", "codex-rate-limits.json"),
    ] {
        if let Ok(s) = fs::read_to_string(dir.join(file)) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                m.insert(key.to_string(), v);
            }
        }
    }
    m
}

/// Gemini 配额百分比,照 vibeusage 的方式:
/// 读 Gemini CLI 的 ~/.gemini/oauth_creds.json(只读,凭证归 CLI 所有),
/// 调 Google 的 retrieveUserQuota 拿每个模型的剩余配额比例。
/// 过期绝不代刷新——Google 会轮换 refresh_token,代刷会把 CLI 自己的凭证链打断,
/// 只提示用户跑一次 `gemini` 让 CLI 自己刷。
fn fetch_gemini_quota() -> serde_json::Value {
    let Some(home) = dirs::home_dir() else {
        return serde_json::json!({ "status": "absent" });
    };
    let Ok(raw) = fs::read_to_string(home.join(".gemini").join("oauth_creds.json")) else {
        return serde_json::json!({ "status": "absent" });
    };
    let Ok(creds) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return serde_json::json!({ "status": "absent" });
    };
    let Some(token) = creds["access_token"].as_str().filter(|t| !t.is_empty()) else {
        return serde_json::json!({ "status": "absent" });
    };
    let now_ms = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    // 留 60s 余量,临期 token 按过期处理
    if creds["expiry_date"].as_f64().unwrap_or(0.0) <= now_ms + 60_000.0 {
        return serde_json::json!({ "status": "expired" });
    }

    let resp = ureq::post("https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota")
        .header("Authorization", &format!("Bearer {token}"))
        .send_json(serde_json::json!({}));
    let quota: serde_json::Value = match resp {
        Ok(mut r) => match r.body_mut().read_json() {
            Ok(v) => v,
            Err(e) => return serde_json::json!({ "status": "error", "message": e.to_string() }),
        },
        Err(ureq::Error::StatusCode(401 | 403)) => {
            return serde_json::json!({ "status": "expired" });
        }
        Err(e) => return serde_json::json!({ "status": "error", "message": e.to_string() }),
    };

    let buckets: Vec<serde_json::Value> = quota["buckets"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .map(|b| {
                    let model = b["modelId"]
                        .as_str()
                        .map(|m| m.rsplit('/').next().unwrap_or(m))
                        .unwrap_or("");
                    // remainingFraction 缺省 = 配额全在(0% 已用),与 vibeusage 一致
                    let remaining = b["remainingFraction"].as_f64().unwrap_or(1.0);
                    let used = ((1.0 - remaining) * 100.0).clamp(0.0, 100.0);
                    serde_json::json!({
                        "model": model,
                        "utilization": used.round() as i64,
                        "resetsAt": b["resetTime"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    // 订阅档位,拿不到不影响主数据
    let plan = ureq::post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
        .header("Authorization", &format!("Bearer {token}"))
        .send_json(serde_json::json!({}))
        .ok()
        .and_then(|mut r| r.body_mut().read_json::<serde_json::Value>().ok())
        .and_then(|v| v["currentTier"]["name"].as_str().map(String::from));

    serde_json::json!({
        "status": "ok",
        "fetchedAt": now_ms as u64,
        "plan": plan,
        "buckets": buckets,
    })
}

/// 网络结果缓存 60s:用量 tab 反复开关不至于连环打 Google 接口
#[tauri::command]
async fn gemini_quota() -> Result<serde_json::Value, String> {
    use std::sync::{Mutex, OnceLock};
    use std::time::Instant;
    static CACHE: OnceLock<Mutex<Option<(Instant, serde_json::Value)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((at, v)) = guard.as_ref() {
            if at.elapsed() < Duration::from_secs(60) {
                return Ok(v.clone());
            }
        }
    }
    let v = tauri::async_runtime::spawn_blocking(fetch_gemini_quota)
        .await
        .map_err(|e| e.to_string())?;
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((Instant::now(), v.clone()));
    }
    Ok(v)
}

/// 供前端记录/读取轻量状态(比赛配置、清单勾选等存 localStorage,这里暂不需要)
#[tauri::command]
fn app_meta() -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert("version".into(), env!("CARGO_PKG_VERSION").into());
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 冒烟:跑真实本地日志,人工核对数字(依赖本机数据,CI 上跳过)
    /// cargo test smoke_usage -- --ignored --nocapture
    #[test]
    #[ignore]
    fn smoke_usage() {
        let u = usage_today().expect("usage_today 应能扫描本地日志");
        println!(
            "claude 今日: all={} sessions={} files={} models={:?}",
            u.all,
            u.sessions,
            u.scanned_files,
            u.models
                .iter()
                .map(|m| (&m.model, m.tokens))
                .collect::<Vec<_>>()
        );
        for s in &u.sources {
            println!(
                "source={} total={} in={} out={} cw={} cr={} sessions={} models={:?}",
                s.source,
                s.total,
                s.input,
                s.output,
                s.cache_write,
                s.cache_read,
                s.sessions,
                s.models
                    .iter()
                    .map(|m| (&m.model, m.tokens))
                    .collect::<Vec<_>>()
            );
        }
        let p = collect_profile_stats(7).expect("profile_stats 应能扫描本地日志");
        println!("7d: tokens={} sessions={} sources: ", p.tokens, p.sessions);
        for s in &p.sources {
            println!("  {} total={} sessions={}", s.source, s.total, s.sessions);
        }
        // grok 使用频率低,拉一个 90 天宽窗口验证解析器本身
        let g = collect_grok_usage(
            chrono::Utc::now().timestamp() - 90 * 86400,
            SystemTime::now() - Duration::from_secs(90 * 86400),
        );
        println!("gemini quota: {}", fetch_gemini_quota());
        println!(
            "grok 90d: total={} in={} out={} cr={} sessions={} models={:?}",
            g.total,
            g.input,
            g.output,
            g.cache_read,
            g.sessions,
            g.models
                .iter()
                .map(|m| (&m.model, m.tokens))
                .collect::<Vec<_>>()
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            usage_today,
            running_agents,
            agent_status,
            dev_today,
            ai_daily_summary,
            plan_hackathon,
            ask_hackathon,
            extract_work,
            push_work,
            rate_limits,
            gemini_quota,
            profile_stats,
            sync_profile,
            github_login,
            request_pair_code,
            app_meta
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
