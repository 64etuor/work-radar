use tauri::State;

use crate::commands::tokens::project_credential_ref;
use crate::db::Db;
use crate::github::{HttpPrProvider, PrProvider, RawPr, RawPrState};
use crate::keychain;
use crate::models::{CiStatus, PrRadarItem, ReadinessBucket, TokenKind};

// ── PR Radar (Phase 4, read 레일) ──────────────────────────────────────────────
// INVARIANT #1: escalate 신호는 항상 quadrant=unclassified로 진입(자동 분류 0); suggested_quadrant=q1는
//   힌트일 뿐. dedup upsert(ON CONFLICT)도 quadrant/status를 절대 덮어쓰지 않는다(사람 결정 보존).
// INVARIANT #3: pr:{owner}/{repo}:{number}:{reason} 안정 키로 upsert(중복 0) + 원인 해소 시 auto-resolve.
// INVARIANT #4: 모든 PR은 radar 자기 뷰(버킷)에 살고, 임계치(CI 실패+링크 티켓) 넘는 것만 escalate.
// INVARIANT #5: 폴링/재시도 bounded(github.rs with_retry + 프런트 refetchInterval).
// INVARIANT #7: 토큰은 keychain에서만 읽혀 Rust 안에서만. refresh 인자에 token 없음.

/// open PR이 이 일수 이상 미갱신이면 Stale 버킷.
const STALE_DAYS: i64 = 14;
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
    let links = serde_json::json!({ "githubPrUrl": pr.url }).to_string();
    sqlx::query(
        "INSERT INTO signals \
            (id, project_id, title, body, source, type, quadrant, suggested_quadrant, dedup_key, status, links) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, 'github_pr', 'pr_attention', \
                 'unclassified', 'q1_do_now', ?4, 'new', ?5) \
         ON CONFLICT(dedup_key) WHERE dedup_key IS NOT NULL DO UPDATE SET \
            title = excluded.title, body = excluded.body, links = excluded.links, \
            suggested_quadrant = excluded.suggested_quadrant, updated_at = datetime('now')",
    )
    .bind(project_id)
    .bind(&title)
    .bind(&body)
    .bind(dedup_key)
    .bind(&links)
    .execute(db)
    .await?;
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
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT id, dedup_key FROM signals \
         WHERE source = 'github_pr' AND project_id = ?1 AND status NOT IN ('done','archived')",
    )
    .bind(project_id)
    .fetch_all(db)
    .await?;
    for (id, key) in rows {
        let Some(key) = key else { continue };
        // 이 cycle에 fetch한 repo의 신호인가? (정확 prefix — LIKE 와일드카드 회피)
        let in_fetched = fetched_full_names
            .iter()
            .any(|r| key.starts_with(&format!("pr:{r}:")));
        if in_fetched && !active_keys.iter().any(|k| k == &key) {
            sqlx::query(
                "UPDATE signals SET status = 'done', updated_at = datetime('now') WHERE id = ?1",
            )
            .bind(&id)
            .execute(db)
            .await?;
        }
    }
    Ok(())
}

/// PR Radar 동기화 코어(테스트 가능 — provider를 fake로 대체). keychain/네트워크는 호출자(command)가 담당.
/// 각 repo의 PR을 fetch → 버킷 분류 + escalate(dedup upsert) → 마지막에 auto-resolve.
/// 일부 repo fetch 실패는 그 repo만 건너뛰고(해당 신호 auto-resolve 제외), 전부 실패면 Err로 노출(삼키지 않음).
async fn sync_pr_radar<P: PrProvider>(
    db: &Db,
    provider: &P,
    project_id: &str,
    repos: &[RepoRef],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<PrRadarItem>, String> {
    let mut items: Vec<PrRadarItem> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut fetched_full_names: Vec<String> = Vec::new();
    let mut active_keys: Vec<String> = Vec::new();

    for repo in repos {
        let prs = match provider.fetch_prs(&repo.full_name).await {
            Ok(p) => p,
            Err(e) => {
                errors.push(format!("{}: {e}", repo.full_name));
                continue;
            }
        };
        fetched_full_names.push(repo.full_name.clone());

        for pr in &prs {
            let ticket = extract_ticket(repo.ticket_pattern.as_deref(), &pr.title, &pr.head_ref);
            let self_checked = pr_self_checked(db, &repo.full_name, pr.number)
                .await
                .map_err(|e| e.to_string())?;
            let elapsed = elapsed_days(&pr.updated_at, now);
            let bucket = classify_bucket(pr, self_checked, elapsed);

            let mut escalated = false;
            if let Some(reason) = escalation_reason(pr, &ticket) {
                let dedup = format!("pr:{}:{}:{}", repo.full_name, pr.number, reason);
                upsert_pr_signal(db, project_id, &repo.full_name, pr, &ticket, &dedup)
                    .await
                    .map_err(|e| e.to_string())?;
                active_keys.push(dedup);
                escalated = true;
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
            });
        }
    }

    auto_resolve(db, project_id, &fetched_full_names, &active_keys)
        .await
        .map_err(|e| e.to_string())?;

    // 전부 실패(레포는 있는데 하나도 못 가져옴)면 terminal failure 노출(INVARIANT: 삼키지 않음).
    if fetched_full_names.is_empty() && !repos.is_empty() {
        return Err(format!("모든 레포 fetch 실패 — {}", errors.join("; ")));
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
) -> Result<Vec<PrRadarItem>, String> {
    let repos = fetch_github_repo_refs(db.inner(), &project_id).await?;
    if repos.is_empty() {
        return Ok(Vec::new());
    }
    let cref = project_credential_ref(db.inner(), &project_id).await?;
    let token = keychain::get_token(&cref, TokenKind::Github)
        .map_err(|e| e.to_string())?
        .ok_or("GitHub 토큰이 없음(설정에서 토큰 저장 필요)")?;
    let provider = HttpPrProvider::new(&token).map_err(|e| e.to_string())?;
    sync_pr_radar(
        db.inner(),
        &provider,
        &project_id,
        &repos,
        chrono::Utc::now(),
    )
    .await
}

/// 수동 self-check 토글(로컬 상태). checked면 행 추가, 아니면 삭제(다음 도출이 반영).
#[tauri::command]
#[specta::specta]
pub async fn set_pr_self_check(
    db: State<'_, Db>,
    repo_full_name: String,
    pr_number: u32,
    checked: bool,
) -> Result<(), String> {
    if checked {
        sqlx::query(
            "INSERT OR IGNORE INTO pr_self_checks (id, repo_full_name, pr_number) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2)",
        )
        .bind(&repo_full_name)
        .bind(pr_number as i64)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;
    } else {
        sqlx::query("DELETE FROM pr_self_checks WHERE repo_full_name = ?1 AND pr_number = ?2")
            .bind(&repo_full_name)
            .bind(pr_number as i64)
            .execute(db.inner())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::projects::insert_project;
    use crate::commands::shared::test_support::*;
    use crate::commands::signals::set_quadrant;
    use crate::github::GithubError;
    use crate::models::ProjectKind;
    use crate::models::Quadrant;

    /// fake PR provider — 정해둔 PR 목록을 돌려준다(폴링 cycle 간 set으로 교체 가능). 실 네트워크 없음.
    struct FakeProvider {
        prs: std::sync::Mutex<Vec<RawPr>>,
        fail: bool,
    }
    impl FakeProvider {
        fn new(prs: Vec<RawPr>) -> Self {
            Self {
                prs: std::sync::Mutex::new(prs),
                fail: false,
            }
        }
        fn failing() -> Self {
            Self {
                prs: std::sync::Mutex::new(Vec::new()),
                fail: true,
            }
        }
        fn set(&self, prs: Vec<RawPr>) {
            *self.prs.lock().unwrap() = prs;
        }
    }
    impl PrProvider for FakeProvider {
        async fn fetch_prs(&self, _repo_full_name: &str) -> Result<Vec<RawPr>, GithubError> {
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

    /// 일부 repo fetch 실패는 그 repo만 건너뛰고, 전부 실패면 Err로 노출(삼키지 않음).
    #[tokio::test]
    async fn all_repos_failing_surfaces_error() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        let provider = FakeProvider::failing();
        let r = sync_pr_radar(&db, &provider, &proj.id, &repo_refs(), fixed_now()).await;
        assert!(r.is_err(), "모든 레포 실패 → terminal failure 노출");
    }
}
