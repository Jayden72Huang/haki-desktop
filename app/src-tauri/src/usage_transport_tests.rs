//! Actual ureq/socket tests; local fixture server only, never the production account.
use super::*;
use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
};
fn respond(stream: &mut std::net::TcpStream, status: u16, body: &serde_json::Value) {
    let bytes = body.to_string();
    write!(stream,"HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{bytes}",bytes.len()).unwrap();
}
fn fixture(
    responses: Vec<Option<(u16, serde_json::Value)>>,
) -> (String, std::thread::JoinHandle<Vec<serde_json::Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let url = format!(
        "http://{}/api/desktop/usage",
        listener.local_addr().unwrap()
    );
    let thread = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for reply in responses {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            let (mut stream, _) = loop {
                match listener.accept() {
                    Ok(v) => break v,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            std::time::Instant::now() < deadline,
                            "fixture request timed out"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(e) => panic!("{e}"),
                }
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let method = line.split_whitespace().next().unwrap().to_string();
            let mut length = 0;
            loop {
                line.clear();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                if let Some((k, v)) = line.split_once(':') {
                    if k.eq_ignore_ascii_case("content-length") {
                        length = v.trim().parse::<usize>().unwrap();
                    }
                }
            }
            assert!(length < 512 * 1024);
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            requests.push(if method == "POST" {
                serde_json::from_slice(&body).unwrap()
            } else {
                serde_json::json!({"method":method})
            });
            if let Some((status, body)) = reply {
                respond(&mut stream, status, &body);
            }
        }
        requests
    });
    (url, thread)
}
fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .http_status_as_error(false)
        .max_redirects(0)
        .timeout_global(Some(Duration::from_secs(2)))
        .build()
        .new_agent()
}
fn envelope(value: serde_json::Value) -> serde_json::Value {
    let mut v = value;
    v["store"] = serde_json::json!("postgres");
    v["envId"] = serde_json::json!("hackertrip-pgsql-d5e5tt2fe86e9c6");
    v
}
#[test]
fn ambiguous_delivery_replays_identical_batch_then_independent_readback_acknowledges() {
    let dir = std::env::temp_dir().join(format!("haki-transport-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).unwrap();
    let file = dir.join("state.json");
    let mut state = usage_sync::State::default();
    let batch = state
        .prepare(
            "fixture-device",
            "fixture",
            &[],
            Some(serde_json::json!({"providers":[],"clis":[]})),
        )
        .unwrap()
        .unwrap();
    let receipt = envelope(
        serde_json::json!({"ok":true,"userId":"fixture-user","batchId":batch.batch_id,"bucketCount":0,"acceptedAt":"2026-11-03T12:00:00Z"}),
    );
    let devices = envelope(
        serde_json::json!({"userId":"fixture-user","devices":[{"deviceId":"fixture-device","lastSequence":batch.sequence,"revokedAt":null}]}),
    );
    let (url, server) = fixture(vec![None, Some((200, receipt)), Some((200, devices))]);
    assert!(send_pending(
        &agent(),
        &url,
        "LOCAL_FIXTURE_KEY",
        "fixture-user",
        "fixture-device",
        &mut state,
        &file,
        &batch
    )
    .is_err());
    let mut recovered = usage_sync::State::load(&file).unwrap();
    assert_eq!(recovered.pending_batch(), Some(batch.clone()));
    send_pending(
        &agent(),
        &url,
        "LOCAL_FIXTURE_KEY",
        "fixture-user",
        "fixture-device",
        &mut recovered,
        &file,
        &batch,
    )
    .unwrap();
    assert!(usage_sync::State::load(&file)
        .unwrap()
        .pending_batch()
        .is_none());
    let requests = server.join().unwrap();
    assert_eq!(requests[0], requests[1]);
    assert_eq!(requests[2]["method"], "GET");
    fs::remove_dir_all(dir).unwrap();
}
#[test]
fn unverified_receipt_and_authorization_failure_never_advance_acknowledgement() {
    let dir = std::env::temp_dir().join(format!("haki-transport-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&dir).unwrap();
    let file = dir.join("state.json");
    let mut state = usage_sync::State::default();
    let batch = state
        .prepare(
            "fixture-device",
            "fixture",
            &[],
            Some(serde_json::json!({"providers":[],"clis":[]})),
        )
        .unwrap()
        .unwrap();
    let receipt = envelope(
        serde_json::json!({"ok":true,"userId":"another-user","batchId":batch.batch_id,"bucketCount":0,"acceptedAt":"2026-11-03T12:00:00Z"}),
    );
    let (url, server) = fixture(vec![
        Some((200, receipt)),
        Some((401, serde_json::json!({"code":"AUTH_USER_NOT_FOUND"}))),
    ]);
    assert_eq!(
        send_pending(
            &agent(),
            &url,
            "LOCAL_FIXTURE_KEY",
            "fixture-user",
            "fixture-device",
            &mut state,
            &file,
            &batch
        )
        .unwrap_err(),
        "USAGE_RECEIPT_INVALID"
    );
    assert_eq!(state.pending_batch(), Some(batch.clone()));
    assert_eq!(
        send_pending(
            &agent(),
            &url,
            "LOCAL_FIXTURE_KEY",
            "fixture-user",
            "fixture-device",
            &mut state,
            &file,
            &batch
        )
        .unwrap_err(),
        "DESKTOP_AUTH_EXPIRED"
    );
    assert_eq!(
        usage_sync::State::load(&file).unwrap().pending_batch(),
        Some(batch)
    );
    server.join().unwrap();
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn rejected_profile_can_recollect_only_after_independent_sequence_readback() {
    for accepted in [0, 1] {
        let dir=std::env::temp_dir().join(format!("haki-profile-recovery-{}",uuid::Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();let file=dir.join("state.json");
        let mut state=usage_sync::State::default();
        let batch=state.prepare_with_profile("fixture-device","fixture",&[],None,Some(serde_json::json!({"duplicateProjects":true}))).unwrap().unwrap();
        let devices=envelope(serde_json::json!({"userId":"fixture-user","devices":[{"deviceId":"fixture-device","lastSequence":accepted,"revokedAt":null}]}));
        let (url,server)=fixture(vec![Some((400,serde_json::json!({"code":"INVALID_PROFILE"}))),Some((200,devices))]);
        let error=send_pending(&agent(),&url,"LOCAL_FIXTURE_KEY","fixture-user","fixture-device",&mut state,&file,&batch).unwrap_err();
        let mut disk=usage_sync::State::load(&file).unwrap();
        if accepted==0 {
            assert_eq!(error,"SYNC_REBASED_RETRY");assert!(disk.pending_batch().is_none());
            let retry=disk.prepare_with_profile("fixture-device","fixture",&[],None,Some(serde_json::json!({"recollected":true}))).unwrap().unwrap();
            assert_eq!(retry.sequence,batch.sequence);assert_ne!(retry.batch_id,batch.batch_id);
        } else {
            assert_eq!(error,"USAGE_RECEIPT_INVALID");assert_eq!(disk.pending_batch(),Some(batch));
        }
        assert_eq!(server.join().unwrap().len(),2);fs::remove_dir_all(dir).unwrap();
    }
}
