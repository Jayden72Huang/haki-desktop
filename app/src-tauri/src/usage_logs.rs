//! Structured CLI usage records only. Never retain prompt text or tool arguments in the process cache.
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::SystemTime,
};
#[derive(Clone)]
struct Entry {
    modified: SystemTime,
    len: u64,
    rows: Vec<Value>,
    size: usize,
}
#[derive(Default)]
struct Cache {
    files: HashMap<PathBuf, Entry>,
    bytes: usize,
}
fn cache() -> &'static Mutex<Cache> {
    static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache::default()))
}
fn counters(value: &Value, names: &[&str]) -> Value {
    Value::Object(
        names
            .iter()
            .filter_map(|name| {
                value.get(name).map(|v| {
                    (
                        (*name).into(),
                        v.as_u64().map(Value::from).unwrap_or(Value::Null),
                    )
                })
            })
            .collect(),
    )
}
fn retain(v: &Value) -> Option<Value> {
    let kind = v["type"].as_str().unwrap_or("");
    if kind == "assistant" && v["message"]["usage"].is_object() {
        let usage = &v["message"]["usage"];
        let mut counters = serde_json::Map::new();
        for name in [
            "input_tokens",
            "output_tokens",
            "cache_creation_input_tokens",
            "cache_read_input_tokens",
        ] {
            if let Some(n) = usage.get(name) {
                counters.insert(name.into(), n.clone());
            }
        }
        let tools: Vec<_> = v["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|x| x["type"] == "tool_use")
            .map(|x| json!({"type":"tool_use","name":x["name"],"id":x["id"]}))
            .collect();
        Some(
            json!({"type":kind,"timestamp":v["timestamp"],"sessionId":v["sessionId"],"cwd":v["cwd"],"uuid":v["uuid"],"requestId":v["requestId"],"message":{"id":v["message"]["id"],"model":v["message"]["model"],"usage":counters,"content":tools}}),
        )
    } else if kind == "user" {
        let content = v["message"]["content"].as_str()?;
        let name = content
            .split("<command-name>")
            .nth(1)?
            .split("</command-name>")
            .next()?;
        if name.len() > 200 {
            return None;
        }
        Some(
            json!({"type":kind,"timestamp":v["timestamp"],"sessionId":v["sessionId"],"uuid":v["uuid"],"message":{"content":format!("<command-name>{name}</command-name>")}}),
        )
    } else if kind == "session_meta" {
        Some(json!({"type":kind,"payload":{"id":v["payload"]["id"],"cwd":v["payload"]["cwd"]}}))
    } else if kind == "turn_context" {
        Some(
            json!({"type":kind,"payload":{"model":v["payload"]["model"],"cwd":v["payload"]["cwd"]}}),
        )
    } else if kind == "event_msg" && v["payload"]["type"] == "token_count" {
        Some(
            json!({"type":kind,"timestamp":v["timestamp"],"payload":{"type":"token_count","info":{
                "last_token_usage":counters(&v["payload"]["info"]["last_token_usage"],&["input_tokens","cached_input_tokens","output_tokens","reasoning_output_tokens","cache_write_input_tokens","total_tokens"]),
                "total_token_usage":if v["payload"]["info"]["total_token_usage"].is_object(){counters(&v["payload"]["info"]["total_token_usage"],&["input_tokens","cached_input_tokens","output_tokens","reasoning_output_tokens","cache_write_input_tokens","total_tokens"])}else{Value::Null}
            }}}),
        )
    } else if v["params"]["update"]["sessionUpdate"] == "turn_completed" {
        let u = &v["params"]["update"];
        let names = [
            "inputTokens",
            "outputTokens",
            "cachedReadTokens",
            "cacheCreationTokens",
        ];
        let mut usage = counters(&u["usage"], &names);
        if let Some(models) = u["usage"]["modelUsage"].as_object() {
            usage["modelUsage"] = Value::Object(
                models
                    .iter()
                    .map(|(model, value)| (model.clone(), counters(value, &names)))
                    .collect(),
            );
        }
        Some(
            json!({"timestamp":v["timestamp"],"params":{"update":{"sessionUpdate":"turn_completed","prompt_id":u["prompt_id"],"usage":usage}}}),
        )
    } else {
        None
    }
}
pub fn read_events(path: &Path) -> Result<Vec<Value>, String> {
    let metadata = fs::metadata(path).map_err(|_| "USAGE_LOG_UNREADABLE")?;
    let modified = metadata.modified().map_err(|_| "USAGE_LOG_UNREADABLE")?;
    let mut c = cache().lock().map_err(|_| "USAGE_CACHE_UNAVAILABLE")?;
    if let Some(e) = c.files.get(path) {
        if e.modified == modified && e.len == metadata.len() {
            return Ok(e.rows.clone());
        }
    }
    let file = fs::File::open(path).map_err(|_| "USAGE_LOG_UNREADABLE")?;
    let mut rows = Vec::new();
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|_| "USAGE_LOG_UNREADABLE")?;
        if !line.contains("\"usage\"")
            && !line.contains("<command-name>")
            && !line.contains("session_meta")
            && !line.contains("turn_context")
            && !line.contains("token_count")
            && !line.contains("turn_completed")
        {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            if let Some(row) = retain(&v) {
                rows.push(row);
            }
        }
    }
    if let Some(previous) = c.files.remove(path) {
        c.bytes = c.bytes.saturating_sub(previous.size);
    }
    let size = serde_json::to_vec(&rows)
        .map_err(|_| "USAGE_CACHE_INVALID")?
        .len();
    const LIMIT: usize = 32 * 1024 * 1024;
    if size <= LIMIT {
        if c.bytes + size > LIMIT || c.files.len() >= 128 {
            c.files.clear();
            c.bytes = 0;
        }
        c.files.insert(
            path.into(),
            Entry {
                modified,
                len: metadata.len(),
                rows: rows.clone(),
                size,
            },
        );
        c.bytes += size;
    }
    Ok(rows)
}
fn identity(v: &Value, path: &Path, index: usize) -> String {
    let session = v["sessionId"].as_str().unwrap_or("");
    if let Some(id) = v["message"]["id"].as_str().filter(|s| !s.is_empty()) {
        return format!("a:{session}:{id}:{}", v["requestId"].as_str().unwrap_or(""));
    }
    if let Some(id) = v["uuid"].as_str().filter(|s| !s.is_empty()) {
        return format!("u:{session}:{id}");
    }
    format!("{}:{index}", path.display())
}
fn count(v: &Value) -> u64 {
    [
        "input_tokens",
        "output_tokens",
        "cache_creation_input_tokens",
        "cache_read_input_tokens",
    ]
    .iter()
    .filter_map(|k| v["message"]["usage"][k].as_u64())
    .fold(0, u64::saturating_add)
}
fn event_time(v: &Value) -> i64 {
    v["timestamp"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|x| x.timestamp_millis())
        .unwrap_or(i64::MIN)
}
/// Deduplicate before applying the time range: a later final usage record supersedes its stream prefix.
pub fn scan(paths: &[PathBuf], since: i64) -> Result<Vec<Value>, String> {
    let mut events: BTreeMap<String, Value> = BTreeMap::new();
    for path in paths {
        for (index, row) in read_events(path)?.into_iter().enumerate() {
            if row["type"] != "assistant" && row["type"] != "user" {
                continue;
            }
            let key = identity(&row, path, index);
            match events.entry(key) {
                std::collections::btree_map::Entry::Vacant(e) => {
                    e.insert(row);
                }
                std::collections::btree_map::Entry::Occupied(mut e) => {
                    let mut tools: BTreeMap<String, Value> = BTreeMap::new();
                    for tool in e.get()["message"]["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .chain(row["message"]["content"].as_array().into_iter().flatten())
                    {
                        let key = tool["id"]
                            .as_str()
                            .map(String::from)
                            .unwrap_or_else(|| tool.to_string());
                        tools.insert(key, tool.clone());
                    }
                    let old = e.get();
                    if event_time(&row) > event_time(old)
                        || (event_time(&row) == event_time(old) && count(&row) > count(old))
                    {
                        e.insert(row);
                    }
                    if e.get()["type"] == "assistant" {
                        e.get_mut()["message"]["content"] =
                            Value::Array(tools.into_values().collect());
                    }
                }
            }
        }
    }
    Ok(events
        .into_values()
        .filter(|v| event_time(v) >= since.saturating_mul(1000))
        .collect())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn row(id: &str, at: &str, output: u64) -> Value {
        json!({"type":"assistant","sessionId":"s","uuid":uuid::Uuid::new_v4(),"timestamp":at,"cwd":"/local/project","message":{"id":id,"model":"claude-sonnet-4-5","usage":{"input_tokens":10,"output_tokens":output},"content":[{"type":"text","text":"PRIVATE_PROMPT"},{"type":"tool_use","id":"t","name":"Edit","input":{"secret":"PRIVATE_TOOL"}}]}})
    }
    #[test]
    fn final_stream_records_cache_invalidation_and_private_fields() {
        let dir = std::env::temp_dir().join(format!("haki-claude-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let p = dir.join("usage.jsonl");
        let a = row("m", "2026-11-03T00:00:00Z", 1);
        let b = row("m", "2026-11-03T00:00:01Z", 30);
        fs::write(&p, format!("{a}\n{b}\n{{truncated")).unwrap();
        let rows = scan(&[p.clone()], 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(count(&rows[0]), 40);
        let encoded = serde_json::to_string(&rows).unwrap();
        assert!(!encoded.contains("PRIVATE_"));
        assert!(!encoded.contains("secret"));
        assert_eq!(scan(&[p.clone()], 0).unwrap(), rows);
        fs::write(&p, format!("{}\n", row("new", "2026-11-04T00:00:00Z", 50))).unwrap();
        let changed = scan(&[p.clone()], 0).unwrap();
        assert_eq!(changed.len(), 1);
        assert_eq!(count(&changed[0]), 60);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn codex_grok_counters_only_and_tool_blocks_survive_stream_merge() {
        let dir = std::env::temp_dir().join(format!("haki-logs-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let p = dir.join("log.jsonl");
        let codex = json!({"type":"event_msg","timestamp":"2026-11-03T00:00:00Z","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":2,"private":"SECRET_COUNTER"},"total_token_usage":{"total_tokens":12},"private":"SECRET_INFO"}}});
        let grok = json!({"timestamp":100,"params":{"update":{"sessionUpdate":"turn_completed","prompt_id":"p","private":"SECRET_UPDATE","usage":{"inputTokens":12,"outputTokens":3,"modelUsage":{"grok":{"inputTokens":12,"outputTokens":3,"private":"SECRET_USAGE"}}}}}});
        let mut first = row("message", "2026-11-03T00:00:00Z", 1);
        first["message"]["content"] =
            json!([{"type":"tool_use","id":"one","name":"Edit","input":{"private":"SECRET_ARGS"}}]);
        let mut last = row("message", "2026-11-03T00:00:01Z", 20);
        last["message"]["content"] = json!([{"type":"tool_use","id":"two","name":"Write"}]);
        fs::write(&p, format!("{codex}\n{grok}\n{first}\n{last}\n")).unwrap();
        let events = read_events(&p).unwrap();
        assert_eq!(events.len(), 4);
        let encoded = serde_json::to_string(&events).unwrap();
        assert!(!encoded.contains("SECRET_"));
        assert_eq!(
            events[0]["payload"]["info"]["last_token_usage"]["input_tokens"],
            10
        );
        assert_eq!(
            events[1]["params"]["update"]["usage"]["modelUsage"]["grok"]["outputTokens"],
            3
        );
        let merged = scan(&[p], 0).unwrap();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["message"]["content"].as_array().unwrap().len(), 2);
        assert_eq!(count(&merged[0]), 30);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn replay_range_and_distinct_sessions() {
        let dir = std::env::temp_dir().join(format!("haki-claude-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let p = dir.join("a.jsonl");
        let q = dir.join("b.jsonl");
        let a = row("m", "2026-11-02T23:59:59Z", 1);
        let b = row("m", "2026-11-03T00:00:01Z", 30);
        let mut c = b.clone();
        c["sessionId"] = json!("other");
        fs::write(&p, format!("{a}\n{b}\n")).unwrap();
        fs::write(&q, format!("{b}\n{c}\n")).unwrap();
        let cutoff = chrono::DateTime::parse_from_rfc3339("2026-11-03T00:00:00Z")
            .unwrap()
            .timestamp();
        let rows = scan(&[p, q], cutoff).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| count(r) == 40));
        fs::remove_dir_all(dir).unwrap();
    }
}
