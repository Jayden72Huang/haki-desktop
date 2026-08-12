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

fn cwd_of_pid(pid: u32) -> Option<String> {
    let out = Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find(|l| l.starts_with('n'))
        .map(|l| l[1..].to_string())
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
             直接输出内容,不要客套话。"
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
            app_meta
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
