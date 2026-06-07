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

use std::time::Duration;

use octocrab::params::repos::Commitish;
use octocrab::Octocrab;

use crate::external_actions::ExecOutcome;
use crate::models::CiStatus;
use crate::retry::{with_retry, Retryable};

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
/// 쓰기(POST) 재시도 횟수 = 1(재시도 안 함). 코멘트/이슈 생성은 **멱등하지 않다** — 요청이 GitHub에
/// 도달한 뒤 응답만 유실되면(transport drop=transient 분류) 재시도가 **중복 외부 쓰기**(코멘트 2개)를
/// 낸다. 게이트 idempotency_key는 *제안* dedup이지 API 콜 dedup이 아니다. 따라서 쓰기는 재시도 대신
/// 실패를 노출해 사용자가 재제안하게 한다(중복 mutation보다 안전). read 경로는 MAX_ATTEMPTS 유지.
const WRITE_MAX_ATTEMPTS: u32 = 1;

/// 외부 fetch 실패 분류. Transient = 재시도 대상(네트워크·429·5xx),
/// Terminal = 재시도 무의미(인증/권한/검증 등 4xx, 디코드 실패).
#[derive(Debug, Clone, thiserror::Error)]
pub enum GithubError {
    #[error("{0}")]
    Transient(String),
    #[error("{0}")]
    Terminal(String),
}

impl Retryable for GithubError {
    fn is_retryable(&self) -> bool {
        matches!(self, GithubError::Transient(_))
    }
}

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
    /// head 브랜치 이름. provider DTO 계약으로 유지(현재 미읽음 — PR B 표시 전용 전환으로 ticket 추출 경로 제거됨).
    #[allow(dead_code)]
    pub head_ref: String,
    pub is_draft: bool,
    pub state: RawPrState,
    pub ci: CiStatus,
    pub has_conflict: bool,
    /// 마지막 갱신 시각(RFC3339). age/stale 계산 기준.
    pub updated_at: String,
    /// head 커밋 SHA. provider DTO 계약으로 유지(현재 미읽음 — PR B 표시 전용 전환으로 CI 실패 알림 경로 제거됨).
    #[allow(dead_code)]
    pub head_sha: String,
    /// 댓글 수 (comments + review_comments). open PR만 채움(bounded per-PR get). merged는 0.
    /// 가져오기 실패 시 0으로 degrade(레이더 전체 실패 방지).
    pub comment_count: u32,
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

    /// 레포 접근 가능성 확인(추가 전 검증): 토큰으로 `GET /repos/{owner}/{repo}` 1회(bounded retry).
    /// 404/403(없는 레포·권한 없음)은 Terminal로 분류돼 호출부가 액션 가능 에러로 매핑한다.
    pub async fn check_repo_access(&self, repo_full_name: &str) -> Result<(), GithubError> {
        let (owner, repo) = parse_owner_repo(repo_full_name).ok_or_else(|| {
            GithubError::Terminal(format!("레포 형식 파싱 실패: {repo_full_name}"))
        })?;
        with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| async {
            self.octo
                .repos(&owner, &repo)
                .get()
                .await
                .map(|_| ())
                .map_err(|e| classify_octocrab(&e))
        })
        .await
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
                // LIST endpoint에 댓글 수가 없어 건당 get 1회(ci_for_sha와 동일 패턴, bounded retry).
                // 실패 시 0으로 degrade — 레이더 전체 실패 방지(INVARIANT #5).
                let comment_count = with_retry(MAX_ATTEMPTS, BASE_DELAY, |_| async {
                    self.octo
                        .pulls(&owner, &repo)
                        .get(pr.number)
                        .await
                        .map_err(|e| classify_octocrab(&e))
                })
                .await
                .map(|full| (full.comments.unwrap_or(0) + full.review_comments.unwrap_or(0)) as u32)
                .unwrap_or(0);
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
                    head_sha,
                    comment_count,
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
                head_sha: pr.head.sha.clone(),
                comment_count: 0, // merged PR은 extra get 없음(bounded).
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

// ── External Action Gate: GitHub WRITE 커넥터(Phase 2) ───────────────────────────
// 제안은 MCP/사용자가 만들고, 실행은 승인 후 여기서만(Rust·토큰 keychain·bounded retry).
// `GithubWriter`는 `PrProvider`(read)와 대칭 seam — mock impl로 네트워크 없이 dispatch 검증.

/// GitHub 쓰기 seam. 실 impl=`HttpPrProvider`(octocrab), 테스트=mock.
/// **반환은 게이트의 `ExecOutcome` 직접**(#12) — 별도 평행 타입(`GithubWriteOutcome`)을 두면
/// `ExecOutcome`에 Phase 3~5가 필드를 추가할 때 GitHub 경로가 컴파일 에러 없이 그 필드를 조용히
/// 누락한다. 단일 outcome 모양을 공유해 그 회귀를 타입으로 막는다.
pub trait GithubWriter {
    /// 이슈/PR(`owner/repo`, `issue_number`)에 코멘트를 단다(bounded retry).
    fn create_issue_comment(
        &self,
        repo_full_name: &str,
        issue_number: u64,
        body: &str,
    ) -> impl std::future::Future<Output = Result<ExecOutcome, GithubError>> + Send;

    /// 이슈를 생성한다(bounded retry).
    fn create_issue(
        &self,
        repo_full_name: &str,
        title: &str,
        body: &str,
    ) -> impl std::future::Future<Output = Result<ExecOutcome, GithubError>> + Send;
}

impl GithubWriter for HttpPrProvider {
    async fn create_issue_comment(
        &self,
        repo_full_name: &str,
        issue_number: u64,
        body: &str,
    ) -> Result<ExecOutcome, GithubError> {
        let (owner, repo) = parse_owner_repo(repo_full_name).ok_or_else(|| {
            GithubError::Terminal(format!("레포 형식 파싱 실패: {repo_full_name}"))
        })?;
        let comment = with_retry(WRITE_MAX_ATTEMPTS, BASE_DELAY, |_| async {
            self.octo
                .issues(owner.as_str(), repo.as_str())
                .create_comment(issue_number, body)
                .await
                .map_err(|e| classify_octocrab(&e))
        })
        .await?;
        Ok(ExecOutcome {
            external_ref: Some(comment.html_url.to_string()),
            bytes: Some(body.len() as i64),
        })
    }

    async fn create_issue(
        &self,
        repo_full_name: &str,
        title: &str,
        body: &str,
    ) -> Result<ExecOutcome, GithubError> {
        let (owner, repo) = parse_owner_repo(repo_full_name).ok_or_else(|| {
            GithubError::Terminal(format!("레포 형식 파싱 실패: {repo_full_name}"))
        })?;
        let issue = with_retry(WRITE_MAX_ATTEMPTS, BASE_DELAY, |_| async {
            self.octo
                .issues(owner.as_str(), repo.as_str())
                .create(title)
                .body(body)
                .send()
                .await
                .map_err(|e| classify_octocrab(&e))
        })
        .await?;
        Ok(ExecOutcome {
            external_ref: Some(issue.html_url.to_string()),
            bytes: Some((title.len() + body.len()) as i64),
        })
    }
}

/// cref(=project credential_ref)로 keychain GitHub 토큰을 읽어 `HttpPrProvider`를 만든다.
/// **read(`pr_radar`)와 write(`external_actions` 라우터) 양쪽이 공유하는 단일 토큰→클라이언트 레시피(#13).**
/// 이전엔 두 곳이 같은 레시피를 복제해 에러 코드가 drift했다(`pr_radar.token_missing` vs
/// `external_action.github_token_missing`) — 단일 `github.token_missing`으로 통일한다.
/// 토큰 본문은 여기서만 쓰이고 노출/로그되지 않는다(INVARIANT #7).
// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용(pr_radar/google_sync 등과 동일).
#[allow(clippy::result_large_err)]
pub fn github_provider_for_cref(cref: &str) -> Result<HttpPrProvider, crate::error::AppError> {
    use crate::error::AppError;
    let token =
        crate::keychain::get_token(cref, crate::models::TokenKind::Github)?.ok_or_else(|| {
            AppError::not_found(
                "github.token_missing",
                "GitHub 토큰이 없습니다(설정에서 저장 필요)",
            )
        })?;
    Ok(HttpPrProvider::new(&token)?)
}

/// 레포 접근 검증 실패 → 사용자 액션 가능한 AppError 매핑(순수 — 테스트 가능).
/// Terminal(404/403/파싱 등 = 입력/권한 문제) → validation(`repos.inaccessible`),
/// Transient(네트워크/429/5xx = 일시적) → terminal(`repos.access_check_failed`).
pub fn map_repo_access_error(repo_full_name: &str, e: GithubError) -> crate::error::AppError {
    use crate::error::AppError;
    match e {
        GithubError::Terminal(msg) => AppError::validation(
            "repos.inaccessible",
            format!(
                "'{repo_full_name}' 레포에 접근할 수 없습니다 — URL과 GitHub 토큰 권한을 확인하세요 ({msg})"
            ),
        ),
        GithubError::Transient(msg) => AppError::terminal(
            "repos.access_check_failed",
            format!("레포 접근 확인 실패(일시적) — 잠시 후 다시 시도하세요 ({msg})"),
        ),
    }
}

/// cref의 GitHub 토큰으로 레포 접근 가능성을 검증한다(추가 전 게이트). 토큰 없음=`github.token_missing`,
/// 접근 불가=`repos.inaccessible`. Local 레포·빈 URL은 호출부(`create_repo`)가 먼저 거른다.
// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용(github_provider_for_cref 등과 동일).
#[allow(clippy::result_large_err)]
pub async fn validate_github_repo_access(
    cref: &str,
    repo_full_name: &str,
) -> Result<(), crate::error::AppError> {
    let provider = github_provider_for_cref(cref)?;
    provider
        .check_repo_access(repo_full_name)
        .await
        .map_err(|e| map_repo_access_error(repo_full_name, e))
}

/// 승인된 GitHub 액션을 적절한 writer 메서드로 dispatch한다. 키체인/네트워크 없는 **순수 dispatch**
/// (mock writer로 단위 테스트 가능). 비-GitHub 액션은 호출 측 라우터가 거르지만 방어적으로 거부한다.
/// writer가 게이트 `ExecOutcome`를 직접 반환하므로 필드별 재매핑이 없다(#12 — 미래 필드 누락 방지).
pub(crate) async fn execute_github_action<W: GithubWriter>(
    writer: &W,
    action: &crate::external_actions::ExternalAction,
) -> Result<ExecOutcome, crate::error::AppError> {
    use crate::external_actions::ExternalAction;
    let outcome = match action {
        ExternalAction::GithubIssueComment {
            repo,
            issue_number,
            body,
        } => {
            writer
                .create_issue_comment(repo, *issue_number, body)
                .await?
        }
        ExternalAction::GithubCreateIssue { repo, title, body } => {
            writer.create_issue(repo, title, body).await?
        }
        other => {
            return Err(crate::error::AppError::unexpected(
                "github.dispatch.kind",
                format!("GitHub 커넥터가 처리할 수 없는 액션: {}", other.kind_str()),
            ));
        }
    };
    Ok(outcome)
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

    /// 레포 접근 검증 에러 매핑: Terminal=입력/권한(validation), Transient=일시적(terminal).
    #[test]
    fn map_repo_access_error_classifies() {
        let term =
            map_repo_access_error("o/r", GithubError::Terminal("HTTP 404: Not Found".into()));
        assert_eq!(term.code, "repos.inaccessible");
        let trans = map_repo_access_error("o/r", GithubError::Transient("net".into()));
        assert_eq!(trans.code, "repos.access_check_failed");
    }
}

#[cfg(test)]
mod write_tests {
    use super::*;
    use crate::external_actions::ExternalAction;
    use std::sync::Mutex;

    /// 네트워크 없는 mock writer — 호출 인자를 기록해 dispatch 라우팅을 검증한다.
    #[derive(Default)]
    struct MockWriter {
        comment_calls: Mutex<Vec<(String, u64, String)>>,
        issue_calls: Mutex<Vec<(String, String, String)>>,
    }
    impl GithubWriter for MockWriter {
        async fn create_issue_comment(
            &self,
            repo: &str,
            issue_number: u64,
            body: &str,
        ) -> Result<ExecOutcome, GithubError> {
            self.comment_calls
                .lock()
                .unwrap()
                .push((repo.into(), issue_number, body.into()));
            Ok(ExecOutcome {
                external_ref: Some("https://gh/comment/1".into()),
                bytes: Some(body.len() as i64),
            })
        }
        async fn create_issue(
            &self,
            repo: &str,
            title: &str,
            body: &str,
        ) -> Result<ExecOutcome, GithubError> {
            self.issue_calls
                .lock()
                .unwrap()
                .push((repo.into(), title.into(), body.into()));
            Ok(ExecOutcome {
                external_ref: Some("https://gh/issue/2".into()),
                bytes: Some((title.len() + body.len()) as i64),
            })
        }
    }

    #[tokio::test]
    async fn dispatch_routes_issue_comment_to_writer() {
        let w = MockWriter::default();
        let action = ExternalAction::GithubIssueComment {
            repo: "o/r".into(),
            issue_number: 7,
            body: "hi".into(),
        };
        let out = execute_github_action(&w, &action).await.unwrap();
        assert_eq!(out.external_ref.as_deref(), Some("https://gh/comment/1"));
        assert_eq!(out.bytes, Some(2));
        assert_eq!(
            w.comment_calls.lock().unwrap().as_slice(),
            &[("o/r".to_string(), 7u64, "hi".to_string())]
        );
        assert!(w.issue_calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dispatch_routes_create_issue_to_writer() {
        let w = MockWriter::default();
        let action = ExternalAction::GithubCreateIssue {
            repo: "o/r".into(),
            title: "T".into(),
            body: "B".into(),
        };
        let out = execute_github_action(&w, &action).await.unwrap();
        assert_eq!(out.external_ref.as_deref(), Some("https://gh/issue/2"));
        assert_eq!(
            w.issue_calls.lock().unwrap().as_slice(),
            &[("o/r".to_string(), "T".to_string(), "B".to_string())]
        );
        assert!(w.comment_calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn dispatch_rejects_non_github_action() {
        let w = MockWriter::default();
        let action = ExternalAction::Noop { note: "x".into() };
        assert!(execute_github_action(&w, &action).await.is_err());
    }
}
