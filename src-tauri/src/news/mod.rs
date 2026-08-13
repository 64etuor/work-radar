//! 외부 뉴스 소스(HN/GeekNews/Lobsters) 통합 페치 백엔드.
//!
//! INVARIANT #1(결정 레일 자동화 금지): 뉴스는 표시만 — 큐/매트릭스에 자동 주입 절대 금지.
//! INVARIANT #5(bounded retry): fetcher.rs에서 페치 실패 시 최대 3회 지수 백오프 + jitter.
//! INVARIANT #7(SSOT 분리): 원본 SSOT=외부 사이트, SQLite=캐시(`fetched_at` 7일 만료).

pub mod fetcher;
pub mod filter_store;
pub mod geeknews;
pub mod hn;
pub mod lobsters;
pub mod options_store;
pub mod pref_store;
pub mod rss_generic;
pub mod store;

use async_trait::async_trait;
use reqwest::{Client, Response, StatusCode};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::AppError;

/// 뉴스/RSS 응답의 압축 해제 후 본문 상한. 일반 피드보다 충분히 크면서 비정상 응답이
/// 프로세스 메모리를 고갈시키지 못하게 한다.
const MAX_NEWS_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum NewsCategory {
    KoreanTech,
    EnglishTech,
    AiResearch,
}

/// 비-2xx HTTP status를 AppError로 분류한다. 외부 응답 본문은 PII/시크릿이 포함될 수
/// 있으므로 에러나 로그에 넣지 않고 서버가 공개한 크기만 기록한다.
///
/// 정책: 5xx + 429만 Transient(retryable, warn 레벨), 나머지 비-2xx는 Terminal(error 레벨).
/// 기본 `From<reqwest::Error>`(error.rs)는 timeout/connect만 Transient라 5xx 응답이
/// Terminal로 떨어져 `errors.log`에 노이즈를 만들었음(follow-up #1). 이 함수는 순수 — HTTP
/// I/O 없이 분기 로직만 담당해 단위 테스트 가능.
fn classify_http_status(
    status: StatusCode,
    code_prefix: &str,
    content_length: Option<u64>,
) -> AppError {
    let body_size = content_length
        .map(|length| length.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    let msg = format!("HTTP {status} (body_bytes={body_size})");
    let code = format!("{code_prefix}.http_{}", status.as_u16());
    if status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS {
        AppError::transient(code, msg)
    } else {
        AppError::terminal(code, msg)
    }
}

fn append_capped(buffer: &mut Vec<u8>, chunk: &[u8], max_bytes: usize) -> Result<(), usize> {
    let observed = buffer.len().saturating_add(chunk.len());
    if chunk.len() > max_bytes.saturating_sub(buffer.len()) {
        return Err(observed);
    }
    buffer.extend_from_slice(chunk);
    Ok(())
}

async fn read_body_capped(mut resp: Response, code_prefix: &str) -> Result<Vec<u8>, AppError> {
    if let Some(length) = resp.content_length() {
        if length > MAX_NEWS_RESPONSE_BYTES as u64 {
            return Err(AppError::terminal(
                format!("{code_prefix}.response_too_large"),
                format!(
                    "response too large (body_bytes={length}, max_bytes={MAX_NEWS_RESPONSE_BYTES})"
                ),
            ));
        }
    }

    let mut body = Vec::with_capacity(
        resp.content_length()
            .unwrap_or_default()
            .min(MAX_NEWS_RESPONSE_BYTES as u64) as usize,
    );
    while let Some(chunk) = resp.chunk().await? {
        if let Err(observed) = append_capped(&mut body, &chunk, MAX_NEWS_RESPONSE_BYTES) {
            return Err(AppError::terminal(
                format!("{code_prefix}.response_too_large"),
                format!(
                    "response too large (body_bytes_at_least={observed}, max_bytes={MAX_NEWS_RESPONSE_BYTES})"
                ),
            ));
        }
    }
    Ok(body)
}

pub(crate) async fn http_json<T: serde::de::DeserializeOwned>(
    resp: Response,
    code_prefix: &str,
) -> Result<T, AppError> {
    let status = resp.status();
    if !status.is_success() {
        return Err(classify_http_status(
            status,
            code_prefix,
            resp.content_length(),
        ));
    }
    let body = read_body_capped(resp, code_prefix).await?;
    let value = serde_json::from_slice::<T>(&body).map_err(|_| {
        AppError::terminal(format!("{code_prefix}.decode"), "invalid JSON response")
    })?;
    Ok(value)
}

/// http_json의 bytes 변종(RSS 파싱 등 binary stream용). `bytes::Bytes`를 노출하지 않기 위해
/// `Vec<u8>`로 반환(직접 dep 추가 회피). 호출자는 `&[u8]`로 슬라이스해 사용.
pub(crate) async fn http_bytes(resp: Response, code_prefix: &str) -> Result<Vec<u8>, AppError> {
    let status = resp.status();
    if !status.is_success() {
        return Err(classify_http_status(
            status,
            code_prefix,
            resp.content_length(),
        ));
    }
    read_body_capped(resp, code_prefix).await
}

/// 정규화된 뉴스 아이템 — 모든 소스가 이 형태로 반환.
/// `posted_at`은 RFC3339 문자열(코드베이스 patterns: IPC 타입은 chrono 노출 없이 문자열).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    /// 소스 id (예: "hn", "geeknews", "lobsters"). registry id와 동일.
    pub source: String,
    /// 소스 내 안정적 id (HN: story id, RSS: guid).
    pub external_id: String,
    pub title: String,
    pub url: String,
    pub comments_url: Option<String>,
    pub comment_count: Option<u32>,
    /// RFC3339 (e.g. `2026-05-25T10:00:00+00:00`).
    pub posted_at: String,
}

/// 소스 메타 정보 — IPC `news_sources_available`이 반환.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsSourceMeta {
    pub id: String,
    pub label: String,
    pub category: NewsCategory,
    pub enabled: bool,
}

#[async_trait]
pub trait NewsSource: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    fn category(&self) -> NewsCategory;
    /// DB에 pref 행이 없을 때의 기본 on/off (신규 설치 기본값). safe-by-default `false` —
    /// 새 소스가 seed 마이그레이션 없이 silent default-ON 되는 회귀를 트레이트 차원에서 막는다.
    /// 기존 설치의 구 기본값(ON) 보존은 0072 마이그레이션(legacy explicit seed)이 담당.
    fn default_enabled(&self) -> bool {
        false
    }
    /// 페치. 실패는 AppError로 — 호출자(fetcher.rs)가 retry 결정.
    /// 네트워크 실패는 transient(retryable)로 마크해 fetcher가 backoff 후 재시도하게 한다.
    async fn fetch(&self, client: &Client) -> Result<Vec<NewsItem>, AppError>;
}

/// 컴파일 시 고정 — 새 소스 추가 = 한 줄.
pub fn registry() -> Vec<Box<dyn NewsSource>> {
    use rss_generic::GenericRssSource;
    use NewsCategory::*;
    const REDDIT_HEADERS: &[(&str, &str)] = &[(
        "user-agent",
        "work-radar/1.0 (https://github.com/work-radar)",
    )];
    const NO_HEADERS: &[(&str, &str)] = &[];
    vec![
        Box::new(hn::HnSource),
        Box::new(geeknews::GeekNewsSource),
        Box::new(lobsters::LobstersSource),
        // 영문 추가(default OFF).
        Box::new(GenericRssSource {
            id: "reddit_programming",
            label: "r/programming",
            category: EnglishTech,
            url: "https://www.reddit.com/r/programming/.rss",
            headers: REDDIT_HEADERS,
            take: 0,
        }),
        Box::new(GenericRssSource {
            id: "devto",
            label: "dev.to",
            category: EnglishTech,
            url: "https://dev.to/feed",
            headers: NO_HEADERS,
            take: 0,
        }),
        // 한글(default OFF).
        Box::new(GenericRssSource {
            id: "naver_d2",
            label: "NAVER D2",
            category: KoreanTech,
            url: "https://d2.naver.com/d2.atom",
            headers: NO_HEADERS,
            take: 0,
        }),
        Box::new(GenericRssSource {
            id: "kakao_tech",
            label: "카카오 기술블로그",
            category: KoreanTech,
            url: "https://tech.kakao.com/feed/",
            headers: NO_HEADERS,
            take: 0,
        }),
        Box::new(GenericRssSource {
            id: "woowahan_tech",
            label: "우아한형제들 기술블로그",
            category: KoreanTech,
            url: "https://techblog.woowahan.com/feed/",
            headers: NO_HEADERS,
            take: 0,
        }),
        Box::new(GenericRssSource {
            id: "toss_tech",
            label: "토스 tech",
            category: KoreanTech,
            url: "https://toss.tech/rss.xml",
            headers: NO_HEADERS,
            take: 0,
        }),
        Box::new(GenericRssSource {
            id: "line_engineering",
            label: "LINE engineering",
            category: KoreanTech,
            url: "https://engineering.linecorp.com/ko/blog/rss/",
            headers: NO_HEADERS,
            take: 0,
        }),
        Box::new(GenericRssSource {
            id: "yozm_it",
            label: "요즘IT",
            category: KoreanTech,
            url: "https://yozm.wishket.com/magazine/rss/",
            headers: NO_HEADERS,
            take: 0,
        }),
        // AI/ML — HTTPS (critic 지적).
        Box::new(GenericRssSource {
            id: "arxiv_cs_lg",
            label: "arXiv cs.LG",
            category: AiResearch,
            url: "https://export.arxiv.org/rss/cs.LG",
            headers: NO_HEADERS,
            take: 0,
        }),
        Box::new(GenericRssSource {
            id: "arxiv_cs_ai",
            label: "arXiv cs.AI",
            category: AiResearch,
            url: "https://export.arxiv.org/rss/cs.AI",
            headers: NO_HEADERS,
            take: 0,
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;

    #[test]
    fn registry_ids_are_unique() {
        let all: Vec<&str> = registry().iter().map(|s| s.id()).collect();
        let uniq: std::collections::HashSet<&str> = all.iter().copied().collect();
        assert_eq!(all.len(), uniq.len(), "registry 중복 id: {:?}", all);
    }

    #[test]
    fn registry_covers_all_categories() {
        let cats: std::collections::HashSet<NewsCategory> =
            registry().iter().map(|s| s.category()).collect();
        assert!(cats.contains(&NewsCategory::KoreanTech));
        assert!(cats.contains(&NewsCategory::EnglishTech));
        assert!(cats.contains(&NewsCategory::AiResearch));
    }

    #[tokio::test]
    async fn every_registry_id_has_resolved_pref() {
        // critic blocker: registry에 추가하고 마이그레이션 seed를 빠뜨리면 silent default-ON 회귀.
        //
        // NOTE(v3 minor): 이 등식이 성립하는 이유는 `pref_store::list_available`이 DB에 행이
        // 없으면 소스별 코드 기본값으로 meta를 *합성*하기 때문
        // (`saved.get(...).unwrap_or(src.default_enabled())`). 향후 누군가 `list_available`을
        // "seeded rows만 반환"으로 바꾸면 행 없는 소스가 목록에서 사라지면서 이 테스트도
        // 깨진다 — 그 회귀를 보호하는 의도된 coupling.
        let p = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&p).await.unwrap();
        let avail = crate::news::pref_store::list_available(&p).await.unwrap();
        let pref_ids: std::collections::HashSet<&str> =
            avail.iter().map(|m| m.id.as_str()).collect();
        let reg_ids: std::collections::HashSet<&str> = registry().iter().map(|s| s.id()).collect();
        assert_eq!(
            pref_ids, reg_ids,
            "registry vs pref 불일치 → seed 누락 가능성"
        );
    }

    #[tokio::test]
    async fn new_sources_default_off_after_0019() {
        let p = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&p).await.unwrap();
        let avail = crate::news::pref_store::list_available(&p).await.unwrap();
        let by_id: std::collections::HashMap<String, bool> =
            avail.into_iter().map(|m| (m.id, m.enabled)).collect();
        assert_eq!(by_id.get("hn"), Some(&true));
        // 범용화: geeknews는 신규 설치(빈 news_items) 기본 OFF — 기존 설치는 0072 seed가 보존.
        assert_eq!(by_id.get("geeknews"), Some(&false));
        assert_eq!(by_id.get("lobsters"), Some(&true));
        assert_eq!(by_id.get("reddit_programming"), Some(&false));
        assert_eq!(by_id.get("arxiv_cs_lg"), Some(&false));
    }

    #[tokio::test]
    async fn migration_0019_idempotent_preserves_user_changes() {
        let p = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&p).await.unwrap();
        // 사용자가 reddit_programming을 켰다고 가정.
        sqlx::query("UPDATE news_source_pref SET enabled=1 WHERE source='reddit_programming'")
            .execute(&p)
            .await
            .unwrap();
        // 마이그레이션을 같은 풀에 한 번 더 시도 — sqlx::migrate!는 멱등.
        sqlx::migrate!("./migrations").run(&p).await.unwrap();
        let r: (i64,) = sqlx::query_as(
            "SELECT enabled FROM news_source_pref WHERE source='reddit_programming'",
        )
        .fetch_one(&p)
        .await
        .unwrap();
        assert_eq!(
            r.0, 1,
            "사용자가 켠 상태가 마이그레이션에 의해 덮어쓰여지지 않음"
        );
    }

    // classify_http_status 단위 테스트 — http_json/http_bytes 두 helper의 핵심 정책 보호.
    // (이 분기 로직이 회귀하면 `errors.log` 노이즈가 다시 들어와도 정적 게이트가 못 잡음.)

    #[test]
    fn classify_5xx_is_transient_warn() {
        let e = classify_http_status(StatusCode::INTERNAL_SERVER_ERROR, "hn.top", Some(4));
        assert_eq!(e.kind, ErrorKind::Transient, "5xx은 Transient(retry+warn)");
        assert!(e.retryable);
        assert_eq!(e.code, "hn.top.http_500");
        assert!(e.message.contains("HTTP 500"));
        assert!(e.message.contains("body_bytes=4"));
    }

    #[test]
    fn classify_503_is_transient() {
        let e = classify_http_status(StatusCode::SERVICE_UNAVAILABLE, "geeknews", None);
        assert_eq!(e.kind, ErrorKind::Transient);
        assert_eq!(e.code, "geeknews.http_503");
    }

    #[test]
    fn classify_429_is_transient() {
        let e = classify_http_status(StatusCode::TOO_MANY_REQUESTS, "lobsters", Some(12));
        assert_eq!(e.kind, ErrorKind::Transient, "429는 명시적으로 Transient");
        assert!(e.retryable);
        assert_eq!(e.code, "lobsters.http_429");
    }

    #[test]
    fn classify_404_is_terminal_not_retryable() {
        let e = classify_http_status(StatusCode::NOT_FOUND, "hn.item", Some(9));
        assert_eq!(e.kind, ErrorKind::Terminal, "4xx(429 제외)는 Terminal");
        assert!(!e.retryable);
        assert_eq!(e.code, "hn.item.http_404");
    }

    #[test]
    fn classify_400_is_terminal() {
        let e = classify_http_status(StatusCode::BAD_REQUEST, "hn.top", Some(3));
        assert_eq!(e.kind, ErrorKind::Terminal);
        assert_eq!(e.code, "hn.top.http_400");
    }

    #[test]
    fn classify_403_is_terminal() {
        let e = classify_http_status(StatusCode::FORBIDDEN, "geeknews", None);
        assert_eq!(e.kind, ErrorKind::Terminal);
        assert_eq!(e.code, "geeknews.http_403");
    }

    #[test]
    fn classify_never_copies_external_body() {
        let e = classify_http_status(StatusCode::INTERNAL_SERVER_ERROR, "hn", Some(500));
        assert_eq!(e.message, "HTTP 500 Internal Server Error (body_bytes=500)");
    }

    #[test]
    fn append_capped_accepts_exact_limit_and_rejects_next_byte() {
        let mut body = vec![1, 2];
        assert_eq!(append_capped(&mut body, &[3, 4], 4), Ok(()));
        assert_eq!(body, vec![1, 2, 3, 4]);
        assert_eq!(append_capped(&mut body, &[5], 4), Err(5));
        assert_eq!(body, vec![1, 2, 3, 4]);
    }
}
