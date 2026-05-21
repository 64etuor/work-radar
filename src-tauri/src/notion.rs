//! Notion REST 클라이언트 (write 레일, Phase 3). INVARIANT: 외부 호출은 Rust에,
//! 토큰은 인자로만 들어오고 본문은 반환하지 않는다.
//!
//! 핵심 규칙:
//!  - rate-limit 인지: Notion ~3 req/s → `RateLimiter`로 요청 간 최소 간격 pacing (SSOT §6).
//!  - bounded retry only (INVARIANT #5): `with_retry`는 시도 횟수 캡 + 지수 backoff + jitter,
//!    terminal(4xx, 429 제외)은 재시도하지 않고, 소진 시 terminal failure를 노출한다.
//!  - 페이지 매핑은 스키마 가정 최소화: title 타입 속성명을 DB read로 발견하고 그 속성만 채운다.
//!
//! 테스트 가능 seam: 승격 코어는 `NotionWriter` 트레잇에만 의존한다(commands.rs). 단위 테스트는
//! fake writer로 lifecycle을, `with_retry`/분류/속성발견은 순수 로직으로 검증한다(실 네트워크 없음).

use std::collections::HashMap;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tokio::sync::Mutex;

const NOTION_BASE: &str = "https://api.notion.com/v1";
const NOTION_VERSION: &str = "2022-06-28";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 한 승격 시도 내 재시도 횟수 캡 (INVARIANT #5: 무한 retry 금지).
const MAX_ATTEMPTS: u32 = 3;
/// backoff 기준 지연(첫 재시도). 실제 base*2^n + jitter.
const BASE_DELAY: Duration = Duration::from_millis(400);
/// Notion rate limit(~3 req/s) 대비 요청 간 최소 간격.
const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(350);

/// 외부 write 실패 분류. Transient = 재시도/큐잉 대상(네트워크·429·5xx),
/// Terminal = 재시도 무의미(인증/권한/검증 등 4xx). 큐 전이는 commands.rs가 결정한다.
#[derive(Debug, Clone)]
pub enum NotionError {
    Transient(String),
    Terminal(String),
}

impl std::fmt::Display for NotionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NotionError::Transient(m) => write!(f, "{m}"),
            NotionError::Terminal(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for NotionError {}

/// 생성된 Notion 페이지. url은 "Notion에서 열기" 딥링크에 쓰인다.
#[derive(Debug, Clone)]
pub struct CreatedPage {
    pub id: String,
    pub url: String,
}

/// 승격 코어가 의존하는 유일한 외부 write 계약. 테스트는 fake로 대체한다.
/// (RPITIT — async fn in trait. async_trait 의존성 없이 제네릭으로만 소비한다.)
pub trait NotionWriter {
    /// `db_id` 데이터베이스에 `title`만 채운 페이지를 만든다. token은 호출자가 keychain에서 읽어 넘긴다.
    fn create_page(
        &self,
        token: &str,
        db_id: &str,
        title: &str,
    ) -> impl std::future::Future<Output = Result<CreatedPage, NotionError>> + Send;
}

/// HTTP 상태코드 → 분류. 429/5xx는 일시적, 그 외 4xx는 영구.
fn classify_http(status: u16, body: &str) -> NotionError {
    let snippet: String = body.chars().take(300).collect();
    if status == 429 || status >= 500 {
        NotionError::Transient(format!("HTTP {status}: {snippet}"))
    } else {
        NotionError::Terminal(format!("HTTP {status}: {snippet}"))
    }
}

/// reqwest 전송 에러 → 분류. 네트워크/타임아웃은 일시적, 디코드 실패는 영구.
fn classify_reqwest(e: &reqwest::Error) -> NotionError {
    if e.is_decode() {
        NotionError::Terminal(format!("decode error: {e}"))
    } else {
        // connect/timeout/request 등 네트워크 계열 → 재시도/큐잉.
        NotionError::Transient(e.to_string())
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
) -> Result<T, NotionError>
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Result<T, NotionError>>,
{
    let mut attempt = 0u32;
    loop {
        match op(attempt).await {
            Ok(v) => return Ok(v),
            Err(NotionError::Terminal(m)) => return Err(NotionError::Terminal(m)),
            Err(NotionError::Transient(m)) => {
                attempt += 1;
                if attempt >= max_attempts {
                    return Err(NotionError::Transient(m));
                }
                let backoff = base_delay.saturating_mul(2u32.saturating_pow(attempt - 1));
                tokio::time::sleep(backoff + jitter(base_delay)).await;
            }
        }
    }
}

/// 데이터베이스 스키마에서 title 타입 속성명을 찾는다(스키마 가정 최소화). 없으면 None.
pub(crate) fn find_title_prop(database: &serde_json::Value) -> Option<String> {
    database
        .get("properties")?
        .as_object()?
        .iter()
        .find(|(_, v)| v.get("type").and_then(|t| t.as_str()) == Some("title"))
        .map(|(k, _)| k.clone())
}

/// 요청 간 최소 간격을 강제하는 단순 pacing(rate-limit 인지). 동시 호출은 직렬화된다.
struct RateLimiter {
    last: Mutex<Option<Instant>>,
    min_interval: Duration,
}

impl RateLimiter {
    fn new(min_interval: Duration) -> Self {
        Self {
            last: Mutex::new(None),
            min_interval,
        }
    }

    /// 직전 요청으로부터 min_interval이 지날 때까지 대기한 뒤 타임스탬프를 갱신한다.
    async fn acquire(&self) {
        let mut last = self.last.lock().await;
        if let Some(prev) = *last {
            let elapsed = prev.elapsed();
            if elapsed < self.min_interval {
                tokio::time::sleep(self.min_interval - elapsed).await;
            }
        }
        *last = Some(Instant::now());
    }
}

/// 실제 Notion REST writer. reqwest(rustls) + rate limiter + title 속성명 캐시.
pub struct HttpNotionWriter {
    http: reqwest::Client,
    limiter: RateLimiter,
    /// db_id → title 속성명 캐시(flush 시 반복 read로 rate limit 낭비 방지).
    title_props: Mutex<HashMap<String, String>>,
}

impl HttpNotionWriter {
    pub fn new() -> Result<Self, NotionError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| NotionError::Terminal(format!("client build: {e}")))?;
        Ok(Self {
            http,
            limiter: RateLimiter::new(MIN_REQUEST_INTERVAL),
            title_props: Mutex::new(HashMap::new()),
        })
    }

    /// title 속성명을 캐시에서 얻거나 DB read로 발견한다(bounded retry).
    async fn title_prop(&self, token: &str, db_id: &str) -> Result<String, NotionError> {
        if let Some(name) = self.title_props.lock().await.get(db_id).cloned() {
            return Ok(name);
        }
        let name = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
            self.fetch_title_prop(token, db_id)
        })
        .await?;
        self.title_props
            .lock()
            .await
            .insert(db_id.to_string(), name.clone());
        Ok(name)
    }

    async fn fetch_title_prop(&self, token: &str, db_id: &str) -> Result<String, NotionError> {
        self.limiter.acquire().await;
        let resp = self
            .http
            .get(format!("{NOTION_BASE}/databases/{db_id}"))
            .bearer_auth(token)
            .header("Notion-Version", NOTION_VERSION)
            .send()
            .await
            .map_err(|e| classify_reqwest(&e))?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(classify_http(status, &body));
        }
        let json: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| NotionError::Terminal(format!("db parse: {e}")))?;
        find_title_prop(&json)
            .ok_or_else(|| NotionError::Terminal("database has no title property".into()))
    }

    async fn post_page(
        &self,
        token: &str,
        db_id: &str,
        title_prop: &str,
        title: &str,
    ) -> Result<CreatedPage, NotionError> {
        self.limiter.acquire().await;
        let payload = serde_json::json!({
            "parent": { "database_id": db_id },
            "properties": {
                title_prop: { "title": [ { "text": { "content": title } } ] }
            }
        });
        let resp = self
            .http
            .post(format!("{NOTION_BASE}/pages"))
            .bearer_auth(token)
            .header("Notion-Version", NOTION_VERSION)
            .json(&payload)
            .send()
            .await
            .map_err(|e| classify_reqwest(&e))?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(classify_http(status, &body));
        }
        let json: serde_json::Value = serde_json::from_str(&body)
            .map_err(|e| NotionError::Terminal(format!("page parse: {e}")))?;
        let id = json
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| NotionError::Terminal("page response missing id".into()))?
            .to_string();
        // url이 없으면 id로 폴백 URL 구성(딥링크용).
        let url = json
            .get("url")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| format!("https://www.notion.so/{}", id.replace('-', "")));
        Ok(CreatedPage { id, url })
    }
}

impl NotionWriter for HttpNotionWriter {
    async fn create_page(
        &self,
        token: &str,
        db_id: &str,
        title: &str,
    ) -> Result<CreatedPage, NotionError> {
        let title_prop = self.title_prop(token, db_id).await?;
        with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
            self.post_page(token, db_id, &title_prop, title)
        })
        .await
    }
}

// ── Notion read (백로그 상태 미러, Phase 6 mismatch) ──────────────────────────────
//
// Phase 3는 write만 했고 read 미러가 없었다 → mismatch 비교용으로 백로그 DB의 페이지 상태를 read한다.
// 스키마 가정 최소화: 페이지마다 title 타입 속성을 제목으로(ticket 추출), status(없으면 select) 타입을
// 상태로 본다. bounded 페이지네이션(무한 poll 금지 — INVARIANT #5). 토큰은 인자로만, 반환하지 않는다.

/// 한 backlog 페이지의 관측 상태 (drift 비교용). 내부 타입 — TS export 아님.
#[derive(Debug, Clone)]
pub struct NotionPageState {
    pub page_id: String,
    pub url: String,
    /// 제목(title 타입 속성의 plain_text 연결). ticket 추출 입력.
    pub title: String,
    /// status(우선) 또는 select 타입 속성값 이름. 미설정이면 None.
    pub status: Option<String>,
}

/// mismatch 코어가 의존하는 유일한 외부 read 계약. 테스트는 fake로 대체한다.
/// (RPITIT — async fn in trait. async_trait 의존성 없이 제네릭으로만 소비한다.)
pub trait NotionReader {
    /// `db_id` 백로그의 페이지 상태들을 가져온다(bounded 페이지네이션 내부 처리). token은 호출자가 keychain에서.
    fn fetch_pages(
        &self,
        token: &str,
        db_id: &str,
    ) -> impl std::future::Future<Output = Result<Vec<NotionPageState>, NotionError>> + Send;
}

/// 페이지 query 페이지네이션 상한 (bounded — 무한 poll 금지). page_size 100 × 10 = 최대 1000건.
const MAX_QUERY_PAGES: u32 = 10;
const QUERY_PAGE_SIZE: u32 = 100;

/// 페이지 properties에서 title 타입 속성의 plain_text를 연결한다(스키마 가정 최소화). 없으면 None.
pub(crate) fn extract_page_title(props: &serde_json::Value) -> Option<String> {
    let obj = props.as_object()?;
    for v in obj.values() {
        if v.get("type").and_then(|t| t.as_str()) == Some("title") {
            let joined: String = v
                .get("title")
                .and_then(|t| t.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| t.get("plain_text").and_then(|p| p.as_str()))
                        .collect()
                })
                .unwrap_or_default();
            return Some(joined);
        }
    }
    None
}

/// 페이지 properties에서 상태 이름을 찾는다: status 타입 우선, 없으면 select. 둘 다 없거나 null이면 None.
pub(crate) fn extract_page_status(props: &serde_json::Value) -> Option<String> {
    let obj = props.as_object()?;
    let pick = |kind: &str, inner: &str| -> Option<String> {
        for v in obj.values() {
            if v.get("type").and_then(|t| t.as_str()) == Some(kind) {
                return v
                    .get(inner)
                    .and_then(|s| s.get("name"))
                    .and_then(|n| n.as_str())
                    .map(String::from);
            }
        }
        None
    };
    pick("status", "status").or_else(|| pick("select", "select"))
}

/// query 응답(JSON) → (페이지 상태들, next_cursor, has_more). 순수 — 테스트 가능.
pub(crate) fn parse_query_response(
    body: &serde_json::Value,
) -> (Vec<NotionPageState>, Option<String>, bool) {
    let mut states = Vec::new();
    if let Some(results) = body.get("results").and_then(|r| r.as_array()) {
        for page in results {
            let Some(page_id) = page.get("id").and_then(|i| i.as_str()) else {
                continue;
            };
            let url = page
                .get("url")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();
            let props = page
                .get("properties")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            states.push(NotionPageState {
                page_id: page_id.to_string(),
                url,
                title: extract_page_title(&props).unwrap_or_default(),
                status: extract_page_status(&props),
            });
        }
    }
    let next = body
        .get("next_cursor")
        .and_then(|c| c.as_str())
        .map(String::from);
    let has_more = body
        .get("has_more")
        .and_then(|h| h.as_bool())
        .unwrap_or(false);
    (states, next, has_more)
}

/// 실제 Notion REST reader. reqwest(rustls) + rate limiter. writer와 client는 분리(read 관심사).
pub struct HttpNotionReader {
    http: reqwest::Client,
    limiter: RateLimiter,
}

impl HttpNotionReader {
    pub fn new() -> Result<Self, NotionError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| NotionError::Terminal(format!("client build: {e}")))?;
        Ok(Self {
            http,
            limiter: RateLimiter::new(MIN_REQUEST_INTERVAL),
        })
    }

    /// 한 query 호출(rate-limit paced). cursor가 있으면 start_cursor로 이어 받는다.
    async fn query_once(
        &self,
        token: &str,
        db_id: &str,
        cursor: Option<&str>,
    ) -> Result<serde_json::Value, NotionError> {
        self.limiter.acquire().await;
        let mut payload = serde_json::json!({ "page_size": QUERY_PAGE_SIZE });
        if let Some(c) = cursor {
            payload["start_cursor"] = serde_json::Value::String(c.to_string());
        }
        let resp = self
            .http
            .post(format!("{NOTION_BASE}/databases/{db_id}/query"))
            .bearer_auth(token)
            .header("Notion-Version", NOTION_VERSION)
            .json(&payload)
            .send()
            .await
            .map_err(|e| classify_reqwest(&e))?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if !(200..300).contains(&status) {
            return Err(classify_http(status, &body));
        }
        serde_json::from_str(&body).map_err(|e| NotionError::Terminal(format!("query parse: {e}")))
    }
}

impl NotionReader for HttpNotionReader {
    async fn fetch_pages(
        &self,
        token: &str,
        db_id: &str,
    ) -> Result<Vec<NotionPageState>, NotionError> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        let mut completed = false;
        for _ in 0..MAX_QUERY_PAGES {
            let json = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| {
                self.query_once(token, db_id, cursor.as_deref())
            })
            .await?;
            let (mut states, next, has_more) = parse_query_response(&json);
            out.append(&mut states);
            if !has_more {
                completed = true;
                break;
            }
            match next {
                Some(c) => cursor = Some(c),
                None => break, // has_more인데 cursor 없음 → 불완전(아래에서 Err).
            }
        }
        // 상한 초과/cursor 누락으로 전체를 못 받았으면 anchor로 신뢰 불가 → terminal failure 노출.
        // (조용히 잘리면 mismatch 코어가 "ticket이 Notion에서 사라짐"으로 오인해 false auto-resolve 가능.)
        if !completed {
            return Err(NotionError::Terminal(format!(
                "백로그 페이지네이션 상한 초과(>{MAX_QUERY_PAGES}페이지) — mismatch 감지 불완전"
            )));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// (a) transient 몇 번 후 성공 — 정확한 시도 횟수.
    #[tokio::test]
    async fn with_retry_succeeds_after_transient() {
        let calls = AtomicU32::new(0);
        let r: Result<u32, NotionError> = with_retry(5, Duration::from_millis(1), |_| {
            let n = calls.fetch_add(1, Ordering::Relaxed);
            async move {
                if n < 2 {
                    Err(NotionError::Transient("net".into()))
                } else {
                    Ok(42)
                }
            }
        })
        .await;
        assert_eq!(r.unwrap(), 42);
        assert_eq!(calls.load(Ordering::Relaxed), 3, "2번 실패 후 3번째 성공");
    }

    /// (b) 계속 transient면 max_attempts 소진 후 Transient 노출(무한 retry 아님).
    #[tokio::test]
    async fn with_retry_gives_up_after_max() {
        let calls = AtomicU32::new(0);
        let r: Result<u32, NotionError> = with_retry(3, Duration::from_millis(1), |_| {
            calls.fetch_add(1, Ordering::Relaxed);
            async { Err(NotionError::Transient("429".into())) }
        })
        .await;
        assert!(matches!(r, Err(NotionError::Transient(_))));
        assert_eq!(
            calls.load(Ordering::Relaxed),
            3,
            "정확히 max_attempts회만 시도"
        );
    }

    /// (c) Terminal은 재시도하지 않는다(즉시 반환, 1회).
    #[tokio::test]
    async fn with_retry_does_not_retry_terminal() {
        let calls = AtomicU32::new(0);
        let r: Result<u32, NotionError> = with_retry(5, Duration::from_millis(1), |_| {
            calls.fetch_add(1, Ordering::Relaxed);
            async { Err(NotionError::Terminal("400 bad".into())) }
        })
        .await;
        assert!(matches!(r, Err(NotionError::Terminal(_))));
        assert_eq!(calls.load(Ordering::Relaxed), 1, "terminal은 1회만");
    }

    /// HTTP 분류: 429/5xx=Transient, 그 외 4xx=Terminal.
    #[test]
    fn classify_http_buckets() {
        assert!(matches!(
            classify_http(429, "rate"),
            NotionError::Transient(_)
        ));
        assert!(matches!(
            classify_http(503, "down"),
            NotionError::Transient(_)
        ));
        assert!(matches!(
            classify_http(400, "bad"),
            NotionError::Terminal(_)
        ));
        assert!(matches!(
            classify_http(401, "auth"),
            NotionError::Terminal(_)
        ));
        assert!(matches!(
            classify_http(404, "no db"),
            NotionError::Terminal(_)
        ));
    }

    /// 스키마에서 title 타입 속성명을 발견(이름/언어 무관, type='title' 기준).
    #[test]
    fn find_title_prop_picks_title_type() {
        let db = serde_json::json!({
            "properties": {
                "상태": { "id": "a", "type": "select" },
                "이름": { "id": "title", "type": "title" },
                "마감": { "id": "d", "type": "date" }
            }
        });
        assert_eq!(find_title_prop(&db).as_deref(), Some("이름"));

        let no_title = serde_json::json!({ "properties": { "x": { "type": "select" } } });
        assert!(find_title_prop(&no_title).is_none());
    }

    /// 페이지 properties에서 title 타입 plain_text 연결 (이름/언어 무관).
    #[test]
    fn extract_page_title_joins_plain_text() {
        let props = serde_json::json!({
            "상태": { "type": "status", "status": { "name": "In progress" } },
            "이름": { "type": "title", "title": [
                { "plain_text": "MIR-DEV-7 " }, { "plain_text": "로그인 버그" }
            ] }
        });
        assert_eq!(
            extract_page_title(&props).as_deref(),
            Some("MIR-DEV-7 로그인 버그")
        );
        let no_title = serde_json::json!({ "x": { "type": "select", "select": { "name": "A" } } });
        assert!(extract_page_title(&no_title).is_none());
    }

    /// 상태 추출: status 타입 우선 > select, null/미설정은 None.
    #[test]
    fn extract_page_status_prefers_status_then_select() {
        let with_status = serde_json::json!({
            "Status": { "type": "status", "status": { "name": "Done" } },
            "Tag": { "type": "select", "select": { "name": "blue" } }
        });
        assert_eq!(extract_page_status(&with_status).as_deref(), Some("Done"));

        let only_select = serde_json::json!({
            "상태": { "type": "select", "select": { "name": "완료" } }
        });
        assert_eq!(extract_page_status(&only_select).as_deref(), Some("완료"));

        // status가 null(미설정)이면 None.
        let null_status = serde_json::json!({
            "Status": { "type": "status", "status": serde_json::Value::Null }
        });
        assert!(extract_page_status(&null_status).is_none());

        let no_status = serde_json::json!({ "이름": { "type": "title", "title": [] } });
        assert!(extract_page_status(&no_status).is_none());
    }

    /// query 응답 파싱: 페이지 목록 + 페이지네이션(next_cursor/has_more).
    #[test]
    fn parse_query_response_extracts_pages_and_cursor() {
        let body = serde_json::json!({
            "results": [
                {
                    "id": "page-1",
                    "url": "https://notion.so/page-1",
                    "properties": {
                        "Name": { "type": "title", "title": [ { "plain_text": "MIR-DEV-7 버그" } ] },
                        "Status": { "type": "status", "status": { "name": "In progress" } }
                    }
                },
                {
                    "id": "page-2",
                    "url": "https://notion.so/page-2",
                    "properties": {
                        "Name": { "type": "title", "title": [ { "plain_text": "잡일" } ] },
                        "Status": { "type": "status", "status": { "name": "Done" } }
                    }
                }
            ],
            "next_cursor": "cur-xyz",
            "has_more": true
        });
        let (states, next, has_more) = parse_query_response(&body);
        assert_eq!(states.len(), 2);
        assert_eq!(states[0].page_id, "page-1");
        assert_eq!(states[0].title, "MIR-DEV-7 버그");
        assert_eq!(states[0].status.as_deref(), Some("In progress"));
        assert_eq!(states[1].status.as_deref(), Some("Done"));
        assert_eq!(next.as_deref(), Some("cur-xyz"));
        assert!(has_more);

        // 빈 응답.
        let empty = serde_json::json!({ "results": [], "has_more": false });
        let (s, n, h) = parse_query_response(&empty);
        assert!(s.is_empty() && n.is_none() && !h);
    }
}
