use tauri::State;

use crate::commands::notification_store;
use crate::commands::signal_store;
use crate::commands::tokens::project_credential_ref;
use crate::db::Db;
use crate::error::AppError;
use crate::github::{HttpPrProvider, PrProvider, RawPr, RawPrState};
use crate::keychain;
use crate::models::{CiStatus, PrRadarItem, ReadinessBucket, TokenKind};
use crate::retry::Retryable;

// ── PR Radar (Phase 4, read 레일) ──────────────────────────────────────────────
// INVARIANT #1: escalate 신호는 항상 quadrant=unclassified로 진입(자동 분류 0); suggested_quadrant=q1는
//   힌트일 뿐. dedup upsert(ON CONFLICT)도 quadrant/status를 절대 덮어쓰지 않는다(사람 결정 보존).
// INVARIANT #3: pr:{owner}/{repo}:{number}:{reason} 안정 키로 upsert(중복 0) + 원인 해소 시 auto-resolve.
// INVARIANT #4: 모든 PR은 radar 자기 뷰(버킷)에 살고, 임계치(CI 실패+링크 티켓) 넘는 것만 escalate.
// INVARIANT #5: 폴링/재시도 bounded(github.rs with_retry + 프런트 refetchInterval).
// INVARIANT #7: 토큰은 keychain에서만 읽혀 Rust 안에서만. refresh 인자에 token 없음.

/// open PR이 이 일수 이상 미갱신이면 Stale 버킷.
const STALE_DAYS: i64 = 14;
/// 댓글이 이 수를 초과하면 is_suspicious = true (시각 경고 힌트, 결정 레일 미침범).
const SUSPICIOUS_COMMENT_THRESHOLD: u32 = 10;
/// escalate 사유 (dedup_key의 reason 세그먼트). Phase 4는 CI 실패만.
const ESCALATE_REASON_CI: &str = "ci_failed";

/// fetch 대상 레포 (escalate/auto-resolve 스코프). full_name = 'owner/repo'.
struct RepoRef {
    full_name: String,
    /// ticketKeyPattern (repo 우선, 없으면 project). 링크 백로그 티켓 추출용.
    ticket_pattern: Option<String>,
}

/// ticketKeyPattern(regex)으로 PR title 우선, head_ref 차선에서 첫 매칭 티켓을 추출한다.
/// 패턴이 없거나 잘못된 regex면 무매칭(graceful — noise 0).
fn extract_ticket(pattern: Option<&str>, title: &str, head_ref: &str) -> Option<String> {
    let pat = pattern?.trim();
    if pat.is_empty() {
        return None;
    }
    let re = regex::Regex::new(pat).ok()?;
    re.find(title)
        .or_else(|| re.find(head_ref))
        .map(|m| m.as_str().to_string())
}

/// updated_at(RFC3339) 기준 경과일(>=0). 파싱 실패 시 0.
fn elapsed_days(updated_at: &str, now: chrono::DateTime<chrono::Utc>) -> i64 {
    chrono::DateTime::parse_from_rfc3339(updated_at)
        .map(|d| (now - d.with_timezone(&chrono::Utc)).num_days().max(0))
        .unwrap_or(0)
}

/// readiness 버킷 분류(순수 — 테스트 가능). 우선순위:
/// Merged Cleanup > CI Blocked(CI 실패 또는 conflict) > Stale > Needs Self Check(draft/미체크) > Ready.
fn classify_bucket(pr: &RawPr, self_checked: bool, elapsed: i64) -> ReadinessBucket {
    match pr.state {
        RawPrState::Merged => ReadinessBucket::MergedCleanup,
        RawPrState::Open => {
            if matches!(pr.ci, CiStatus::Failing) || pr.has_conflict {
                ReadinessBucket::CiBlocked
            } else if elapsed >= STALE_DAYS {
                ReadinessBucket::Stale
            } else if pr.is_draft || !self_checked {
                ReadinessBucket::NeedsSelfCheck
            } else {
                ReadinessBucket::Ready
            }
        }
    }
}

/// escalate 사유 (사용자 결정: CI 실패 + 링크 백로그 티켓). 그 외는 None(매트릭스에 안 올라옴).
fn escalation_reason(pr: &RawPr, ticket: &Option<String>) -> Option<&'static str> {
    if matches!(pr.state, RawPrState::Open)
        && matches!(pr.ci, CiStatus::Failing)
        && ticket.is_some()
    {
        Some(ESCALATE_REASON_CI)
    } else {
        None
    }
}

/// PR이 self-check(로컬 상태)됐는지.
async fn pr_self_checked(db: &Db, repo_full_name: &str, number: u64) -> Result<bool, sqlx::Error> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM pr_self_checks WHERE repo_full_name = ?1 AND pr_number = ?2")
            .bind(repo_full_name)
            .bind(number as i64)
            .fetch_optional(db)
            .await?;
    Ok(row.is_some())
}

/// PR 신호 dedup upsert(INVARIANT #3). 항상 unclassified 진입 + suggested q1 힌트(INVARIANT #1).
/// PR 신호 links 페이로드(내부 — signals.links JSON). 앱이 통제하므로 타입화(camelCase 보존).
/// 프런트가 PR 링크 렌더에 소비. (codex proposal 등 외부 페이로드는 문자열 유지 — 별개.)
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PrSignalLinks {
    github_pr_url: String,
}

/// 충돌 시 quadrant/status는 보존하고 title/body/links/suggested_quadrant/updated_at만 갱신한다.
async fn upsert_pr_signal(
    db: &Db,
    project_id: &str,
    repo_full_name: &str,
    pr: &RawPr,
    ticket: &Option<String>,
    dedup_key: &str,
) -> Result<(), sqlx::Error> {
    let title = format!(
        "[{}] PR #{} CI 실패: {}",
        repo_full_name, pr.number, pr.title
    );
    let body = match ticket {
        Some(t) => format!("{} · 링크 티켓 {}", pr.url, t),
        None => pr.url.clone(),
    };
    let links = serde_json::to_string(&PrSignalLinks {
        github_pr_url: pr.url.clone(),
    })
    .map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    signal_store::upsert_pr_signal(db, project_id, &title, &body, dedup_key, &links).await
}

/// CI 실패 알림을 큐에 넣는다(Phase 20 #17). 자동 triage 없음 — 네이티브 알림 + Q1 escalate(상위
/// upsert_pr_signal)까지만, 실제 결정은 사람이 한다(INVARIANT #1). dedup은 PR+head_sha 기준
/// `source_id`로 멱등(같은 커밋 = 같은 실패, 재알림 0; 새 커밋이 또 실패하면 1회 알림 — INVARIANT #5).
/// fire_at=now라 백그라운드 스케줄러(scheduler.rs)가 다음 틱에 발사한다(창 닫혀도 트레이 상주로 발사).
/// 발사 마커는 `scheduled_notifications`(로컬 SQLite SSOT — INVARIANT #7).
async fn enqueue_ci_failure_notification(
    db: &Db,
    repo_full_name: &str,
    pr: &RawPr,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), sqlx::Error> {
    // head_sha가 비면(예: 비정상 응답) PR 번호로만 dedup해 폭주는 막되 알림은 보낸다.
    let sha = if pr.head_sha.is_empty() {
        "nosha".to_string()
    } else {
        pr.head_sha.clone()
    };
    let source_id = format!("pr:{repo_full_name}:{}:{sha}", pr.number);

    // 멱등: 같은 source_id 행이 (미발사든 발사든) 이미 있으면 다시 만들지 않는다(중복 알림 0).
    if notification_store::exists(db, "ci", &source_id).await? {
        return Ok(());
    }

    let title = format!("CI 실패: {repo_full_name} #{}", pr.number);
    let body = format!("{} — {} · Q1 결정 큐로 올렸습니다.", pr.title, pr.url);
    let fire_at = now.format("%Y-%m-%d %H:%M:%S").to_string();
    notification_store::enqueue(db, &fire_at, &title, &body, "ci", Some(&source_id)).await?;
    Ok(())
}

/// auto-resolve(INVARIANT #3): 성공 fetch된 repo 범위에서, 이번 cycle active set 밖의 github_pr
/// 신호를 status=done으로 전이(매트릭스에서 소멸). fetch 실패 repo는 fresh 데이터가 없어 제외된다.
async fn auto_resolve(
    db: &Db,
    project_id: &str,
    fetched_full_names: &[String],
    active_keys: &[String],
) -> Result<(), sqlx::Error> {
    let rows = signal_store::fetch_pr_signal_keys(db, project_id).await?;
    for (id, key) in rows {
        let Some(key) = key else { continue };
        // 이 cycle에 fetch한 repo의 신호인가? (정확 prefix — LIKE 와일드카드 회피)
        let in_fetched = fetched_full_names
            .iter()
            .any(|r| key.starts_with(&format!("pr:{r}:")));
        if in_fetched && !active_keys.iter().any(|k| k == &key) {
            signal_store::mark_signal_done(db, &id).await?;
        }
    }
    Ok(())
}

/// PR Radar 동기화 코어(테스트 가능 — provider를 fake로 대체). keychain/네트워크는 호출자(command)가 담당.
/// 각 repo의 PR을 fetch → 버킷 분류 + escalate(dedup upsert) → 마지막에 auto-resolve.
/// 일부 repo fetch 실패는 그 repo만 건너뛰고(해당 신호 auto-resolve 제외), 전부 실패면 Err로 노출(삼키지 않음).
// AppError는 리치 에러 envelope이라 의도적으로 크다(커맨드는 매크로로 면제됨). 이 코어는 command와
// 동일한 AppError를 그대로 전파해 transient 분류를 보존하므로 large-err 린트를 국소 허용한다(agents/mod.rs와 동일 패턴).
#[allow(clippy::result_large_err)]
async fn sync_pr_radar<P: PrProvider>(
    db: &Db,
    provider: &P,
    project_id: &str,
    repos: &[RepoRef],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<PrRadarItem>, AppError> {
    let mut items: Vec<PrRadarItem> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    // 전부 실패 시 분류 보존(INVARIANT #5): 모든 실패가 transient면 transient(재시도 가능),
    // 하나라도 terminal이면 terminal(재시도로 못 고침). GithubError가 스스로 분류(Retryable).
    let mut all_transient = true;
    let mut fetched_full_names: Vec<String> = Vec::new();
    let mut active_keys: Vec<String> = Vec::new();

    for repo in repos {
        let prs = match provider.fetch_prs(&repo.full_name).await {
            Ok(p) => p,
            Err(e) => {
                all_transient &= e.is_retryable();
                errors.push(format!("{}: {e}", repo.full_name));
                continue;
            }
        };
        fetched_full_names.push(repo.full_name.clone());

        for pr in &prs {
            let ticket = extract_ticket(repo.ticket_pattern.as_deref(), &pr.title, &pr.head_ref);
            let self_checked = pr_self_checked(db, &repo.full_name, pr.number).await?;
            let elapsed = elapsed_days(&pr.updated_at, now);
            let bucket = classify_bucket(pr, self_checked, elapsed);

            let mut escalated = false;
            if let Some(reason) = escalation_reason(pr, &ticket) {
                let dedup = format!("pr:{}:{}:{}", repo.full_name, pr.number, reason);
                upsert_pr_signal(db, project_id, &repo.full_name, pr, &ticket, &dedup).await?;
                active_keys.push(dedup);
                escalated = true;
                // CI 실패 → 네이티브 알림 큐잉(자동 triage 없음, PR+SHA dedup — Phase 20 #17).
                enqueue_ci_failure_notification(db, &repo.full_name, pr, now).await?;
            }

            items.push(PrRadarItem {
                repo_full_name: repo.full_name.clone(),
                number: pr.number as u32,
                title: pr.title.clone(),
                url: pr.url.clone(),
                author_login: pr.author_login.clone(),
                bucket,
                ci: pr.ci,
                has_conflict: pr.has_conflict,
                is_draft: pr.is_draft,
                linked_ticket: ticket,
                self_checked,
                age_days: elapsed.max(0) as u32,
                escalated,
                project_id: project_id.to_string(),
                comment_count: pr.comment_count,
                is_suspicious: pr.comment_count > SUSPICIOUS_COMMENT_THRESHOLD,
            });
        }
    }

    auto_resolve(db, project_id, &fetched_full_names, &active_keys).await?;

    // 전부 실패(레포는 있는데 하나도 못 가져옴)면 failure 노출(INVARIANT #5: 삼키지 않음).
    // 전부 transient면 transient로 보존해 프런트 bounded retry가 동작하게 한다(retryable=true).
    if fetched_full_names.is_empty() && !repos.is_empty() {
        let msg = format!("모든 레포 fetch 실패 — {}", errors.join("; "));
        return Err(if all_transient {
            AppError::transient("pr_radar.sync_transient", msg)
        } else {
            AppError::terminal("pr_radar.sync", msg)
        });
    }
    Ok(items)
}

/// project의 enabled github 레포 + ticketKeyPattern(repo 우선, 없으면 project) 로드.
async fn fetch_github_repo_refs(db: &Db, project_id: &str) -> Result<Vec<RepoRef>, String> {
    let rows: Vec<(Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT r.remote_url, COALESCE(r.ticket_key_pattern, p.ticket_key_pattern) \
         FROM repos r JOIN projects p ON p.id = r.project_id \
         WHERE r.project_id = ?1 AND r.provider = 'github' AND r.enabled = 1 \
         ORDER BY r.created_at",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;

    let mut refs = Vec::new();
    for (remote_url, ticket_pattern) in rows {
        let Some(url) = remote_url else { continue };
        let Some((owner, repo)) = crate::github::parse_owner_repo(&url) else {
            continue;
        };
        refs.push(RepoRef {
            full_name: format!("{owner}/{repo}"),
            ticket_pattern,
        });
    }
    Ok(refs)
}

/// PR Radar 새로고침(주기 폴링의 한 cycle). project의 github 레포 PR을 버킷별로 도출하고
/// 임계치 넘는 것만 매트릭스로 escalate(dedup)·원인 해소분 auto-resolve. 토큰은 keychain에서만.
#[tauri::command]
#[specta::specta]
pub async fn refresh_pr_radar(
    db: State<'_, Db>,
    project_id: String,
) -> Result<Vec<PrRadarItem>, AppError> {
    let repos = fetch_github_repo_refs(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("pr_radar.fetch_repos", e))?;
    if repos.is_empty() {
        return Ok(Vec::new());
    }
    let cref = project_credential_ref(db.inner(), &project_id)
        .await
        .map_err(|e| AppError::terminal("pr_radar.project_not_found", e))?;
    let token = keychain::get_token(&cref, TokenKind::Github)?.ok_or_else(|| {
        AppError::not_found(
            "pr_radar.token_missing",
            "GitHub 토큰이 없음(설정에서 토큰 저장 필요)",
        )
    })?;
    let provider = HttpPrProvider::new(&token)?;
    sync_pr_radar(
        db.inner(),
        &provider,
        &project_id,
        &repos,
        chrono::Utc::now(),
    )
    .await
}

// DEPRECATED: UI의 수동 체크박스는 제거됨(PR B4). 커맨드·바인딩·pr_self_checks 테이블은 보존 —
// classify_bucket이 self_checked를 여전히 사용하고, 외부 클라이언트가 이 커맨드에 의존할 수 있음.
/// 수동 self-check 토글(로컬 상태). checked면 행 추가, 아니면 삭제(다음 도출이 반영).
#[tauri::command]
#[specta::specta]
pub async fn set_pr_self_check(
    db: State<'_, Db>,
    repo_full_name: String,
    pr_number: u32,
    checked: bool,
) -> Result<(), AppError> {
    if checked {
        sqlx::query(
            "INSERT OR IGNORE INTO pr_self_checks (id, repo_full_name, pr_number) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2)",
        )
        .bind(&repo_full_name)
        .bind(pr_number as i64)
        .execute(db.inner())
        .await?;
    } else {
        sqlx::query("DELETE FROM pr_self_checks WHERE repo_full_name = ?1 AND pr_number = ?2")
            .bind(&repo_full_name)
            .bind(pr_number as i64)
            .execute(db.inner())
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::projects::insert_project;
    use crate::commands::shared::test_support::*;
    use crate::commands::signal_store::set_quadrant;
    use crate::error::ErrorKind;
    use crate::github::GithubError;
    use crate::models::ProjectKind;

    /// links 구조체가 기존 camelCase 키(githubPrUrl)를 그대로 직렬화하는지 잠근다(프런트 계약).
    #[test]
    fn pr_signal_links_serialize_to_stable_camelcase_key() {
        let s = serde_json::to_string(&PrSignalLinks {
            github_pr_url: "https://x/pr/1".into(),
        })
        .unwrap();
        assert_eq!(s, r#"{"githubPrUrl":"https://x/pr/1"}"#);
    }
    use crate::models::Quadrant;

    /// fake PR provider — 정해둔 PR 목록을 돌려준다(폴링 cycle 간 set으로 교체 가능). 실 네트워크 없음.
    struct FakeProvider {
        prs: std::sync::Mutex<Vec<RawPr>>,
        fail: bool,
        fail_terminal: bool,
    }
    impl FakeProvider {
        fn new(prs: Vec<RawPr>) -> Self {
            Self {
                prs: std::sync::Mutex::new(prs),
                fail: false,
                fail_terminal: false,
            }
        }
        fn failing() -> Self {
            Self {
                prs: std::sync::Mutex::new(Vec::new()),
                fail: true,
                fail_terminal: false,
            }
        }
        fn failing_terminal() -> Self {
            Self {
                prs: std::sync::Mutex::new(Vec::new()),
                fail: false,
                fail_terminal: true,
            }
        }
        fn set(&self, prs: Vec<RawPr>) {
            *self.prs.lock().unwrap() = prs;
        }
    }
    impl PrProvider for FakeProvider {
        async fn fetch_prs(&self, _repo_full_name: &str) -> Result<Vec<RawPr>, GithubError> {
            if self.fail_terminal {
                return Err(GithubError::Terminal("forbidden".into()));
            }
            if self.fail {
                return Err(GithubError::Transient("net down".into()));
            }
            let prs = self.prs.lock().unwrap().clone();
            Ok(prs)
        }
        async fn fetch_pr_diff(
            &self,
            _repo_full_name: &str,
            _number: u64,
        ) -> Result<String, GithubError> {
            Ok("diff --git a/x b/x".into())
        }
    }

    fn raw_pr(number: u64, ci: CiStatus, state: RawPrState, title: &str) -> RawPr {
        RawPr {
            number,
            title: title.into(),
            url: format!("https://github.com/o/r/pull/{number}"),
            author_login: "me".into(),
            head_ref: "feature".into(),
            is_draft: false,
            state,
            ci,
            has_conflict: false,
            updated_at: "2026-05-21T00:00:00Z".into(),
            head_sha: format!("sha-{number}"),
            comment_count: 0,
        }
    }

    fn fixed_now() -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::parse_from_rfc3339("2026-05-21T12:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc)
    }

    fn repo_refs() -> Vec<RepoRef> {
        vec![RepoRef {
            full_name: "o/r".into(),
            ticket_pattern: Some(r"MIR-DEV-\d+".into()),
        }]
    }

    /// 매트릭스에 살아있는(active) github_pr 신호: (quadrant, suggested_quadrant, status, dedup_key, links).
    async fn pr_signals(
        db: &Db,
    ) -> Vec<(
        String,
        Option<String>,
        String,
        Option<String>,
        Option<String>,
    )> {
        sqlx::query_as(
            "SELECT quadrant, suggested_quadrant, status, dedup_key, links \
             FROM signals WHERE source = 'github_pr' ORDER BY created_at",
        )
        .fetch_all(db)
        .await
        .unwrap()
    }

    /// (0) is_suspicious: comment_count > 10이면 true, 10 이하면 false.
    #[test]
    fn suspicious_comment_threshold() {
        let mut pr = raw_pr(1, CiStatus::Passing, RawPrState::Open, "x");
        // 경계: 10은 초과 아님 → false.
        pr.comment_count = 10;
        assert!(
            pr.comment_count <= SUSPICIOUS_COMMENT_THRESHOLD,
            "10개는 suspicious 아님"
        );
        // 경계+1: 11은 초과 → true.
        pr.comment_count = 11;
        assert!(
            pr.comment_count > SUSPICIOUS_COMMENT_THRESHOLD,
            "11개는 suspicious"
        );
        // 0개는 false.
        pr.comment_count = 0;
        assert!(
            pr.comment_count <= SUSPICIOUS_COMMENT_THRESHOLD,
            "0개는 suspicious 아님"
        );
    }

    /// (1) 버킷 분류가 5개 버킷을 입력별로 정확히 도출.
    #[test]
    fn bucket_classification_covers_all_five() {
        let merged = raw_pr(1, CiStatus::None, RawPrState::Merged, "done");
        assert_eq!(
            classify_bucket(&merged, false, 0),
            ReadinessBucket::MergedCleanup
        );

        let blocked = raw_pr(2, CiStatus::Failing, RawPrState::Open, "x");
        assert_eq!(
            classify_bucket(&blocked, true, 0),
            ReadinessBucket::CiBlocked
        );

        let mut conflict = raw_pr(3, CiStatus::Passing, RawPrState::Open, "x");
        conflict.has_conflict = true;
        assert_eq!(
            classify_bucket(&conflict, true, 0),
            ReadinessBucket::CiBlocked
        );

        let stale = raw_pr(4, CiStatus::Passing, RawPrState::Open, "x");
        assert_eq!(classify_bucket(&stale, true, 30), ReadinessBucket::Stale);

        let needs = raw_pr(5, CiStatus::Passing, RawPrState::Open, "x");
        assert_eq!(
            classify_bucket(&needs, false, 0),
            ReadinessBucket::NeedsSelfCheck
        );
        let mut draft = raw_pr(6, CiStatus::Passing, RawPrState::Open, "x");
        draft.is_draft = true;
        assert_eq!(
            classify_bucket(&draft, true, 0),
            ReadinessBucket::NeedsSelfCheck
        );

        let ready = raw_pr(7, CiStatus::Passing, RawPrState::Open, "x");
        assert_eq!(classify_bucket(&ready, true, 0), ReadinessBucket::Ready);
    }

    /// (2) CI 실패 + 링크 티켓 → 정확히 1 신호(unclassified + suggested q1 + dedup + links).
    #[tokio::test]
    async fn escalates_ci_failed_with_ticket() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::new(vec![raw_pr(
            42,
            CiStatus::Failing,
            RawPrState::Open,
            "MIR-DEV-7 로그인 버그",
        )]);

        let items = sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();

        assert_eq!(items.len(), 1);
        assert!(items[0].escalated, "임계치 초과 → escalated");
        assert_eq!(items[0].linked_ticket.as_deref(), Some("MIR-DEV-7"));
        assert_eq!(items[0].bucket, ReadinessBucket::CiBlocked);

        let sigs = pr_signals(&db).await;
        assert_eq!(sigs.len(), 1, "정확히 1 신호");
        assert_eq!(sigs[0].0, "unclassified", "항상 미분류 진입 (INVARIANT #1)");
        assert_eq!(
            sigs[0].1.as_deref(),
            Some("q1_do_now"),
            "Q1 제안은 힌트로만"
        );
        assert_eq!(sigs[0].3.as_deref(), Some("pr:o/r:42:ci_failed"));
        assert!(sigs[0].4.as_deref().unwrap().contains("githubPrUrl"));
    }

    /// (3) 같은 입력으로 폴링 N회 → 신호 1행 유지(dedup upsert, 중복 0).
    #[tokio::test]
    async fn polling_n_times_no_duplicate() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::new(vec![raw_pr(
            42,
            CiStatus::Failing,
            RawPrState::Open,
            "MIR-DEV-7 버그",
        )]);
        for _ in 0..4 {
            sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
                .await
                .unwrap();
        }
        let n: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM signals WHERE source = 'github_pr'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n.0, 1, "폴링 N회 반복해도 중복 0");
    }

    /// (4) CI 통과로 바뀌면 해당 신호 auto-resolve(status=done).
    #[tokio::test]
    async fn ci_green_auto_resolves() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::new(vec![raw_pr(
            42,
            CiStatus::Failing,
            RawPrState::Open,
            "MIR-DEV-7 버그",
        )]);
        sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();
        assert_eq!(pr_signals(&db).await[0].2, "new", "처음엔 active");

        // CI green으로 바뀜 → 같은 PR이지만 escalate 조건 사라짐.
        provider.set(vec![raw_pr(
            42,
            CiStatus::Passing,
            RawPrState::Open,
            "MIR-DEV-7 버그",
        )]);
        sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();
        assert_eq!(
            pr_signals(&db).await[0].2,
            "done",
            "원인 해소 → auto-resolve"
        );
    }

    /// (5) merged로 바뀌면 auto-resolve(open 목록에서 사라짐 = 원인 해소).
    #[tokio::test]
    async fn merged_auto_resolves() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::new(vec![raw_pr(
            42,
            CiStatus::Failing,
            RawPrState::Open,
            "MIR-DEV-7 버그",
        )]);
        sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();
        provider.set(vec![raw_pr(
            42,
            CiStatus::None,
            RawPrState::Merged,
            "MIR-DEV-7 버그",
        )]);
        sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();
        assert_eq!(pr_signals(&db).await[0].2, "done", "merged → auto-resolve");
    }

    /// (6) 링크 티켓 없으면 escalate 0(CI 실패라도 noise 안 만듦 — INVARIANT #4).
    #[tokio::test]
    async fn no_ticket_no_escalation() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::new(vec![raw_pr(
            42,
            CiStatus::Failing,
            RawPrState::Open,
            "리팩터 (티켓 없음)",
        )]);
        let items = sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();
        assert!(!items[0].escalated);
        let n: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM signals WHERE source = 'github_pr'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n.0, 0, "링크 티켓 없으면 escalate 안 함");
    }

    /// (7) 사람이 classify한 PR 신호는 재sync upsert가 quadrant/status를 덮지 않는다(INVARIANT #1).
    #[tokio::test]
    async fn human_classification_preserved_on_resync() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::new(vec![raw_pr(
            42,
            CiStatus::Failing,
            RawPrState::Open,
            "MIR-DEV-7 버그",
        )]);
        sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();

        // 사람이 Q1으로 분류(결정 레일).
        let id: (String,) =
            sqlx::query_as("SELECT id FROM signals WHERE source = 'github_pr' LIMIT 1")
                .fetch_one(&db)
                .await
                .unwrap();
        set_quadrant(&db, &id.0, Quadrant::Q1DoNow).await.unwrap();

        // 재폴링(같은 실패 PR) → upsert가 사람 결정을 보존해야 함.
        sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();
        let sigs = pr_signals(&db).await;
        assert_eq!(sigs.len(), 1, "여전히 1행");
        assert_eq!(sigs[0].0, "q1_do_now", "사람 분류 보존(quadrant 미덮음)");
        assert_eq!(sigs[0].2, "classified", "사람 status 보존");
    }

    /// 전부 transient(429/5xx) 실패는 transient로 노출 → 프런트 bounded retry 동작(INVARIANT #5).
    /// (회귀 가드: 이전엔 String으로 납작화돼 command가 terminal로 접어 retryable이 false였음.)
    #[tokio::test]
    async fn all_repos_transient_failure_is_retryable() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::failing();
        let err = sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap_err();
        assert_eq!(
            err.kind,
            ErrorKind::Transient,
            "전부 transient 실패 → 분류 보존"
        );
        assert!(err.retryable, "transient은 재시도 가능");
    }

    /// 전부 terminal(4xx 등) 실패는 terminal로 노출(재시도 무의미 — 거짓 retryable 금지).
    #[tokio::test]
    async fn all_repos_terminal_failure_not_retryable() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::failing_terminal();
        let err = sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Terminal, "terminal 분류 보존");
        assert!(!err.retryable, "terminal은 재시도 불가");
    }

    /// 큐잉된 CI 알림 행 (source='ci'): (source_id, title, body).
    async fn ci_notifications(db: &Db) -> Vec<(Option<String>, String, String)> {
        sqlx::query_as(
            "SELECT source_id, title, body FROM scheduled_notifications \
             WHERE source = 'ci' ORDER BY id",
        )
        .fetch_all(db)
        .await
        .unwrap()
    }

    /// (CI 알림 1) CI 실패 + 링크 티켓 escalate → 정확히 1개 CI 알림 큐잉(PR+SHA source_id).
    #[tokio::test]
    async fn ci_failure_enqueues_notification() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::new(vec![raw_pr(
            42,
            CiStatus::Failing,
            RawPrState::Open,
            "MIR-DEV-7 버그",
        )]);
        sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();
        let notes = ci_notifications(&db).await;
        assert_eq!(notes.len(), 1, "CI 실패 → 알림 1개 큐잉");
        assert_eq!(
            notes[0].0.as_deref(),
            Some("pr:o/r:42:sha-42"),
            "dedup source_id = PR+head_sha"
        );
        assert!(notes[0].1.contains("CI 실패"), "제목에 CI 실패 표기");
    }

    /// (CI 알림 2) 같은 실패(같은 SHA)로 폴링 N회 → 알림 1개 유지(중복 알림 0, INVARIANT #5).
    #[tokio::test]
    async fn same_failure_does_not_double_notify() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::new(vec![raw_pr(
            42,
            CiStatus::Failing,
            RawPrState::Open,
            "MIR-DEV-7 버그",
        )]);
        for _ in 0..4 {
            sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
                .await
                .unwrap();
        }
        assert_eq!(
            ci_notifications(&db).await.len(),
            1,
            "같은 SHA 반복 폴링 → 알림 중복 0"
        );
    }

    /// (CI 알림 3) 새 커밋(다른 SHA)이 또 실패하면 새 알림 1개(총 2개). 같은 PR이라도 별개 실패.
    #[tokio::test]
    async fn new_commit_failure_notifies_again() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let mut pr = raw_pr(42, CiStatus::Failing, RawPrState::Open, "MIR-DEV-7 버그");
        let provider = FakeProvider::new(vec![pr.clone()]);
        sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();
        assert_eq!(ci_notifications(&db).await.len(), 1);

        // 새 커밋으로 push했지만 여전히 CI 실패 → 새 SHA → 새 알림.
        pr.head_sha = "sha-42-v2".into();
        provider.set(vec![pr]);
        sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();
        assert_eq!(
            ci_notifications(&db).await.len(),
            2,
            "새 커밋 실패 → 새 알림 1개 추가(총 2)"
        );
    }

    /// (CI 알림 4) 링크 티켓 없는 CI 실패는 escalate 안 함 → 알림도 0(noise 0, INVARIANT #4).
    #[tokio::test]
    async fn no_ticket_no_ci_notification() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::new(vec![raw_pr(
            42,
            CiStatus::Failing,
            RawPrState::Open,
            "리팩터 (티켓 없음)",
        )]);
        sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now())
            .await
            .unwrap();
        assert_eq!(
            ci_notifications(&db).await.len(),
            0,
            "escalate 0 → CI 알림 0"
        );
    }
}
