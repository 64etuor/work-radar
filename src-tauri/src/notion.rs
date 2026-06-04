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
use std::time::{Duration, Instant};

use tokio::sync::Mutex;

use crate::external_actions::ExecOutcome;
use crate::retry::{with_retry, Retryable};

const NOTION_BASE: &str = "https://api.notion.com/v1";
/// Notion REST API 버전 헤더(`Notion-Version`)의 단일 출처. api.rs/commands::notion이 참조.
pub(crate) const NOTION_VERSION: &str = "2022-06-28";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// 한 승격 시도 내 재시도 횟수 캡 (INVARIANT #5: 무한 retry 금지).
const MAX_ATTEMPTS: u32 = 3;
/// backoff 기준 지연(첫 재시도). 실제 base*2^n + jitter.
const BASE_DELAY: Duration = Duration::from_millis(400);
/// Notion rate limit(~3 req/s) 대비 요청 간 최소 간격.
const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(350);

/// 외부 write 실패 분류. Transient = 재시도/큐잉 대상(네트워크·429·5xx),
/// Terminal = 재시도 무의미(인증/권한/검증 등 4xx 중 일반).
/// NotFound(404) = DB ID 오류 또는 통합 미공유 — 액션 가능 메시지 포함.
/// Forbidden(403) = 통합 권한 부족 — 액션 가능 메시지 포함.
/// 큐 전이는 commands.rs가 결정한다.
#[derive(Debug, Clone, thiserror::Error)]
pub enum NotionError {
    #[error("{0}")]
    Transient(String),
    #[error("{0}")]
    Terminal(String),
    /// 404: DB ID가 잘못됐거나 통합이 해당 DB에 공유되지 않음.
    #[error("{0}")]
    NotFound(String),
    /// 403: 통합 권한 부족.
    #[error("{0}")]
    Forbidden(String),
}

impl Retryable for NotionError {
    fn is_retryable(&self) -> bool {
        matches!(self, NotionError::Transient(_))
    }
}

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

/// HTTP 상태코드 → 분류.
/// - 404 → NotFound (DB ID 오류 또는 통합 미공유 — Notion은 unshared도 404 반환).
/// - 403 → Forbidden (통합 권한 부족).
/// - 429/5xx → Transient (재시도 대상).
/// - 그 외 4xx → Terminal (영구 실패).
fn classify_http(status: u16, body: &str) -> NotionError {
    // 외부 응답 본문은 사용자 콘텐츠/PII 가능 → 메시지·로그에 내용을 넣지 않는다(스펙 §5.5). 크기만 노출.
    let body_len = body.len();
    match status {
        404 => NotionError::NotFound(
            "DB를 찾을 수 없음 — ID가 맞는지, 그리고 통합(integration)이 이 DB에 공유됐는지 확인 (HTTP 404)".into(),
        ),
        403 => NotionError::Forbidden("권한 없음 — 통합 권한 확인 (HTTP 403)".into()),
        429 | 500..=599 => NotionError::Transient(format!("HTTP {status} (응답 {body_len}B)")),
        _ => NotionError::Terminal(format!("HTTP {status} (응답 {body_len}B)")),
    }
}

/// 단발 DB 접근 테스트 — rate limiter 없음(연결 점검 일회용, pacing 불필요).
/// 성공 시 title 속성명을, 속성 없으면 `(title 속성 없음)` 문구를 반환한다.
/// HTTP 구성/분류를 도메인 모듈 안에서 한 곳에 모아 commands 층의 인라인 reqwest를 제거한다.
pub async fn probe_database(token: &str, db_id: &str) -> Result<String, NotionError> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|e| NotionError::Terminal(format!("client build: {e}")))?;
    let resp = client
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
    let json: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| NotionError::Terminal(format!("db parse: {e}")))?;
    Ok(find_title_prop(&json).unwrap_or_else(|| "(title 속성 없음)".into()))
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

/// Notion DB ID/URL을 정규화해 표준 dashed UUID(8-4-4-4-12)로 반환한다.
///
/// - 순수 32-hex(대소문자 무관, 대시 포함/제외 모두 허용) → 정규화.
/// - URL(`https://www.notion.so/…`) → 경로에서 마지막 32-hex 런 추출 후 정규화.
/// - 뷰 링크(`?v=…`)나 타이틀-슬러그(`Title-<id>`) 모두 처리.
/// - 32-hex가 없거나 형식 불일치 → Err (안내 메시지 포함).
pub fn normalize_notion_db_id(input: &str) -> Result<String, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err(
            "Notion DB ID/URL을 확인하세요 — 뷰(?v=) 링크가 아닌 데이터베이스 링크를 사용하세요."
                .into(),
        );
    }

    // URL이면 경로 부분만 추출(? 이전).
    let path_part = if s.contains("://") || s.contains('/') {
        s.split('?').next().unwrap_or(s)
    } else {
        s
    };

    // 마지막 32-hex 런 추출. 대시 제거 후 연속 hex 문자를 구간으로 모은다.
    // Notion ID = 32 hex chars(대시 포함 시 36자 UUID, 미포함 시 32자 raw).
    let hex_only: String = path_part
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .collect();
    // 경로에 여러 hex 런이 있을 수 있다 — 마지막 32-hex 연속 블록을 찾는다.
    // 전략: hex_only의 마지막 32글자를 취한다(ID가 경로 끝에 옴).
    if hex_only.len() < 32 {
        return Err(
            "Notion DB ID/URL을 확인하세요 — 뷰(?v=) 링크가 아닌 데이터베이스 링크를 사용하세요."
                .into(),
        );
    }
    let raw = &hex_only[hex_only.len() - 32..];
    // 모두 hex인지 재확인(이미 필터링됐으나 방어적으로).
    if !raw.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(
            "Notion DB ID/URL을 확인하세요 — 뷰(?v=) 링크가 아닌 데이터베이스 링크를 사용하세요."
                .into(),
        );
    }
    let lower = raw.to_lowercase();
    // 8-4-4-4-12 dashed UUID 형식으로 반환.
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &lower[0..8],
        &lower[8..12],
        &lower[12..16],
        &lower[16..20],
        &lower[20..32],
    ))
}

/// 생성된 Notion 페이지의 https url(또는 raw uuid)을 데스크톱 앱 딥링크(`notion://`)로 변환한다.
///
/// Notion 데스크톱 앱은 `https://www.notion.so/<id>`를 `notion://www.notion.so/<id>`로
/// 그대로 매핑한다(스킴만 교체). 따라서:
/// - `https://…` / `http://…` url → 스킴만 `notion://`로 교체.
/// - 이미 `notion://`면 그대로.
/// - 스킴 없는 입력(raw 32-hex uuid 등) → `notion://www.notion.so/<hex>`로 구성.
///
/// 순수 함수(네트워크/IO 없음). https url 자체는 fallback으로 호출부가 보존한다.
pub fn notion_deep_link(url: &str) -> String {
    let s = url.trim();
    if let Some(rest) = s.strip_prefix("https://") {
        format!("notion://{rest}")
    } else if let Some(rest) = s.strip_prefix("http://") {
        format!("notion://{rest}")
    } else if s.starts_with("notion://") {
        s.to_string()
    } else {
        // 스킴 없는 입력 → 32-hex만 추려 표준 페이지 경로로 구성. hex가 없으면 입력 그대로 붙인다.
        let hex: String = s.chars().filter(|c| c.is_ascii_hexdigit()).collect();
        let id = if hex.len() >= 32 {
            hex[hex.len() - 32..].to_lowercase()
        } else {
            s.replace('-', "")
        };
        format!("notion://www.notion.so/{id}")
    }
}

// ── External Action Gate: Notion WRITE 커넥터(Phase 3, AI-origin) ─────────────────
// 제안은 MCP/사용자가 만들고, 실행은 승인 후 여기서만(Rust·토큰 keychain·bounded retry·rate limit).
// 사람-origin 카드 승격(`commands::notion::promote_to_notion`)은 **기존 경로 유지** — 이 커넥터는
// 외부 에이전트 제안(external_actions 큐)만 흘린다(spec §4 이중 경로: AI-origin=gate / human=기존 큐).
// 기존 `NotionWriter`/`HttpNotionWriter`/`create_page`를 그대로 재사용한다(rate limiter·title 속성
// 발견·bounded retry 무상 획득). GitHub 커넥터와 비대칭 2종: writer가 토큰을 보유하지 않고(인자로
// 받음), 반환이 `CreatedPage`(게이트 `ExecOutcome` 아님)다 — 그래서 토큰 resolve + outcome 매핑이 필요.

/// cref(=project credential_ref)로 keychain Notion 토큰을 읽는다. **write(gate 라우터)와 read 경로가
/// 공유하는 단일 토큰 resolve 레시피** — 토큰 본문은 여기서만 쓰이고 노출/로그되지 않는다(INVARIANT #7).
/// 에러 코드는 `commands::notion`의 기존 `notion.token_missing`과 통일(drift 방지).
// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용(github_provider_for_cref 등과 동일).
#[allow(clippy::result_large_err)]
pub fn notion_token_for_cref(cref: &str) -> Result<String, crate::error::AppError> {
    use crate::error::AppError;
    crate::keychain::get_token(cref, crate::models::TokenKind::Notion)?.ok_or_else(|| {
        AppError::not_found(
            "notion.token_missing",
            "Notion 토큰이 없습니다(설정에서 저장 필요)",
        )
    })
}

/// 승인된 Notion 액션을 적절한 writer 메서드로 dispatch한다. 키체인은 호출 측(라우터)이 resolve해
/// `token`으로 넘긴다 — 여기선 db_id 정규화 + writer 호출 + outcome 매핑만(테스트는 mock writer로
/// 네트워크 없이 라우팅 검증). 비-Notion 액션은 호출 측 라우터가 거르지만 방어적으로 거부한다.
// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용(execute_github_action 등과 동일).
#[allow(clippy::result_large_err)]
pub(crate) async fn execute_notion_action<W: NotionWriter>(
    writer: &W,
    token: &str,
    action: &crate::external_actions::ExternalAction,
) -> Result<ExecOutcome, crate::error::AppError> {
    use crate::external_actions::ExternalAction;
    match action {
        ExternalAction::NotionCreatePage { db_id, title } => {
            // proposer가 준 원시 db_id/URL을 표준 dashed UUID로 정규화한다(뷰 링크·슬러그 방어).
            // 형식 불일치는 외부 호출 전에 validation 에러로 거른다.
            let normalized = normalize_notion_db_id(db_id)
                .map_err(|m| crate::error::AppError::validation("notion.db_id_invalid", m))?;
            let page = writer.create_page(token, &normalized, title).await?;
            // CreatedPage는 사람-origin 경로(딥링크)와 공유하는 고유 도메인 타입이라 게이트 경계에서
            // ExecOutcome로 매핑한다(GitHub #12와 달리 ExecOutcome의 평행 복제가 아님 — 별도 소비자가
            // 있는 타입이므로 1회 경계 매핑이 옳다). **external_ref=page.id**(콘텐츠-free 식별자):
            // page.url은 `…/<제목-슬러그>-<id>` 형태라 제목(사용자 콘텐츠)이 새는데, external_ref는
            // audit `detail`(`ref=…`)과 result 컬럼에 들어가고 그 계약은 "식별자만, 본문 금지"(gate.rs
            // ExecOutcome 닥 + audit.rs 시크릿-free 계약, INVARIANT #7)다. id(dashed UUID)는 그 예시.
            Ok(ExecOutcome {
                external_ref: Some(page.id),
                bytes: Some(title.len() as i64),
            })
        }
        other => Err(crate::error::AppError::unexpected(
            "notion.dispatch.kind",
            format!("Notion 커넥터가 처리할 수 없는 액션: {}", other.kind_str()),
        )),
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

    /// HTTP 분류: 429/5xx=Transient, 404=NotFound, 403=Forbidden, 그 외 4xx=Terminal.
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
            NotionError::NotFound(_)
        ));
        assert!(matches!(
            classify_http(403, "forbidden"),
            NotionError::Forbidden(_)
        ));
        // 본문 스크럽(스펙 §5.5): 응답 본문 내용은 메시지에 노출되지 않는다.
        let NotionError::Terminal(m) = classify_http(400, "SECRET_BODY_xyz") else {
            panic!("400 → Terminal");
        };
        assert!(!m.contains("SECRET_BODY_xyz"), "본문이 메시지에 새면 안 됨");
    }

    /// normalize_notion_db_id: 순수 32-hex raw ID.
    #[test]
    fn normalize_raw_hex() {
        let raw = "1234567890abcdef1234567890abcdef";
        let r = normalize_notion_db_id(raw).unwrap();
        assert_eq!(r, "12345678-90ab-cdef-1234-567890abcdef");
    }

    /// normalize_notion_db_id: 이미 dashed UUID 형식.
    #[test]
    fn normalize_dashed_uuid() {
        let dashed = "12345678-90ab-cdef-1234-567890abcdef";
        let r = normalize_notion_db_id(dashed).unwrap();
        assert_eq!(r, "12345678-90ab-cdef-1234-567890abcdef");
    }

    /// normalize_notion_db_id: 전체 URL (타이틀-슬러그 + ?v= 뷰 파라미터).
    #[test]
    fn normalize_full_url_with_slug_and_view() {
        // 실제 Notion 공유 URL 패턴: notion.so/<workspace>/<Title-Slug>-<32hex>?v=<view_id>
        let url =
            "https://www.notion.so/myworkspace/My-Project-Backlog-1234567890abcdef1234567890abcdef?v=ffffffffffffffffffffffffffffffff";
        let r = normalize_notion_db_id(url).unwrap();
        // ?v= 이전 경로의 마지막 32-hex = DB id
        assert_eq!(r, "12345678-90ab-cdef-1234-567890abcdef");
    }

    /// normalize_notion_db_id: 너무 짧거나 garbage → Err.
    #[test]
    fn normalize_garbage_returns_err() {
        assert!(normalize_notion_db_id("not-a-db-id").is_err());
        assert!(normalize_notion_db_id("").is_err());
        assert!(normalize_notion_db_id("12345").is_err());
    }

    /// notion_deep_link: https url → notion:// 스킴 교체(경로/슬러그/uuid 보존).
    #[test]
    fn deep_link_https_swaps_scheme() {
        assert_eq!(
            notion_deep_link("https://www.notion.so/1234567890abcdef1234567890abcdef"),
            "notion://www.notion.so/1234567890abcdef1234567890abcdef"
        );
        // 워크스페이스 슬러그 + dashed uuid가 붙은 실제 생성 페이지 url도 경로 그대로 보존.
        assert_eq!(
            notion_deep_link("https://www.notion.so/ws/My-Page-1234567890abcdef1234567890abcdef"),
            "notion://www.notion.so/ws/My-Page-1234567890abcdef1234567890abcdef"
        );
    }

    /// notion_deep_link: http(평문)도 notion://로 교체.
    #[test]
    fn deep_link_http_swaps_scheme() {
        assert_eq!(
            notion_deep_link("http://www.notion.so/abc123"),
            "notion://www.notion.so/abc123"
        );
    }

    /// notion_deep_link: 이미 notion://면 그대로 둔다(이중 변환 방지).
    #[test]
    fn deep_link_already_notion_is_idempotent() {
        let dl = "notion://www.notion.so/1234567890abcdef1234567890abcdef";
        assert_eq!(notion_deep_link(dl), dl);
    }

    /// notion_deep_link: 스킴 없는 raw uuid(대시 포함/제외) → 표준 페이지 딥링크.
    #[test]
    fn deep_link_raw_uuid_builds_page_link() {
        assert_eq!(
            notion_deep_link("12345678-90ab-cdef-1234-567890abcdef"),
            "notion://www.notion.so/1234567890abcdef1234567890abcdef"
        );
        assert_eq!(
            notion_deep_link("1234567890ABCDEF1234567890abcdef"),
            "notion://www.notion.so/1234567890abcdef1234567890abcdef"
        );
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
}

#[cfg(test)]
mod write_dispatch_tests {
    use super::*;
    use crate::external_actions::ExternalAction;
    use std::sync::Mutex;

    /// 네트워크 없는 mock Notion writer — 호출 인자를 기록해 dispatch 라우팅/정규화를 검증한다.
    #[derive(Default)]
    struct MockNotionWriter {
        calls: Mutex<Vec<(String, String, String)>>, // (token, db_id, title)
    }
    impl NotionWriter for MockNotionWriter {
        async fn create_page(
            &self,
            token: &str,
            db_id: &str,
            title: &str,
        ) -> Result<CreatedPage, NotionError> {
            self.calls
                .lock()
                .unwrap()
                .push((token.into(), db_id.into(), title.into()));
            // id와 url을 일부러 다르게 둔다 — external_ref가 (제목 슬러그가 새는) url이 아니라
            // 콘텐츠-free id를 담는지 검증하기 위해.
            Ok(CreatedPage {
                id: "page-id-1".into(),
                url: "https://www.notion.so/My-Title-page-id-1".into(),
            })
        }
    }

    /// NotionCreatePage → writer.create_page로 라우팅되고, 원시 db_id가 dashed UUID로 정규화되어
    /// 전달되며, outcome.external_ref가 **콘텐츠-free page id**(url 슬러그 아님)다.
    #[tokio::test]
    async fn dispatch_routes_create_page_with_normalized_db_id() {
        let w = MockNotionWriter::default();
        let action = ExternalAction::NotionCreatePage {
            db_id: "1234567890abcdef1234567890abcdef".into(), // 원시 32-hex
            title: "할 일".into(),
        };
        let out = execute_notion_action(&w, "tok", &action).await.unwrap();
        // 감사 계약(식별자만, 본문 금지): url 슬러그가 아니라 page.id를 external_ref로 쓴다.
        assert_eq!(out.external_ref.as_deref(), Some("page-id-1"));
        assert_eq!(
            w.calls.lock().unwrap().as_slice(),
            &[(
                "tok".to_string(),
                "12345678-90ab-cdef-1234-567890abcdef".to_string(), // 정규화됨
                "할 일".to_string()
            )]
        );
    }

    /// 형식이 깨진 db_id는 외부 호출 전에 validation 에러로 거른다(writer 미호출).
    #[tokio::test]
    async fn dispatch_rejects_invalid_db_id_before_write() {
        let w = MockNotionWriter::default();
        let action = ExternalAction::NotionCreatePage {
            db_id: "not-a-db".into(),
            title: "t".into(),
        };
        let r = execute_notion_action(&w, "tok", &action).await;
        assert!(r.is_err(), "잘못된 db_id는 거부");
        assert!(w.calls.lock().unwrap().is_empty(), "거부 시 write 0");
    }

    /// 비-Notion 액션은 방어적으로 거부한다(라우터가 먼저 거르지만 이중 방어).
    #[tokio::test]
    async fn dispatch_rejects_non_notion_action() {
        let w = MockNotionWriter::default();
        let action = ExternalAction::Noop { note: "x".into() };
        assert!(execute_notion_action(&w, "tok", &action).await.is_err());
    }
}
