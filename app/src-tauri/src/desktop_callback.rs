//! Bounded loopback receiver. Unrelated local requests must not consume a login attempt.
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    time::{Duration, Instant},
};
fn parse(request: &str, state: &str) -> Option<String> {
    let mut line = request.lines().next()?.split_whitespace();
    if line.next()? != "GET" {
        return None;
    }
    let (path, query) = line.next()?.split_once('?')?;
    if path != "/callback" {
        return None;
    }
    let mut key = None;
    let mut returned_state = None;
    for part in query.split('&') {
        let (name, value) = part.split_once('=')?;
        match name {
            "key" => {
                if key.replace(value).is_some() {
                    return None;
                }
            }
            "state" => {
                if returned_state.replace(value).is_some() {
                    return None;
                }
            }
            _ => {}
        }
    }
    let key = key?;
    if returned_state? != state || !crate::credentials::valid(key) {
        return None;
    }
    Some(key.into())
}
pub fn respond(stream: &mut TcpStream, status: &str, message: &str) {
    let body =
        format!("<!doctype html><meta charset=utf-8><title>Haki 桌面授权</title><p>{message}</p>");
    let _=stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes());
}
pub fn receive(
    listener: TcpListener,
    state: &str,
    timeout: Duration,
) -> Result<(TcpStream, String), String> {
    listener
        .set_nonblocking(true)
        .map_err(|_| "AUTH_LISTENER_UNAVAILABLE")?;
    let deadline = Instant::now() + timeout;
    loop {
        if Instant::now() >= deadline {
            return Err("AUTH_CALLBACK_TIMEOUT".into());
        }
        let (mut stream, _) = match listener.accept() {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(50));
                continue;
            }
            Err(_) => return Err("AUTH_LISTENER_FAILED".into()),
        };
        let remaining = deadline
            .saturating_duration_since(Instant::now())
            .min(Duration::from_secs(2));
        if remaining.is_zero() {
            return Err("AUTH_CALLBACK_TIMEOUT".into());
        }
        let _ = stream.set_read_timeout(Some(remaining));
        let _ = stream.set_write_timeout(Some(remaining));
        let mut bytes = Vec::new();
        let mut part = [0u8; 1024];
        while bytes.len() < 8192 {
            match stream.read(&mut part) {
                Ok(0) | Err(_) => break,
                Ok(n) => bytes.extend_from_slice(&part[..n]),
            }
            if bytes.windows(4).any(|x| x == b"\r\n\r\n") {
                break;
            }
        }
        if let Ok(request) = std::str::from_utf8(&bytes) {
            if bytes.len() <= 8192 && bytes.windows(4).any(|x| x == b"\r\n\r\n") {
                if let Some(key) = parse(request, state) {
                    return Ok((stream, key));
                }
            }
        }
        respond(
            &mut stream,
            "400 Bad Request",
            "无效的桌面授权请求。请返回 Haki 发起的授权页面。",
        );
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_wrong_state_path_duplicates_and_invalid_keys() {
        let key = "ht_live_abcdefghijklmnopqrstuvwxyz";
        assert!(parse(
            &format!("GET /callback?key={key}&state=correct HTTP/1.1\r\n"),
            "correct"
        )
        .is_some());
        for target in [
            format!("/callback?key={key}&state=wrong"),
            format!("/favicon.ico?key={key}&state=correct"),
            format!("/callback?key={key}&state=correct&state=correct"),
            "/callback?key=bad&state=correct".into(),
        ] {
            assert!(parse(&format!("GET {target} HTTP/1.1\r\n"), "correct").is_none());
        }
    }
    #[test]
    fn unrelated_request_does_not_abort_login() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let task = std::thread::spawn(move || {
            let (mut stream, key) = receive(listener, "nonce", Duration::from_secs(3)).unwrap();
            respond(&mut stream, "200 OK", "已完成");
            key
        });
        for target in [
            "/favicon.ico",
            "/callback?key=ht_live_abcdefghijklmnopqrstuvwxyz&state=nonce",
        ] {
            let mut client = TcpStream::connect(address).unwrap();
            client
                .write_all(format!("GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").as_bytes())
                .unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut response = String::new();
            client.read_to_string(&mut response).unwrap();
            assert!(response.contains(if target == "/favicon.ico" {
                "400 Bad Request"
            } else {
                "200 OK"
            }));
        }
        assert_eq!(task.join().unwrap(), "ht_live_abcdefghijklmnopqrstuvwxyz");
    }
    #[test]
    fn expires_without_callback() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        assert!(receive(listener, "nonce", Duration::from_millis(20)).is_err());
    }
}
