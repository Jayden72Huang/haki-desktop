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
}

const EDIT_TOOLS: &[&str] = &["Edit", "Write", "MultiEdit", "NotebookEdit"];

fn claude_projects_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".claude").join("projects"))
}

#[tauri::command]
fn usage_today() -> Result<UsageToday, String> {
    let root = claude_projects_dir().ok_or("找不到用户目录")?;
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    // 只扫最近 48h 内有写入的文件,今日数据必然在其中
    let cutoff = SystemTime::now() - Duration::from_secs(48 * 3600);

    let mut result = UsageToday::default();
    let mut sessions: HashSet<String> = HashSet::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut projects: HashSet<String> = HashSet::new();
    let mut per_project: HashMap<String, ProjectToday> = HashMap::new();

    let dirs_iter = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for dir in dirs_iter.flatten() {
        let Ok(entries) = fs::read_dir(dir.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let fresh = entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| t >= cutoff)
                .unwrap_or(false);
            if !fresh {
                continue;
            }
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
                if !ts.starts_with(&today) {
                    continue;
                }
                let Some(usage) = v["message"]["usage"].as_object() else {
                    continue;
                };
                // 流式写入会让同一条消息重复出现,按 message.id + requestId 去重
                let key = format!(
                    "{}:{}",
                    v["message"]["id"].as_str().unwrap_or(""),
                    v["requestId"].as_str().unwrap_or_else(|| v["uuid"].as_str().unwrap_or(""))
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
                if let Some(sid) = v["sessionId"].as_str() {
                    sessions.insert(sid.to_string());
                }
                if let Some(cwd) = v["cwd"].as_str() {
                    if !cwd.is_empty() {
                        projects.insert(cwd.to_string());
                        let p = per_project.entry(cwd.to_string()).or_insert_with(|| ProjectToday {
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
    }
    result.all = result.input + result.output + result.cache_write + result.cache_read;
    result.sessions = sessions.len();
    result.projects = projects.into_iter().collect();
    let mut pp: Vec<ProjectToday> = per_project.into_values().collect();
    pp.sort_by(|a, b| b.tokens.cmp(&a.tokens));
    result.per_project = pp;
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

#[tauri::command]
fn agent_status(cwd: String) -> Result<AgentStatus, String> {
    use std::io::{Read, Seek, SeekFrom};

    let root = claude_projects_dir().ok_or("找不到用户目录")?;
    let dir = root.join(encode_project_dir(&cwd));
    let mut latest: Option<(PathBuf, SystemTime)> = None;
    for e in fs::read_dir(&dir).map_err(|_| "该项目暂无会话记录")?.flatten() {
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
}

const AGENT_BINS: &[&str] = &["claude", "codex", "aider", "gemini", "opencode", "amp", "goose"];

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
        found.push(AgentProc {
            agent: agent.to_string(),
            pid,
            cwd,
            project,
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
    let out = Command::new("git").arg("-C").arg(path).args(args).output().ok()?;
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
            .map(|s| if s.is_empty() { 0 } else { s.lines().count() as u32 })
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
            .output()
            .map_err(|e| format!("调用 claude CLI 失败: {e}"))?;
        if !out.status.success() {
            return Err(format!("claude CLI 返回错误: {}", String::from_utf8_lossy(&out.stderr)));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
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

#[derive(Serialize, Default)]
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
    s = s.replacen(':', "/", if s.contains(".com:") || s.contains(".org:") { 1 } else { 0 });
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
    let mut total_output = 0u64;
    let mut total_edits = 0u32;

    for dir in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let Ok(entries) = fs::read_dir(dir.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let fresh = entry
                .metadata()
                .and_then(|m| m.modified())
                .map(|t| t >= cutoff_sys)
                .unwrap_or(false);
            if !fresh {
                continue;
            }
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
                    v["requestId"].as_str().unwrap_or_else(|| v["uuid"].as_str().unwrap_or(""))
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
                total_output += g("output_tokens");
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
                            && item["name"].as_str().is_some_and(|n| EDIT_TOOLS.contains(&n))
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

    let mut models_vec: Vec<ModelStat> = models
        .into_iter()
        .map(|(model, tokens)| ModelStat { model, tokens })
        .collect();
    models_vec.sort_by(|a, b| b.tokens.cmp(&a.tokens));

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
async fn sync_profile(api_key: String, days: u32, endpoint: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let stats = collect_profile_stats(days.clamp(1, 365))?;
        let url = endpoint.unwrap_or_else(|| "https://hackertrip.space/api/desktop/stats".to_string());
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
            Err(ureq::Error::StatusCode(code)) => Err(format!("服务端返回 {code}(检查 API Key 是否有效)")),
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
async fn request_pair_code(api_key: String, endpoint_base: Option<String>) -> Result<String, String> {
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

/// 供前端记录/读取轻量状态(比赛配置、清单勾选等存 localStorage,这里暂不需要)
#[tauri::command]
fn app_meta() -> HashMap<String, String> {
    let mut m = HashMap::new();
    m.insert("version".into(), env!("CARGO_PKG_VERSION").into());
    m
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
            profile_stats,
            sync_profile,
            github_login,
            request_pair_code,
            app_meta
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
