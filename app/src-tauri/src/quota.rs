//! Offline quota observations. Never reads another app's credentials or cache.
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::SystemTime,
};
const TAIL_BYTES: u64 = 2 * 1024 * 1024;
const TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_FILES: usize = 256;

fn window(raw: &Value, now: i64) -> Option<Value> {
    let used = raw
        .get("used_percent")
        .or_else(|| raw.get("used_percentage"))?
        .as_f64()?;
    let reset = raw.get("resets_at")?.as_i64()?;
    if !used.is_finite() || !(0.0..=100.0).contains(&used) || reset <= now {
        return None;
    }
    Some(json!({"utilization":used,"resetsAt":reset}))
}
fn event(raw: &Value, now: i64) -> Option<(i64, Value)> {
    if raw["type"] != "event_msg" || raw["payload"]["type"] != "token_count" {
        return None;
    }
    let limits = &raw["payload"]["rate_limits"];
    if !limits.is_object() {
        return None;
    }
    if limits
        .get("limit_id")
        .and_then(Value::as_str)
        .is_some_and(|id| id != "codex")
    {
        return None;
    }
    let ts = chrono::DateTime::parse_from_rfc3339(raw["timestamp"].as_str()?)
        .ok()?
        .timestamp();
    if ts > now + 300 {
        return None;
    }
    let mut five = None;
    let mut seven = None;
    for key in ["primary", "secondary"] {
        let w = &limits[key];
        match w["window_minutes"].as_i64() {
            Some(300) => five = window(w, now),
            Some(10080) => seven = window(w, now),
            _ => {}
        }
    }
    let status = if five.is_some() || seven.is_some() {
        "ok"
    } else {
        "expired"
    };
    Some((
        ts,
        json!({"status":status,"source":"codex_session","dataAsOf":ts,"fetchedAt":now,
        "fiveHour":five,"sevenDay":seven,"planLabel":limits["plan_type"].as_str()}),
    ))
}
fn files(root: &Path) -> Vec<(PathBuf, SystemTime)> {
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut out = Vec::new();
    while let Some((dir, depth)) = pending.pop() {
        if depth > 6 {
            continue;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ty) = entry.file_type() else {
                continue;
            };
            if ty.is_symlink() {
                continue;
            }
            let path = entry.path();
            if ty.is_dir() {
                pending.push((path, depth + 1));
            } else if path.extension().is_some_and(|x| x == "jsonl") {
                if let Ok(t) = entry.metadata().and_then(|m| m.modified()) {
                    out.push((path, t));
                }
            }
        }
    }
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out
}
pub fn codex(root: &Path, now: i64) -> Value {
    let mut newest: Option<(i64, Value)> = None;
    let mut bytes = 0;
    let mut scanned = 0;
    for (path, modified) in files(root).into_iter().take(MAX_FILES) {
        if let Some((ts, _)) = &newest {
            if modified
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|x| (x.as_secs() as i64) < *ts)
                .unwrap_or(false)
            {
                break;
            }
        }
        if bytes >= TOTAL_BYTES {
            break;
        }
        let Ok(mut file) = fs::File::open(path) else {
            continue;
        };
        let Ok(meta) = file.metadata() else {
            continue;
        };
        let take = meta.len().min(TAIL_BYTES).min(TOTAL_BYTES - bytes);
        let offset = meta.len() - take;
        if file.seek(SeekFrom::Start(offset)).is_err() {
            continue;
        }
        let mut data = Vec::with_capacity(take as usize);
        if file.take(take).read_to_end(&mut data).is_err() {
            continue;
        }
        bytes += take;
        scanned += 1;
        let start = if offset > 0 {
            data.iter()
                .position(|&x| x == b'\n')
                .map(|x| x + 1)
                .unwrap_or(data.len())
        } else {
            0
        };
        for line in data[start..].split(|&x| x == b'\n') {
            if line.len() > 1024 * 1024 || !line.windows(13).any(|w| w == b"\"rate_limits\"") {
                continue;
            }
            let Ok(raw) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if let Some(candidate) = event(&raw, now) {
                if newest.as_ref().is_none_or(|v| candidate.0 > v.0) {
                    newest = Some(candidate);
                }
            }
        }
    }
    let mut value = newest
        .map(|x| x.1)
        .unwrap_or_else(|| json!({"status":"no_data","source":"codex_session","fetchedAt":now}));
    value["scannedFiles"] = json!(scanned);
    value["boundedScan"] = json!(true);
    value
}
/// Reads Haki's own opt-in statusline snapshot. Source payload is reduced by the capture command.
pub fn claude(root: &Path, now: i64) -> Value {
    let snapshot = fs::read(root.join("claude-quota.json"))
        .ok()
        .filter(|x| x.len() <= 16384)
        .and_then(|x| serde_json::from_slice::<Value>(&x).ok());
    let Some(raw) = snapshot else {
        return json!({"status":"no_data","source":"claude_statusline","fetchedAt":now});
    };
    let Some(ts) = raw["captured_at"].as_i64().filter(|t| *t <= now + 300) else {
        return json!({"status":"error","fetchedAt":now});
    };
    let five = window(&raw["rate_limits"]["five_hour"], now);
    let seven = window(&raw["rate_limits"]["seven_day"], now);
    let status = if five.is_some() || seven.is_some() {
        "ok"
    } else if raw["rate_limits"].as_object().is_some_and(|x| x.is_empty()) {
        "no_data"
    } else {
        "expired"
    };
    json!({"configured":true,"status":status,"source":"claude_statusline","dataAsOf":ts,"fetchedAt":now,
        "five_hour":five.map(|w|json!({"used_percentage":w["utilization"],"resets_at":w["resetsAt"]})),
        "seven_day":seven.map(|w|json!({"used_percentage":w["utilization"],"resets_at":w["resetsAt"]}))})
}
pub fn capture_claude(input: &[u8], root: &Path, now: i64) -> Result<(), String> {
    if input.len() > 1024 * 1024 {
        return Err("STATUSLINE_INPUT_TOO_LARGE".into());
    }
    let raw: Value = serde_json::from_slice(input).map_err(|_| "INVALID_STATUSLINE")?;
    let mut limits = json!({});
    for key in ["five_hour", "seven_day"] {
        if let Some(w) = window(&raw["rate_limits"][key], now) {
            limits[key] = json!({"used_percentage":w["utilization"],"resets_at":w["resetsAt"]});
        }
    }
    // Write only quota fields, never cwd/transcript/session ID, provider credentials or messages.
    fs::create_dir_all(root).map_err(|_| "QUOTA_DIRECTORY_UNAVAILABLE")?;
    let temp = root.join(format!(".claude-quota-{}.tmp", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut f = options.open(&temp).map_err(|_| "QUOTA_CACHE_UNAVAILABLE")?;
    use std::io::Write;
    let result = (|| {
        f.write_all(
            json!({"captured_at":now,"rate_limits":limits})
                .to_string()
                .as_bytes(),
        )?;
        f.sync_all()?;
        fs::rename(&temp, root.join("claude-quota.json"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result.map_err(|_: std::io::Error| "QUOTA_CACHE_WRITE_FAILED".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn e(ts: i64, primary: Value, secondary: Value) -> Value {
        json!({"type":"event_msg","timestamp":chrono::DateTime::from_timestamp(ts,0).unwrap().to_rfc3339(),"payload":{"type":"token_count","rate_limits":{"primary":primary,"secondary":secondary}}})
    }
    fn w(minutes: i64, pct: f64, reset: i64) -> Value {
        json!({"window_minutes":minutes,"used_percent":pct,"resets_at":reset})
    }
    #[test]
    fn weekly_primary_is_not_five_hours() {
        let (_, v) = event(&e(100, w(10080, 83.0, 900), Value::Null), 200).unwrap();
        assert_eq!(v["sevenDay"]["utilization"], 83.0);
        assert!(v["fiveHour"].is_null());
    }
    #[test]
    fn expires_windows_independently() {
        let (_, v) = event(&e(100, w(300, 20.0, 150), w(10080, 50.0, 900)), 200).unwrap();
        assert!(v["fiveHour"].is_null());
        assert_eq!(v["status"], "ok");
    }
    #[test]
    fn invalid_percent_is_not_zero() {
        assert!(window(&w(300, -1.0, 900), 200).is_none());
        assert!(window(&w(300, 101.0, 900), 200).is_none());
        assert_eq!(window(&w(300, 0.0, 900), 200).unwrap()["utilization"], 0.0);
    }
    #[test]
    fn excludes_other_events_and_future() {
        let mut x = e(100, w(300, 5.0, 900), Value::Null);
        x["type"] = json!("response_item");
        assert!(event(&x, 200).is_none());
        assert!(event(&e(1000, w(300, 5.0, 1900), Value::Null), 200).is_none());
    }
    #[test]
    fn newest_event_across_rollouts_and_expiry() {
        let root = std::env::temp_dir().join(format!("haki-quota-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("a.jsonl"),
            e(150, w(300, 30.0, 900), Value::Null).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("b.jsonl"),
            e(120, w(300, 10.0, 900), Value::Null).to_string(),
        )
        .unwrap();
        assert_eq!(codex(&root, 200)["fiveHour"]["utilization"], 30.0);
        assert_eq!(codex(&root, 1000)["status"], "expired");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn statusline_only_saves_quota() {
        let root = std::env::temp_dir().join(format!("haki-claude-test-{}", std::process::id()));
        let raw = json!({"cwd":"PRIVATE_PATH","token":"PRIVATE_SECRET","rate_limits":{"five_hour":{"used_percentage":17.0,"resets_at":900}}});
        capture_claude(raw.to_string().as_bytes(), &root, 200).unwrap();
        let saved = fs::read_to_string(root.join("claude-quota.json")).unwrap();
        assert!(!saved.contains("PRIVATE"));
        assert_eq!(claude(&root, 201)["five_hour"]["used_percentage"], 17.0);
        assert_eq!(claude(&root, 1000)["status"], "expired");
        fs::remove_dir_all(root).unwrap();
    }
}
