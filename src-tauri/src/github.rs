//! GitHub PR Radar 클라이언트 (read 레일, Phase 4). INVARIANT: 외부 호출은 Rust(octocrab)에,
//! 토큰은 keychain에서만 읽혀 Rust 안에서만 쓰인다(렌더러 미노출).
//!
//! 핵심 규칙:
//!  - bounded retry only (INVARIANT #5): `with_retry`는 시도 횟수 캡 + 지수 backoff + jitter,
//!    terminal(4xx, 429 제외)은 재시도하지 않고 소진 시 terminal failure를 노출한다.
//!  - 페이지네이션은 bounded(최대 페이지 캡) — 무한 poll 금지.
//!  - 테스트 가능 seam: radar 코어는 `PrProvider` 트레잇에만 의존(commands.rs). 단위 테스트는
//!    fake provider로 버킷/escalate/auto-resolve를, `with_retry`/CI 집계는 순수 로직으로 검증(실 네트워크 없음).
//!
//! github.rs는 자체 `GithubError`를 소유한다(notion.rs와 비공유) — GitHub은 rate limit(~5000/h +
//! secondary)·Retry-After·X-RateLimit-Reset 등 Notion과 다른 재시도 관심사를 가지므로 모듈별로 분리.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use octocrab::params::repos::Commitish;
use octocrab::Octocrab;

use crate::models::CiStatus;

/// 한 fetch 시도 내 재시도 횟수 캡 (INVARIANT #5: 무한 retry 금지).
const MAX_ATTEMPTS: u32 = 3;
/// backoff 기준 지연(첫 재시도). 실제 base*2^n + jitter.
const BASE_DELAY: Duration = Duration::from_millis(400);
/// open PR 페이지네이션 상한 (bounded — 무한 poll 금지). per_page 50 × 5 = 최대 250건.
const MAX_OPEN_PAGES: u32 = 5;
const PER_PAGE: u8 = 50;
/// "Merged Cleanup" 후보로 볼 최근 머지 기간(일). 최근 1페이지만 본다(per-PR CI 호출 없음).
const MERGED_RECENT_DAYS: i64 = 14;
/// PR diff 텍스트 상한(바이트). codex 컨텍스트 bound — 초과분은 잘라 표시(INVARIANT #5 정신).
pub const MAX_PR_DIFF_BYTES: usize = 256 * 1024;

/// 외부 fetch 실패 분류. Transient = 재시도 대상(네트워크·429·5xx),
/// Terminal = 재시도 무의미(인증/권한/검증 등 4xx, 디코드 실패).
#[derive(Debug, Clone)]
pub enum GithubError {
    Transient(String),
    Terminal(String),
}

impl std::fmt::Display for GithubError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GithubError::Transient(m) => write!(f, "{m}"),
            GithubError::Terminal(m) => write!(f, "{m}"),
        }
    }
}

impl std::error::Error for GithubError {}

/// PR의 머지 상태 (provider 출력, 내부 전용 — export 아님). unmerged-closed는 provider가 거른다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RawPrState {
    Open,
    Merged,
}

/// provider가 반환하는 raw PR 데이터(GitHub 비의존, 테스트 가능). 매핑은 commands.rs 코어가 한다.
#[derive(Debug, Clone)]
pub struct RawPr {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author_login: String,
    /// head 브랜치 이름 (ticket 추출 차선 소스).
    pub head_ref: String,
    pub is_draft: bool,
    pub state: RawPrState,
    pub ci: CiStatus,
    pub has_conflict: bool,
    /// 마지막 갱신 시각(RFC3339). age/stale 계산 기준.
    pub updated_at: String,
}

/// radar 코어가 의존하는 유일한 외부 read 계약. 테스트는 fake로 대체한다.
/// (RPITIT — async fn in trait. async_trait 의존성 없이 제네릭으로만 소비한다.)
pub trait PrProvider {
    /// `owner/repo`의 PR들을 가져온다(open + 최근 merged, bounded 페이지네이션 내부 처리).
    fn fetch_prs(
        &self,
        repo_full_name: &str,
    ) -> impl std::future::Future<Output = Result<Vec<RawPr>, GithubError>> + Send;

    /// PR의 unified diff 텍스트를 가져온다(Phase 8 self-check 초안 입력). bounded retry + 크기 상한.
    fn fetch_pr_diff(
        &self,
        repo_full_name: &str,
        number: u64,
    ) -> impl std::future::Future<Output = Result<String, GithubError>> + Send;
}

/// diff 텍스트를 상한까지 자른다(초과 시 안내 줄 추가). 순수 — 테스트 가능.
pub fn cap_diff(diff: String) -> String {
    if diff.len() <= MAX_PR_DIFF_BYTES {
        return diff;
    }
    // char 경계에서 자른다(UTF-8 안전).
    let mut end = MAX_PR_DIFF_BYTES;
    while end > 0 && !diff.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n\n[... diff가 {}바이트 상한을 넘어 잘렸습니다. 전체는 PR에서 확인 ...]",
        &diff[..end],
        MAX_PR_DIFF_BYTES
    )
}

/// octocrab 에러 → 분류. 429/5xx/네트워크는 일시적, 그 외 4xx/디코드는 영구.
fn classify_octocrab(e: &octocrab::Error) -> GithubError {
    match e {
        octocrab::Error::GitHub { source, .. } => {
            let status = source.status_code.as_u16();
            if status == 429 || status >= 500 {
                GithubError::Transient(format!("HTTP {status}: {}", source.message))
            } else {
                GithubError::Terminal(format!("HTTP {status}: {}", source.message))
            }
        }
        // 전송 계층(hyper/service)·rate limit 대기는 재시도 대상.
        octocrab::Error::Hyper { .. } | octocrab::Error::Service { .. } => {
            GithubError::Transient(e.to_string())
        }
        // 디코드/URL/인코딩 등은 재시도해도 동일 → terminal.
        _ => GithubError::Terminal(e.to_string()),
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
) -> Result<T, GithubError>
where
    F: FnMut(u32) -> Fut,
    Fut: std::future::Future<Output = Result<T, GithubError>>,
{
    let mut attempt = 0u32;
    loop {
        match op(attempt).await {
            Ok(v) => return Ok(v),
            Err(GithubError::Terminal(m)) => return Err(GithubError::Terminal(m)),
            Err(GithubError::Transient(m)) => {
                attempt += 1;
                if attempt >= max_attempts {
                    return Err(GithubError::Transient(m));
                }
                let backoff = base_delay.saturating_mul(2u32.saturating_pow(attempt - 1));
                tokio::time::sleep(backoff + jitter(base_delay)).await;
            }
        }
    }
}

/// 한 check-run의 conclusion(미완료=None) 묶음에서 CI 상태를 집계한다(순수 — 테스트 가능).
///  - 하나라도 실패(failure/cancelled/timed_out/action_required/stale) → Failing
///  - 실패 없고 미완료(conclusion None) 존재 → Pending
///  - 체크 없음 → None
///  - 그 외(전부 success/neutral/skipped) → Passing
pub(crate) fn aggregate_ci(conclusions: &[Option<String>]) -> CiStatus {
    if conclusions.is_empty() {
        return CiStatus::None;
    }
    let mut pending = false;
    for c in conclusions {
        match c.as_deref() {
            Some("failure" | "cancelled" | "timed_out" | "action_required" | "stale") => {
                return CiStatus::Failing;
            }
            Some("success" | "neutral" | "skipped") => {}
            // None(미완료) 또는 알 수 없는 conclusion → 보류로 간주.
            _ => pending = true,
        }
    }
    if pending {
        CiStatus::Pending
    } else {
        CiStatus::Passing
    }
}

/// 'https://github.com/owner/repo(.git)' 또는 'owner/repo' → (owner, repo).
pub(crate) fn parse_owner_repo(repo_full_name: &str) -> Option<(String, String)> {
    let s = repo_full_name.trim().trim_end_matches('/');
    let s = s.strip_suffix(".git").unwrap_or(s);
    // URL 형태면 host 이후 마지막 두 세그먼트, 아니면 그대로 'owner/repo'.
    let tail = s
        .rsplit("github.com")
        .next()
        .unwrap_or(s)
        .trim_start_matches([':', '/']);
    let parts: Vec<&str> = tail.split('/').filter(|p| !p.is_empty()).collect();
    if parts.len() >= 2 {
        let owner = parts[parts.len() - 2].to_string();
        let repo = parts[parts.len() - 1].to_string();
        if !owner.is_empty() && !repo.is_empty() {
            return Some((owner, repo));
        }
    }
    None
}

/// 실제 octocrab PR provider. project별 토큰으로 만들어진다(토큰 본문은 보관만, 노출 안 함).
pub struct HttpPrProvider {
    octo: Octocrab,
}

impl HttpPrProvider {
    /// keychain에서 읽은 토큰으로 클라이언트 생성. octocrab 기본 rustls.
    pub fn new(token: &str) -> Result<Self, GithubError> {
        let octo = Octocrab::builder()
            .personal_token(token.to_string())
            .build()
            .map_err(|e| GithubError::Terminal(format!("client build: {e}")))?;
        Ok(Self { octo })
    }

    /// PR head SHA의 check-runs를 집계해 CI 상태를 구한다(bounded retry).
    async fn ci_for_sha(
        &self,
        owner: &str,
        repo: &str,
        sha: &str,
    ) -> Result<CiStatus, GithubError> {
        let runs = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| async {
            self.octo
                .checks(owner, repo)
                .list_check_runs_for_git_ref(Commitish(sha.to_string()))
                .send()
                .await
                .map_err(|e| classify_octocrab(&e))
        })
        .await?;
        let conclusions: Vec<Option<String>> =
            runs.check_runs.into_iter().map(|r| r.conclusion).collect();
        Ok(aggregate_ci(&conclusions))
    }
}

impl PrProvider for HttpPrProvider {
    async fn fetch_prs(&self, repo_full_name: &str) -> Result<Vec<RawPr>, GithubError> {
        let (owner, repo) = parse_owner_repo(repo_full_name).ok_or_else(|| {
            GithubError::Terminal(format!("레포 형식 파싱 실패: {repo_full_name}"))
        })?;

        let mut out: Vec<RawPr> = Vec::new();

        // 1) open PR — bounded 페이지네이션 + per-PR CI/conflict 도출.
        for page in 1..=MAX_OPEN_PAGES {
            let pulls = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| async {
                self.octo
                    .pulls(&owner, &repo)
                    .list()
                    .state(octocrab::params::State::Open)
                    .per_page(PER_PAGE)
                    .page(page)
                    .send()
                    .await
                    .map_err(|e| classify_octocrab(&e))
            })
            .await?;

            let items = pulls.items;
            let count = items.len();
            for pr in items {
                let head_sha = pr.head.sha.clone();
                let ci = self.ci_for_sha(&owner, &repo, &head_sha).await?;
                let has_conflict = matches!(
                    pr.mergeable_state,
                    Some(octocrab::models::pulls::MergeableState::Dirty)
                );
                out.push(RawPr {
                    number: pr.number,
                    title: pr.title.clone().unwrap_or_default(),
                    url: pr
                        .html_url
                        .as_ref()
                        .map(|u| u.to_string())
                        .unwrap_or_default(),
                    author_login: pr
                        .user
                        .as_ref()
                        .map(|u| u.login.clone())
                        .unwrap_or_default(),
                    head_ref: pr.head.ref_field.clone(),
                    is_draft: pr.draft.unwrap_or(false),
                    state: RawPrState::Open,
                    ci,
                    has_conflict,
                    updated_at: pr.updated_at.map(|d| d.to_rfc3339()).unwrap_or_default(),
                });
            }
            if count < PER_PAGE as usize {
                break; // 마지막 페이지.
            }
        }

        // 2) 최근 merged — closed 1페이지만(per-PR CI 호출 없음, bounded). Merged Cleanup 버킷 채움.
        let cutoff = chrono::Utc::now() - chrono::Duration::days(MERGED_RECENT_DAYS);
        let closed = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| async {
            self.octo
                .pulls(&owner, &repo)
                .list()
                .state(octocrab::params::State::Closed)
                .sort(octocrab::params::pulls::Sort::Updated)
                .direction(octocrab::params::Direction::Descending)
                .per_page(30u8)
                .page(1u32)
                .send()
                .await
                .map_err(|e| classify_octocrab(&e))
        })
        .await?;
        for pr in closed.items {
            let Some(merged_at) = pr.merged_at else {
                continue; // unmerged closed는 액션 불요 → 제외.
            };
            if merged_at < cutoff {
                continue; // 오래된 머지는 제외(bounded recency).
            }
            out.push(RawPr {
                number: pr.number,
                title: pr.title.clone().unwrap_or_default(),
                url: pr
                    .html_url
                    .as_ref()
                    .map(|u| u.to_string())
                    .unwrap_or_default(),
                author_login: pr
                    .user
                    .as_ref()
                    .map(|u| u.login.clone())
                    .unwrap_or_default(),
                head_ref: pr.head.ref_field.clone(),
                is_draft: false,
                state: RawPrState::Merged,
                ci: CiStatus::None,
                has_conflict: false,
                updated_at: pr.updated_at.map(|d| d.to_rfc3339()).unwrap_or_default(),
            });
        }

        Ok(out)
    }

    async fn fetch_pr_diff(
        &self,
        repo_full_name: &str,
        number: u64,
    ) -> Result<String, GithubError> {
        let (owner, repo) = parse_owner_repo(repo_full_name).ok_or_else(|| {
            GithubError::Terminal(format!("레포 형식 파싱 실패: {repo_full_name}"))
        })?;
        let diff = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| async {
            self.octo
                .pulls(&owner, &repo)
                .get_diff(number)
                .await
                .map_err(|e| classify_octocrab(&e))
        })
        .await?;
        Ok(cap_diff(diff))
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
        let r: Result<u32, GithubError> = with_retry(5, Duration::from_millis(1), |_| {
            let n = calls.fetch_add(1, Ordering::Relaxed);
            async move {
                if n < 2 {
                    Err(GithubError::Transient("net".into()))
                } else {
                    Ok(7)
                }
            }
        })
        .await;
        assert_eq!(r.unwrap(), 7);
        assert_eq!(calls.load(Ordering::Relaxed), 3, "2번 실패 후 3번째 성공");
    }

    /// (b) 계속 transient면 max_attempts 소진 후 Transient 노출(무한 retry 아님).
    #[tokio::test]
    async fn with_retry_gives_up_after_max() {
        let calls = AtomicU32::new(0);
        let r: Result<u32, GithubError> = with_retry(3, Duration::from_millis(1), |_| {
            calls.fetch_add(1, Ordering::Relaxed);
            async { Err(GithubError::Transient("429".into())) }
        })
        .await;
        assert!(matches!(r, Err(GithubError::Transient(_))));
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
        let r: Result<u32, GithubError> = with_retry(5, Duration::from_millis(1), |_| {
            calls.fetch_add(1, Ordering::Relaxed);
            async { Err(GithubError::Terminal("404".into())) }
        })
        .await;
        assert!(matches!(r, Err(GithubError::Terminal(_))));
        assert_eq!(calls.load(Ordering::Relaxed), 1, "terminal은 1회만");
    }

    /// CI 집계: 실패 우선 > 보류 > passing, 빈 목록은 None.
    #[test]
    fn aggregate_ci_buckets() {
        let s = |v: &str| Some(v.to_string());
        assert_eq!(aggregate_ci(&[]), CiStatus::None);
        assert_eq!(
            aggregate_ci(&[s("success"), s("skipped")]),
            CiStatus::Passing
        );
        assert_eq!(
            aggregate_ci(&[s("success"), s("failure")]),
            CiStatus::Failing
        );
        // 미완료(None)는 보류.
        assert_eq!(aggregate_ci(&[s("success"), None]), CiStatus::Pending);
        // 실패는 보류보다 우선.
        assert_eq!(aggregate_ci(&[None, s("failure")]), CiStatus::Failing);
        assert_eq!(aggregate_ci(&[s("timed_out")]), CiStatus::Failing);
    }

    /// diff 크기 상한: 짧으면 그대로, 길면 잘리고 안내가 붙는다(bounded).
    #[test]
    fn cap_diff_truncates_when_over_limit() {
        let small = "diff --git a/x b/x\n".to_string();
        assert_eq!(cap_diff(small.clone()), small);
        let big = "x".repeat(MAX_PR_DIFF_BYTES + 100);
        let capped = cap_diff(big);
        assert!(capped.len() < MAX_PR_DIFF_BYTES + 200);
        assert!(capped.contains("잘렸습니다"));
    }

    /// owner/repo 파싱: URL / plain / .git 접미사.
    #[test]
    fn parse_owner_repo_forms() {
        assert_eq!(
            parse_owner_repo("https://github.com/64etuor/work-radar"),
            Some(("64etuor".into(), "work-radar".into()))
        );
        assert_eq!(
            parse_owner_repo("https://github.com/64etuor/work-radar.git"),
            Some(("64etuor".into(), "work-radar".into()))
        );
        assert_eq!(
            parse_owner_repo("64etuor/work-radar"),
            Some(("64etuor".into(), "work-radar".into()))
        );
        assert_eq!(parse_owner_repo("not-a-repo"), None);
    }
}
