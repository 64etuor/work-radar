//! Loopback redirect 수신기 (RFC 8252 installed-app). 실 OAuth 흐름이라 cargo test 아닌 사용자 관찰.

use std::time::Duration;

use super::oauth::{parse_redirect_error, parse_redirect_query};
use super::GmailError;

/// loopback redirect 대기 상한(bounded — 무한 대기 금지). 사용자 동의 시간 포함.
pub const LOOPBACK_TIMEOUT: Duration = Duration::from_secs(180);

/// loopback에 redirect 도착 시 사용자 브라우저에 보여줄 최소 HTML(200).
const SUCCESS_HTML: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: 96\r\n\r\n<html><body style=\"font-family:sans-serif\"><h3>연결되었습니다.</h3><p>이 창을 닫아도 됩니다.</p></body></html>";
/// code 없는 잡음 요청(favicon 등)에 대한 최소 200.
const WAIT_HTML: &str =
    "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\nContent-Length: 7\r\n\r\nwaiting";

/// 임의 loopback 포트에 bind한 단일 OAuth redirect 수신기. bind 후 redirect_uri를 노출하고,
/// 그 URI로 브라우저를 연 뒤 `wait_for_redirect`로 code를 받는다(bounded timeout).
pub struct Loopback {
    listener: tokio::net::TcpListener,
    pub redirect_uri: String,
}

impl Loopback {
    /// 127.0.0.1 임의 포트 bind → redirect_uri 확정. 웹 프레임워크 없음(tokio TcpListener).
    pub async fn bind() -> Result<Self, GmailError> {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| GmailError::Terminal(format!("loopback bind 실패: {e}")))?;
        let port = listener
            .local_addr()
            .map_err(|e| GmailError::Terminal(format!("loopback addr: {e}")))?
            .port();
        Ok(Self {
            listener,
            redirect_uri: format!("http://127.0.0.1:{port}"),
        })
    }

    /// redirect(GET /?code=..&state=..)를 bounded timeout 안에 받아 (code, state) 반환.
    /// code 없는 잡음 요청(favicon 등)은 무시하고 계속 대기한다.
    pub async fn wait_for_redirect(
        self,
        timeout: Duration,
    ) -> Result<(String, String), GmailError> {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let accept_loop = async {
            loop {
                let (mut stream, _) = self
                    .listener
                    .accept()
                    .await
                    .map_err(|e| GmailError::Transient(format!("loopback accept: {e}")))?;
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let first_line = req.lines().next().unwrap_or("");
                if let Some((code, state)) = parse_redirect_query(first_line) {
                    let _ = stream.write_all(SUCCESS_HTML.as_bytes()).await;
                    let _ = stream.flush().await;
                    return Ok::<_, GmailError>((code, state));
                }
                // OAuth error redirect(code 없이 ?error=access_denied 등)는 빠른 실패한다 — 180s
                // timeout까지 매달리지 않는다. 브라우저엔 closing HTML을 주고 Terminal을 즉시 반환한다.
                if parse_redirect_error(first_line).is_some() {
                    let _ = stream.write_all(SUCCESS_HTML.as_bytes()).await;
                    let _ = stream.flush().await;
                    return Err(GmailError::Terminal(
                        "Google 동의가 거부되었거나 실패했습니다 — 다시 시도하세요".into(),
                    ));
                }
                let _ = stream.write_all(WAIT_HTML.as_bytes()).await;
                let _ = stream.flush().await;
            }
        };

        match tokio::time::timeout(timeout, accept_loop).await {
            Ok(result) => result,
            Err(_) => Err(GmailError::Terminal(format!(
                "OAuth redirect {}초 내 미수신 (timeout)",
                timeout.as_secs()
            ))),
        }
    }
}
