//! 메신저 브리지 클라이언트 (Phase 20 #15: 외부 Hermes 에이전트 제어).
//! Telegram Bot API류로 work-radar가 외부 Hermes에게 명령을 보내고(sendMessage) 응답을
//! 받는다(getUpdates). "텔레그램 연동하듯이 외부 Hermes를 여기서 제어"(사용자 결정).
//!
//! INVARIANT:
//!  - 봇 토큰은 keychain만 — reqwest URL 안에서만 잠시 쓰이고 DTO/렌더러/DB로 절대 안 나간다.
//!  - 수신은 **bounded**(단발 getUpdates, 짧은 timeout) — 무한 long-poll 루프 금지(#5). 호출
//!    cadence(스케줄/사용자 버튼)는 호출자가 정한다. 한 호출 = 한 bounded 왕복.
//!  - 외부 호출은 Rust(reqwest) + bounded retry(backoff+jitter) + graceful terminal failure.
//!
//! 테스트 가능 seam: 순수 함수(sendMessage payload 빌드 / getUpdates 응답 파싱 / offset 전진) +
//! `MessengerProvider` 트레잇 fake로 송신/수신 오케스트레이션을 cargo test. 실 Telegram 송수신은
//! 사용자 관찰(실 네트워크/봇 없음 — Notion/GitHub/Calendar 선례). 메신저 추상화라 타 메신저 확장 여지.
//!
//! messenger.rs는 자체 `MessengerError`를 소유한다(calendar/github/notion 비공유) — 각 외부 모듈은
//! 자체 엔드포인트·재시도 관심사를 가지므로 모듈별 분리(선례: github≠notion≠calendar).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(12);
/// 한 송/수신 시도 내 재시도 횟수 캡 (INVARIANT #5: 무한 retry 금지).
const MAX_ATTEMPTS: u32 = 3;
/// backoff 기준 지연(첫 재시도). 실제 base*2^n + jitter.
const BASE_DELAY: Duration = Duration::from_millis(400);
/// getUpdates 서버측 long-poll 상한(초). bounded — 단발 호출이 무한히 매달리지 않게 짧게(#5).
const GET_UPDATES_TIMEOUT_SEC: u32 = 0;
/// 한 getUpdates에서 받을 update 최대 개수(bounded — 무한 누적 방지).
const GET_UPDATES_LIMIT: u32 = 50;

const TELEGRAM_API_BASE: &str = "https://api.telegram.org";

// ── 에러 분류 + bounded retry (calendar.rs/github.rs/notion.rs와 동일 패턴) ─────────────

/// 외부 호출 실패 분류. Transient = 재시도 대상(네트워크·429·5xx),
/// Terminal = 재시도 무의미(인증/권한/검증 등 4xx, 디코드 실패).
#[derive(Debug, Clone)]
pub enum MessengerError {
    Transient(String),
    Terminal(String),
}

impl std::fmt::Display for MessengerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MessengerError::Transient(m) => write!(f, "{m}"),
            MessengerError::Terminal(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for MessengerError {}

/// HTTP 상태코드 → 분류. 429/5xx는 일시적, 그 외 4xx는 영구.
fn classify_http(status: u16, body: &str) -> MessengerError {
    let snippet: String = body.chars().take(300).collect();
    if status == 429 || status >= 500 {
        MessengerError::Transient(format!("HTTP {status}: {snippet}"))
    } else {
        MessengerError::Terminal(format!("HTTP {status}: {snippet}"))
    }
}

/// reqwest 전송 에러 → 분류. 네트워크/타임아웃은 일시적, 디코드 실패는 영구.
/// **토큰 누출 방지(INVARIANT — 토큰 렌더러 미노출):** Telegram은 봇 토큰을 URL 경로(`/bot{token}/`)에
/// 담고 reqwest 에러 Display는 그 URL을 포함한다. `e.to_string()`을 그대로 쓰면 타임아웃/연결 실패
/// 메시지에 토큰이 섞여 렌더러까지 전파된다 → `without_url()`로 URL을 제거한 메시지만 노출한다.
fn classify_reqwest(e: reqwest::Error) -> MessengerError {
    let is_decode = e.is_decode();
    let safe = e.without_url().to_string();
    if is_decode {
        MessengerError::Terminal(format!("decode error: {safe}"))
    } else {
        MessengerError::Transient(safe)
    }
}

/// base_delay 기반 소량 jitter(0..base). rand 의존성 없이 시스템 클록 nanos에서 파생한다.
fn jitter(base: Duration) -> Duration {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    base.mul_f64((nanos % 997) as f64 / 997.0)
}

/// bounded retry (INVARIANT #5): Terminal은 즉시 반환(재시도 0), Transient만 backoff+jitter 후
/// 재시도하며 max_attempts 소진 시 마지막 Transient를 노출한다. base_delay는 테스트 고속화용 인자.
pub async fn with_retry<T, F, Fut>(
    max_attempts: u32,
    base_delay: Duration,
    mut op: F,
) -> Result<T, MessengerError>
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Result<T, MessengerError>>,
{
    let mut attempt = 0u32;
    loop {
        match op(attempt).await {
            Ok(v) => return Ok(v),
            Err(MessengerError::Terminal(m)) => return Err(MessengerError::Terminal(m)),
            Err(MessengerError::Transient(m)) => {
                attempt += 1;
                if attempt >= max_attempts {
                    return Err(MessengerError::Transient(m));
                }
                let backoff = base_delay.saturating_mul(2u32.saturating_pow(attempt - 1));
                tokio::time::sleep(backoff + jitter(base_delay)).await;
            }
        }
    }
}

// ── 순수 헬퍼 (단위 테스트 대상) ───────────────────────────────────────────────────

/// 수신 메시지 한 건(getUpdates 파싱 결과). 토큰 미포함.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingMessage {
    /// Telegram update_id. offset 전진/ dedup 기준.
    pub update_id: i64,
    /// 메시지 본문(text 없는 update는 빈 문자열).
    pub text: String,
}

/// sendMessage 요청 본문(JSON). chat_id + text. 순수 — 단위 테스트 대상.
/// chat_id는 숫자/문자열 둘 다 가능(@channel 등) → 문자열로 보낸다(Telegram이 관용 파싱).
pub fn build_send_payload(chat_id: &str, text: &str) -> serde_json::Value {
    serde_json::json!({ "chat_id": chat_id, "text": text })
}

/// getUpdates 응답(JSON) → (수신 메시지들, 다음 offset). update_id 오름차순, text 없는 update는
/// 빈 text로 포함(채널 post·edited 등도 offset은 전진해야 재수신을 막는다). 순수 — 단위 테스트 대상.
///
/// 다음 offset = max(update_id)+1. update가 없으면 기존 offset 유지(전진 없음). Telegram getUpdates
/// 규약: offset보다 작은 update_id는 confirmed로 간주돼 다시 안 온다 → max+1로 전진하면 멱등 소비.
pub fn parse_updates(body: &serde_json::Value, current_offset: i64) -> (Vec<IncomingMessage>, i64) {
    let mut msgs = Vec::new();
    let mut max_update = current_offset - 1; // update가 없으면 +1 했을 때 current_offset 그대로.
    if let Some(items) = body.get("result").and_then(|r| r.as_array()) {
        for it in items {
            let Some(update_id) = it.get("update_id").and_then(|v| v.as_i64()) else {
                continue;
            };
            if update_id > max_update {
                max_update = update_id;
            }
            // message.text(없으면 channel_post.text). 둘 다 없으면 빈 text(offset만 전진).
            let text = it
                .get("message")
                .and_then(|m| m.get("text"))
                .or_else(|| it.get("channel_post").and_then(|m| m.get("text")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            msgs.push(IncomingMessage { update_id, text });
        }
    }
    // update_id 오름차순 정렬(서버가 정렬해 주지만 방어적).
    msgs.sort_by_key(|m| m.update_id);
    (msgs, max_update + 1)
}

/// getUpdates 응답에서 실 사용자 chat 후보를 추출하는 순수 헬퍼.
/// detect_hermes_chat_id가 "내 chat_id 감지"를 위해 쓴다. update_id 오름차순 반환.
/// 봇 토큰 미포함 — chat_id·라벨·from.is_bot만 노출한다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatCandidate {
    /// Telegram chat.id (숫자 → 문자열).
    pub chat_id: String,
    /// 사람이 읽을 라벨(title / username / first_name 우선순위 폴백, 없으면 chat_id).
    pub label: String,
    /// 발신자(message.from)가 봇인지 여부(default false — from 필드 없으면 false).
    pub from_is_bot: bool,
}

/// getUpdates 응답(JSON) → ChatCandidate 목록. update_id 오름차순.
/// message / channel_post 둘 다 처리. chat.id 없는 update는 스킵.
/// 봇 토큰 미포함 — 순수 파싱 함수. 단위 테스트 대상.
pub fn parse_chat_candidates(body: &serde_json::Value) -> Vec<ChatCandidate> {
    let Some(items) = body.get("result").and_then(|r| r.as_array()) else {
        return Vec::new();
    };

    let mut candidates: Vec<(i64, ChatCandidate)> = Vec::new();

    for it in items {
        let update_id = it.get("update_id").and_then(|v| v.as_i64()).unwrap_or(0);

        // message 또는 channel_post에서 chat 추출.
        let chat_obj = it
            .get("message")
            .and_then(|m| m.get("chat"))
            .or_else(|| it.get("channel_post").and_then(|m| m.get("chat")));

        let Some(chat) = chat_obj else {
            continue;
        };

        let chat_id_num = chat.get("id").and_then(|v| v.as_i64());
        let Some(id_num) = chat_id_num else {
            continue;
        };
        let chat_id = id_num.to_string();

        // 사람이 읽을 라벨: title(그룹/채널) → username → first_name → chat_id.
        let label = chat
            .get("title")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                chat.get("username")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| {
                chat.get("first_name")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or(&chat_id)
            .to_string();

        // message.from.is_bot (봇 발신자 여부). channel_post는 from 없으므로 false.
        let from_is_bot = it
            .get("message")
            .and_then(|m| m.get("from"))
            .and_then(|f| f.get("is_bot"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        candidates.push((
            update_id,
            ChatCandidate {
                chat_id,
                label,
                from_is_bot,
            },
        ));
    }

    // update_id 오름차순 정렬(서버가 정렬해 주지만 방어적).
    candidates.sort_by_key(|(uid, _)| *uid);
    candidates.into_iter().map(|(_, c)| c).collect()
}

/// sendMessage 응답(JSON)에서 ok 여부 확인. ok=false면 description을 Terminal로(잘못된 chat_id 등). 순수.
pub fn parse_send_ok(body: &serde_json::Value) -> Result<(), MessengerError> {
    if body.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(())
    } else {
        let desc = body
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or("Telegram sendMessage 실패");
        Err(MessengerError::Terminal(desc.to_string()))
    }
}

/// detect_hermes_chat_id 전용 단발 헬퍼. offset=0으로 getUpdates를 한 번 호출해 ChatCandidate
/// 목록을 반환한다. 저장된 오프셋을 읽거나 전진하지 않는다(fetch_hermes_messages 불간섭, #5).
/// 봇 토큰은 URL 안에서만 잠시 쓰이고 반환·로깅 안 됨(INVARIANT). 순수 I/O — 단발·bounded.
pub async fn fetch_chat_candidates(bot_token: &str) -> Result<Vec<ChatCandidate>, MessengerError> {
    let provider = HttpMessengerProvider::new()?;
    let url = HttpMessengerProvider::method_url(bot_token, "getUpdates");
    // offset=0: 저장된 오프셋 무관하게 최근 업데이트를 가져온다(Telegram은 최대 100개 보존).
    // limit + timeout으로 bounded — 무한 long-poll 아님(#5).
    let payload = serde_json::json!({
        "offset": 0i64,
        "limit": GET_UPDATES_LIMIT,
        "timeout": GET_UPDATES_TIMEOUT_SEC,
    });
    let json = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
        provider.post_json(&url, &payload)
    })
    .await?;
    Ok(parse_chat_candidates(&json))
}

/// detect_hermes_chat_id 후보 선택 결과. 순수 분리로 단위 테스트 가능.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChatSelection {
    /// from_is_bot=false인 가장 최신 후보.
    Found { chat_id: String, label: String },
    /// 후보는 있으나 전부 봇 발신.
    OnlyBots,
    /// 후보 없음(수신 메시지 없음).
    None,
}

/// 후보 목록(update_id 오름차순)에서 실 사용자 chat을 선택한다 — from_is_bot=false인 가장 최신
/// (마지막) 후보. 비었으면 None, 전부 봇이면 OnlyBots. 순수 — 단위 테스트 대상.
pub fn select_detected_chat(candidates: &[ChatCandidate]) -> ChatSelection {
    if candidates.is_empty() {
        return ChatSelection::None;
    }
    match candidates.iter().rev().find(|c| !c.from_is_bot) {
        Some(c) => ChatSelection::Found {
            chat_id: c.chat_id.clone(),
            label: c.label.clone(),
        },
        None => ChatSelection::OnlyBots,
    }
}

// ── 트레잇 seam (RPITIT, CalendarProvider/PrProvider 패턴) ───────────────────────────

/// 메신저 송신/수신 계약. 오케스트레이션(send/fetch + offset 전진)은 이 트레잇에만 의존 → fake로
/// cargo test. 실 HTTP는 HttpMessengerProvider(Telegram). 타 메신저는 이 트레잇을 다시 구현하면 된다.
pub trait MessengerProvider {
    /// chat_id로 텍스트 전송(sendMessage). bounded retry. 실패는 graceful terminal로 노출.
    fn send_message(
        &self,
        bot_token: &str,
        chat_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = Result<(), MessengerError>> + Send;

    /// offset 이후 새 update를 단발로 가져온다(getUpdates, **bounded** — 무한 long-poll 아님, #5).
    /// 반환: (새 메시지들, 다음 offset). 호출자가 offset을 영속하고 다음 호출에 넘긴다.
    fn get_updates(
        &self,
        bot_token: &str,
        offset: i64,
    ) -> impl std::future::Future<Output = Result<(Vec<IncomingMessage>, i64), MessengerError>> + Send;
}

/// 송신 오케스트레이션(트레잇 의존 → fake로 검증). 빈 텍스트는 Terminal로 막는다(검증).
pub async fn send_core<P: MessengerProvider>(
    provider: &P,
    bot_token: &str,
    chat_id: &str,
    text: &str,
) -> Result<(), MessengerError> {
    if text.trim().is_empty() {
        return Err(MessengerError::Terminal(
            "빈 메시지는 보낼 수 없습니다".into(),
        ));
    }
    provider.send_message(bot_token, chat_id, text).await
}

/// 수신 오케스트레이션(bounded 단발). offset 이후 update를 한 번 가져와 (메시지, 다음 offset) 반환.
/// 트레잇 의존 → fake로 검증. 무한 루프 없음 — 호출 cadence는 호출자(스케줄/버튼)가 정한다(#5).
pub async fn fetch_core<P: MessengerProvider>(
    provider: &P,
    bot_token: &str,
    offset: i64,
) -> Result<(Vec<IncomingMessage>, i64), MessengerError> {
    provider.get_updates(bot_token, offset).await
}

// ── 실 HTTP provider (reqwest, rustls) ────────────────────────────────────────────

/// 실제 Telegram Bot API provider. reqwest(rustls) + bounded retry.
pub struct HttpMessengerProvider {
    http: reqwest::Client,
}

impl HttpMessengerProvider {
    pub fn new() -> Result<Self, MessengerError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| MessengerError::Terminal(format!("client build: {e}")))?;
        Ok(Self { http })
    }

    /// `https://api.telegram.org/bot{token}/{method}` — 토큰은 URL 안에서만 잠시 쓰이고 새지 않는다.
    fn method_url(bot_token: &str, method: &str) -> String {
        format!("{TELEGRAM_API_BASE}/bot{bot_token}/{method}")
    }

    /// JSON body POST → JSON 1회. 200대가 아니면 분류된 에러.
    async fn post_json(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, MessengerError> {
        let resp = self
            .http
            .post(url)
            .json(body)
            .send()
            .await
            .map_err(classify_reqwest)?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(classify_http(status, &text));
        }
        serde_json::from_str(&text)
            .map_err(|e| MessengerError::Terminal(format!("telegram parse: {e}")))
    }
}

impl MessengerProvider for HttpMessengerProvider {
    async fn send_message(
        &self,
        bot_token: &str,
        chat_id: &str,
        text: &str,
    ) -> Result<(), MessengerError> {
        let url = Self::method_url(bot_token, "sendMessage");
        let payload = build_send_payload(chat_id, text);
        let json = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| self.post_json(&url, &payload)).await?;
        parse_send_ok(&json)
    }

    async fn get_updates(
        &self,
        bot_token: &str,
        offset: i64,
    ) -> Result<(Vec<IncomingMessage>, i64), MessengerError> {
        let url = Self::method_url(bot_token, "getUpdates");
        // bounded: 명시 offset + limit + 짧은 server timeout. 무한 long-poll 아님(#5).
        let payload = serde_json::json!({
            "offset": offset,
            "limit": GET_UPDATES_LIMIT,
            "timeout": GET_UPDATES_TIMEOUT_SEC,
        });
        let json = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| self.post_json(&url, &payload)).await?;
        Ok(parse_updates(&json, offset))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 토큰 누출 방지(INVARIANT): 토큰이 든 URL로 실패한 요청의 분류 에러에 토큰이 섞이면 안 된다.
    /// 닫힌 포트(127.0.0.1:1)로 연결 실패를 유발 — reqwest 에러는 URL(토큰)을 품지만 classify가 제거해야 한다.
    #[tokio::test]
    async fn classify_reqwest_does_not_leak_token_from_url() {
        let token = "SECRET_BOT_TOKEN:AAAAbbbbCCCC";
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(300))
            .build()
            .unwrap();
        let url = format!("http://127.0.0.1:1/bot{token}/sendMessage");
        let err = client
            .get(&url)
            .send()
            .await
            .expect_err("연결이 실패해야 함(닫힌 포트)");
        // 사전조건: 가공 전 reqwest 에러엔 URL(토큰)이 들어있다 → 테스트가 무의미하지 않음을 보장.
        assert!(
            err.to_string().contains(token),
            "precondition: raw reqwest error should carry the token-bearing url"
        );
        let classified = classify_reqwest(err);
        assert!(
            !classified.to_string().contains(token),
            "classified error must NOT contain the token: {classified}"
        );
    }

    /// sendMessage 페이로드: chat_id + text.
    #[test]
    fn build_send_payload_has_chat_and_text() {
        let body = build_send_payload("123456", "deploy radar");
        assert_eq!(body["chat_id"], "123456");
        assert_eq!(body["text"], "deploy radar");
    }

    /// getUpdates 파싱: message.text 추출 + offset = max(update_id)+1, update_id 오름차순.
    #[test]
    fn parse_updates_extracts_messages_and_advances_offset() {
        let body = serde_json::json!({
            "ok": true,
            "result": [
                { "update_id": 11, "message": { "text": "first" } },
                { "update_id": 13, "message": { "text": "second" } }
            ]
        });
        let (msgs, next) = parse_updates(&body, 11);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].update_id, 11);
        assert_eq!(msgs[0].text, "first");
        assert_eq!(msgs[1].update_id, 13);
        assert_eq!(next, 14, "다음 offset = max(update_id)+1");
    }

    /// getUpdates 파싱: 빈 result면 offset 유지(전진 없음 — 멱등 재호출).
    #[test]
    fn parse_updates_empty_keeps_offset() {
        let body = serde_json::json!({ "ok": true, "result": [] });
        let (msgs, next) = parse_updates(&body, 42);
        assert!(msgs.is_empty());
        assert_eq!(next, 42, "update 없으면 offset 그대로");
    }

    /// getUpdates 파싱: text 없는 update(채널 post·미디어)는 빈 text로 포함하되 offset은 전진.
    #[test]
    fn parse_updates_textless_advances_offset() {
        let body = serde_json::json!({
            "ok": true,
            "result": [
                { "update_id": 5, "message": { "photo": [] } },
                { "update_id": 6, "channel_post": { "text": "from channel" } }
            ]
        });
        let (msgs, next) = parse_updates(&body, 5);
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].text, "", "text 없는 update는 빈 text");
        assert_eq!(msgs[1].text, "from channel", "channel_post.text 폴백");
        assert_eq!(next, 7);
    }

    /// getUpdates 파싱: 서버가 역순으로 줘도 update_id 오름차순 정렬 + update_id 없는 항목 스킵.
    #[test]
    fn parse_updates_sorts_and_skips_malformed() {
        let body = serde_json::json!({
            "ok": true,
            "result": [
                { "update_id": 9, "message": { "text": "later" } },
                { "no_update_id": true },
                { "update_id": 8, "message": { "text": "earlier" } }
            ]
        });
        let (msgs, next) = parse_updates(&body, 8);
        let ids: Vec<i64> = msgs.iter().map(|m| m.update_id).collect();
        assert_eq!(ids, vec![8, 9], "오름차순 + malformed 스킵");
        assert_eq!(next, 10);
    }

    // ── parse_chat_candidates 단위 테스트 ─────────────────────────────────────────

    /// 사람 발신 DM: from_is_bot=false, chat_id/label 정확히 추출.
    #[test]
    fn parse_chat_candidates_human_private_message() {
        let body = serde_json::json!({
            "ok": true,
            "result": [{
                "update_id": 1001,
                "message": {
                    "chat": { "id": 123456789, "first_name": "David", "type": "private" },
                    "from": { "id": 123456789, "is_bot": false, "first_name": "David" },
                    "text": "안녕"
                }
            }]
        });
        let cands = parse_chat_candidates(&body);
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].chat_id, "123456789");
        assert_eq!(cands[0].label, "David");
        assert!(!cands[0].from_is_bot);
    }

    /// 봇 발신 메시지: from_is_bot=true.
    #[test]
    fn parse_chat_candidates_bot_sender() {
        let body = serde_json::json!({
            "ok": true,
            "result": [{
                "update_id": 2001,
                "message": {
                    "chat": { "id": 987654321, "username": "mybot", "type": "private" },
                    "from": { "id": 987654321, "is_bot": true, "username": "mybot" },
                    "text": "I am a bot"
                }
            }]
        });
        let cands = parse_chat_candidates(&body);
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].chat_id, "987654321");
        assert_eq!(cands[0].label, "mybot");
        assert!(cands[0].from_is_bot);
    }

    /// 빈/garbage body: 빈 Vec 반환(패닉 없음).
    #[test]
    fn parse_chat_candidates_empty_or_garbage() {
        assert!(parse_chat_candidates(&serde_json::json!({})).is_empty());
        assert!(parse_chat_candidates(&serde_json::json!({"ok":true,"result":[]})).is_empty());
        assert!(parse_chat_candidates(&serde_json::json!("garbage")).is_empty());
        // chat.id 없는 update는 스킵.
        let no_id = serde_json::json!({"ok":true,"result":[{"update_id":1,"message":{"chat":{"type":"private"}}}]});
        assert!(parse_chat_candidates(&no_id).is_empty());
    }

    /// update_id 오름차순 정렬 + channel_post 처리.
    #[test]
    fn parse_chat_candidates_sorted_and_channel_post() {
        let body = serde_json::json!({
            "ok": true,
            "result": [
                {
                    "update_id": 20,
                    "channel_post": {
                        "chat": { "id": -100111, "title": "My Channel", "type": "channel" },
                        "text": "post"
                    }
                },
                {
                    "update_id": 10,
                    "message": {
                        "chat": { "id": 111, "first_name": "Alice", "type": "private" },
                        "from": { "id": 111, "is_bot": false, "first_name": "Alice" },
                        "text": "hi"
                    }
                }
            ]
        });
        let cands = parse_chat_candidates(&body);
        assert_eq!(cands.len(), 2);
        // update_id 10이 먼저(오름차순).
        assert_eq!(cands[0].chat_id, "111");
        assert_eq!(cands[0].label, "Alice");
        assert!(!cands[0].from_is_bot);
        // channel_post: from 없으므로 from_is_bot=false, label=title.
        assert_eq!(cands[1].chat_id, "-100111");
        assert_eq!(cands[1].label, "My Channel");
        assert!(!cands[1].from_is_bot);
    }

    fn cand(chat_id: &str, label: &str, from_is_bot: bool) -> ChatCandidate {
        ChatCandidate {
            chat_id: chat_id.into(),
            label: label.into(),
            from_is_bot,
        }
    }

    /// 선택: 비었으면 None, 전부 봇이면 OnlyBots, 사람 있으면 가장 최신(마지막) 비-봇.
    #[test]
    fn select_detected_chat_cases() {
        assert_eq!(select_detected_chat(&[]), ChatSelection::None);
        assert_eq!(
            select_detected_chat(&[cand("1", "BotA", true), cand("2", "BotB", true)]),
            ChatSelection::OnlyBots
        );
        // 후보는 update_id 오름차순 → 마지막 비-봇이 가장 최신. 봇 후보는 건너뛴다.
        let picked = select_detected_chat(&[
            cand("111", "Alice", false),
            cand("222", "Carol", false),
            cand("999", "BotZ", true),
        ]);
        assert_eq!(
            picked,
            ChatSelection::Found {
                chat_id: "222".into(),
                label: "Carol".into()
            }
        );
    }

    /// send 응답: ok=true면 Ok, ok=false면 description을 Terminal로.
    #[test]
    fn parse_send_ok_cases() {
        assert!(parse_send_ok(&serde_json::json!({ "ok": true, "result": {} })).is_ok());
        let bad = serde_json::json!({ "ok": false, "description": "chat not found" });
        match parse_send_ok(&bad) {
            Err(MessengerError::Terminal(m)) => assert_eq!(m, "chat not found"),
            other => panic!("expected Terminal, got {other:?}"),
        }
    }

    /// HTTP 분류: 429/5xx=Transient, 그 외 4xx=Terminal.
    #[test]
    fn classify_http_buckets() {
        assert!(matches!(
            classify_http(429, "rate"),
            MessengerError::Transient(_)
        ));
        assert!(matches!(
            classify_http(502, "bad gw"),
            MessengerError::Transient(_)
        ));
        assert!(matches!(
            classify_http(401, "unauthorized"),
            MessengerError::Terminal(_)
        ));
        assert!(matches!(
            classify_http(400, "bad request"),
            MessengerError::Terminal(_)
        ));
    }

    // ── 트레잇 seam: send_core / fetch_core (fake provider) ──────────────────────────

    use std::sync::Mutex;

    // 트레잇 future가 Send라 RefCell(non-Sync) 대신 Mutex로 기록(검증용 상태).
    struct FakeProvider {
        send: Result<(), MessengerError>,
        updates: Result<(Vec<IncomingMessage>, i64), MessengerError>,
        /// send_message가 받은 (chat_id, text) 기록(검증용).
        sent: Mutex<Vec<(String, String)>>,
        /// get_updates가 받은 offset 기록(검증용).
        requested_offset: Mutex<Vec<i64>>,
    }

    impl Default for FakeProvider {
        fn default() -> Self {
            FakeProvider {
                send: Ok(()),
                updates: Ok((Vec::new(), 0)),
                sent: Mutex::new(Vec::new()),
                requested_offset: Mutex::new(Vec::new()),
            }
        }
    }

    impl MessengerProvider for FakeProvider {
        async fn send_message(
            &self,
            _bot_token: &str,
            chat_id: &str,
            text: &str,
        ) -> Result<(), MessengerError> {
            self.sent
                .lock()
                .unwrap()
                .push((chat_id.to_string(), text.to_string()));
            self.send.clone()
        }
        async fn get_updates(
            &self,
            _bot_token: &str,
            offset: i64,
        ) -> Result<(Vec<IncomingMessage>, i64), MessengerError> {
            self.requested_offset.lock().unwrap().push(offset);
            self.updates.clone()
        }
    }

    /// send_core: 텍스트가 그대로 provider로 전달된다.
    #[tokio::test]
    async fn send_core_forwards_text() {
        let provider = FakeProvider::default();
        send_core(&provider, "tok", "999", "hello hermes")
            .await
            .unwrap();
        assert_eq!(
            provider.sent.lock().unwrap().as_slice(),
            &[("999".to_string(), "hello hermes".to_string())]
        );
    }

    /// send_core: 빈/공백 텍스트는 provider 호출 없이 Terminal로 막힌다.
    #[tokio::test]
    async fn send_core_rejects_empty() {
        let provider = FakeProvider::default();
        let r = send_core(&provider, "tok", "999", "   ").await;
        assert!(matches!(r, Err(MessengerError::Terminal(_))));
        assert!(
            provider.sent.lock().unwrap().is_empty(),
            "빈 메시지는 전송 안 함"
        );
    }

    /// fetch_core: offset을 provider에 넘기고 (메시지, 다음 offset)을 그대로 반환.
    #[tokio::test]
    async fn fetch_core_passes_offset_and_returns_updates() {
        let provider = FakeProvider {
            updates: Ok((
                vec![IncomingMessage {
                    update_id: 100,
                    text: "reply".into(),
                }],
                101,
            )),
            ..Default::default()
        };
        let (msgs, next) = fetch_core(&provider, "tok", 100).await.unwrap();
        assert_eq!(provider.requested_offset.lock().unwrap().as_slice(), &[100]);
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].text, "reply");
        assert_eq!(next, 101);
    }

    /// fetch_core: provider terminal 실패는 그대로 전파(graceful 노출).
    #[tokio::test]
    async fn fetch_core_propagates_terminal() {
        let provider = FakeProvider {
            updates: Err(MessengerError::Terminal("401: bot token invalid".into())),
            ..Default::default()
        };
        let r = fetch_core(&provider, "tok", 0).await;
        assert!(matches!(r, Err(MessengerError::Terminal(_))));
    }
}
