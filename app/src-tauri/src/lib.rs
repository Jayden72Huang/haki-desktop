use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

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
}

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
                result.input += g("input_tokens");
                result.output += g("output_tokens");
                result.cache_write += g("cache_creation_input_tokens");
                result.cache_read += g("cache_read_input_tokens");
                if let Some(sid) = v["sessionId"].as_str() {
                    sessions.insert(sid.to_string());
                }
            }
        }
    }
    result.all = result.input + result.output + result.cache_write + result.cache_read;
    result.sessions = sessions.len();
    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![usage_today])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
