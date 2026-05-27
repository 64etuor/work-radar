use tauri::State;

use crate::commands::nav::{get_config, set_config};
use crate::commands::tokens::project_credential_ref;
use crate::commands::{inbox, signal_store};
use crate::db::Db;
use crate::error::AppError;
use crate::github::{HttpPrProvider, PrProvider, RawPr, RawPrState};
use crate::keychain;
use crate::models::{CiStatus, PrRadarItem, PrRadarSettings, ReadinessBucket, TokenKind};
use crate::retry::Retryable;

// ── PR Radar (Phase 4, read 레일) ──────────────────────────────────────────────
// INVARIANT #1: 결정 레일은 사람만 — PR Radar는 자동 분류/자동 승격을 하지 않는다.
// INVARIANT #3: pr:{owner}/{repo}:{number}:{reason} 안정 키로 upsert(중복 0) + 원인 해소 시 auto-resolve.
// INVARIANT #4: PR Radar = 표시 전용(display-only). 매트릭스 자동 escalate 없음 — 모든 PR은 radar
//   자기 뷰(버킷)에 살고, threshold/충돌은 Inbox 운영 알림으로만 남는다. auto_resolve는 기존 escalated
//   신호 정리용으로만 남는다.
// INVARIANT #5: 폴링/재시도 bounded(github.rs with_retry + 프런트 refetchInterval).
// INVARIANT #7: 토큰은 keychain에서만 읽혀 Rust 안에서만. refresh 인자에 token 없음.

/// open PR이 이 일수 이상 미갱신이면 Stale 버킷.
const STALE_DAYS: i64 = 14;
const PR_RADAR_SETTINGS_KEY: &str = "pr_radar.settings";
const DEFAULT_COMMENT_ALERT_THRESHOLD: u32 = 10;

fn default_settings() -> PrRadarSettings {
    PrRadarSettings {
        poll_interval_minutes: 10,
        comment_alert_threshold: DEFAULT_COMMENT_ALERT_THRESHOLD,
        conflict_alerts_enabled: true,
        ai_auto_analysis_enabled: true,
    }
}

fn normalize_settings(mut s: PrRadarSettings) -> PrRadarSettings {
    s.poll_interval_minutes = s.poll_interval_minutes.clamp(1, 120);
    s.comment_alert_threshold = s.comment_alert_threshold.clamp(1, 250);
    s
}

async fn current_settings(db: &Db) -> PrRadarSettings {
    get_config(db, PR_RADAR_SETTINGS_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<PrRadarSettings>(&raw).ok())
        .map(normalize_settings)
        .unwrap_or_else(default_settings)
}

/// fetch 대상 레포 (auto-resolve 스코프). full_name = 'owner/repo'.
struct RepoRef {
    full_name: String,
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

async fn upsert_pr_inbox_alerts(
    db: &Db,
    settings: &PrRadarSettings,
    project_id: &str,
    repo_full_name: &str,
    pr: &RawPr,
) -> Result<(bool, bool, bool), sqlx::Error> {
    let mut alert_ids = Vec::new();
    let group_key = format!("pr:{repo_full_name}:{}", pr.number);
    let entity_id = format!("{repo_full_name}#{}", pr.number);
    let action_payload = serde_json::json!({
        "view": "radar",
        "url": pr.url,
        "repoFullName": repo_full_name,
        "prNumber": pr.number
    })
    .to_string();

    if pr.comment_count > settings.comment_alert_threshold {
        let source_id = format!("{group_key}:comments");
        let title = format!(
            "[{repo_full_name}] PR #{} review thread is noisy",
            pr.number
        );
        let body = format!(
            "{} comments exceed threshold {}. AI escalation should inspect root cause, architecture bottlenecks, repeated review points, and ownership/dependency impact before continuing.",
            pr.comment_count, settings.comment_alert_threshold
        );
        inbox::upsert_inbox_item_quiet(
            db,
            inbox::NewInboxItem {
                project_id: Some(project_id),
                source: "pr_radar",
                source_id: Some(&source_id),
                group_key: Some(&group_key),
                title: &title,
                body: &body,
                summary: Some(
                    "AI-flagged: noisy review thread needs root-cause and ownership analysis.",
                ),
                priority: "high",
                severity: "warning",
                related_entity_type: Some("pr"),
                related_entity_id: Some(&entity_id),
                action_payload: Some(&action_payload),
            },
        )
        .await?;
        alert_ids.push(source_id);
    }

    if settings.conflict_alerts_enabled && pr.has_conflict {
        let source_id = format!("{group_key}:conflict");
        let title = format!(
            "[{repo_full_name}] PR #{} has merge conflict risk",
            pr.number
        );
        let body = "Conflict pattern detected. AI escalation should inspect dependency impact, architecture bottlenecks, team ownership, and merge order.".to_string();
        inbox::upsert_inbox_item_quiet(
            db,
            inbox::NewInboxItem {
                project_id: Some(project_id),
                source: "pr_radar",
                source_id: Some(&source_id),
                group_key: Some(&group_key),
                title: &title,
                body: &body,
                summary: Some("AI-flagged: conflict risk needs dependency and ownership analysis."),
                priority: "urgent",
                severity: "critical",
                related_entity_type: Some("pr"),
                related_entity_id: Some(&entity_id),
                action_payload: Some(&action_payload),
            },
        )
        .await?;
        alert_ids.push(source_id);
    }

    let has_unread = inbox::unread_alert_exists(db, "pr_radar", &alert_ids).await?;
    let critical = settings.conflict_alerts_enabled && pr.has_conflict;
    let ai_flagged = settings.ai_auto_analysis_enabled && !alert_ids.is_empty();
    Ok((has_unread, critical, ai_flagged))
}

/// auto-resolve(INVARIANT #3): 성공 fetch된 repo 범위에서, 이번 cycle active set 밖의 github_pr
/// 신호를 status=done으로 전이(매트릭스에서 소멸). fetch 실패 repo는 fresh 데이터가 없어 제외된다.
/// PR B 이후 active_keys는 항상 비어 있어(표시 전용 — 새 escalate 없음) 이 fn은 *기존* escalated PR
/// 신호를 정리하는 역할만 한다(정리 완료 후엔 no-op).
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
/// 각 repo의 PR을 fetch → 버킷 분류(표시 전용) → 마지막에 auto-resolve(기존 escalated 신호 정리).
/// 일부 repo fetch 실패는 그 repo만 건너뛰고(해당 신호 auto-resolve 제외), 전부 실패면 Err로 노출(삼키지 않음).
// AppError는 리치 에러 envelope이라 의도적으로 크다(커맨드는 매크로로 면제됨). 이 코어는 command와
// 동일한 AppError를 그대로 전파해 transient 분류를 보존하므로 large-err 린트를 국소 허용한다(agents/mod.rs와 동일 패턴).
#[allow(clippy::result_large_err)]
async fn sync_pr_radar<P: PrProvider>(
    db: &Db,
    provider: &P,
    project_id: &str,
    repos: &[RepoRef],
    settings: &PrRadarSettings,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<PrRadarItem>, AppError> {
    let mut items: Vec<PrRadarItem> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    // 전부 실패 시 분류 보존(INVARIANT #5): 모든 실패가 transient면 transient(재시도 가능),
    // 하나라도 terminal이면 terminal(재시도로 못 고침). GithubError가 스스로 분류(Retryable).
    let mut all_transient = true;
    let mut fetched_full_names: Vec<String> = Vec::new();

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
            let self_checked = pr_self_checked(db, &repo.full_name, pr.number).await?;
            let elapsed = elapsed_days(&pr.updated_at, now);
            let bucket = classify_bucket(pr, self_checked, elapsed);
            let (has_unread_alert, has_critical_alert, ai_flagged) =
                upsert_pr_inbox_alerts(db, settings, project_id, &repo.full_name, pr).await?;

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
                self_checked,
                age_days: elapsed.max(0) as u32,
                project_id: project_id.to_string(),
                comment_count: pr.comment_count,
                is_suspicious: pr.comment_count > settings.comment_alert_threshold,
                has_unread_alert,
                has_critical_alert,
                ai_flagged,
            });
        }
    }

    // active_keys는 비어 있다(표시 전용 — 새 escalate 없음). 기존 escalated PR 신호는 fetch된
    // repo 범위에서 정리된다(INVARIANT #3 auto-resolve; 정리 완료 후엔 no-op).
    auto_resolve(db, project_id, &fetched_full_names, &[]).await?;

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

/// project의 enabled github 레포 로드.
async fn fetch_github_repo_refs(db: &Db, project_id: &str) -> Result<Vec<RepoRef>, String> {
    let rows: Vec<(Option<String>,)> = sqlx::query_as(
        "SELECT r.remote_url FROM repos r \
         WHERE r.project_id = ?1 AND r.provider = 'github' AND r.enabled = 1 \
         ORDER BY r.created_at",
    )
    .bind(project_id)
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;

    let mut refs = Vec::new();
    for (remote_url,) in rows {
        let Some(url) = remote_url else { continue };
        let Some((owner, repo)) = crate::github::parse_owner_repo(&url) else {
            continue;
        };
        refs.push(RepoRef {
            full_name: format!("{owner}/{repo}"),
        });
    }
    Ok(refs)
}

/// PR Radar 새로고침(주기 폴링의 한 cycle). project의 github 레포 PR을 버킷별로 도출한다(표시 전용 —
/// 매트릭스 자동 escalate 없음, INVARIANT #4). threshold/충돌은 Inbox 알림으로 mirror하고, 기존
/// escalated PR 신호는 원인 해소분만 auto-resolve.
/// 토큰은 keychain에서만.
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
    let settings = current_settings(db.inner()).await;
    sync_pr_radar(
        db.inner(),
        &provider,
        &project_id,
        &repos,
        &settings,
        chrono::Utc::now(),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn get_pr_radar_settings(db: State<'_, Db>) -> Result<PrRadarSettings, AppError> {
    Ok(current_settings(db.inner()).await)
}

#[tauri::command]
#[specta::specta]
pub async fn set_pr_radar_settings(
    db: State<'_, Db>,
    settings: PrRadarSettings,
) -> Result<PrRadarSettings, AppError> {
    let normalized = normalize_settings(settings);
    let raw = serde_json::to_string(&normalized)
        .map_err(|e| AppError::unexpected("pr_radar.settings_serialize", e.to_string()))?;
    set_config(db.inner(), PR_RADAR_SETTINGS_KEY, &raw).await?;
    Ok(normalized)
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
    use crate::models::{ProjectKind, Quadrant};

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
        }]
    }

    /// 활성(active) github_pr 신호 status 목록(생성순). 표시 전용 전환 후 auto-resolve 검증용.
    async fn pr_signal_statuses(db: &Db) -> Vec<String> {
        let rows: Vec<(String,)> = sqlx::query_as(
            "SELECT status FROM signals WHERE source = 'github_pr' ORDER BY created_at",
        )
        .fetch_all(db)
        .await
        .unwrap();
        rows.into_iter().map(|(s,)| s).collect()
    }

    /// 레거시 escalated PR 신호를 직접 SQL로 시드한다(표시 전용 전환 전에 만들어진 행 모사).
    /// dedup_key = pr:o/r:{number}:ci_failed, status='new', quadrant='unclassified'.
    async fn seed_legacy_pr_signal(db: &Db, project_id: &str, number: u64) {
        let dedup = format!("pr:o/r:{number}:ci_failed");
        sqlx::query(
            "INSERT INTO signals \
                (id, project_id, title, body, source, type, quadrant, dedup_key, status) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, 'github_pr', 'pr_attention', \
                     'unclassified', ?4, 'new')",
        )
        .bind(project_id)
        .bind(format!("[o/r] PR #{number} CI 실패"))
        .bind(format!("https://github.com/o/r/pull/{number}"))
        .bind(&dedup)
        .execute(db)
        .await
        .unwrap();
    }

    /// (0) is_suspicious: comment_count > 10이면 true, 10 이하면 false.
    #[test]
    fn suspicious_comment_threshold() {
        let mut pr = raw_pr(1, CiStatus::Passing, RawPrState::Open, "x");
        // 경계: 10은 초과 아님 → false.
        pr.comment_count = 10;
        assert!(
            pr.comment_count <= DEFAULT_COMMENT_ALERT_THRESHOLD,
            "10개는 suspicious 아님"
        );
        // 경계+1: 11은 초과 → true.
        pr.comment_count = 11;
        assert!(
            pr.comment_count > DEFAULT_COMMENT_ALERT_THRESHOLD,
            "11개는 suspicious"
        );
        // 0개는 false.
        pr.comment_count = 0;
        assert!(
            pr.comment_count <= DEFAULT_COMMENT_ALERT_THRESHOLD,
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

    /// (2) 표시 전용: CI 실패 PR이라도 새 신호(escalate)를 만들지 않는다(INVARIANT #4 — noise 0).
    /// items는 정상 도출(버킷=CiBlocked)되지만 github_pr 신호는 0행.
    #[tokio::test]
    async fn display_only_creates_no_signal() {
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

        let items = sync_pr_radar(
            &db,
            &provider,
            &proj.id,
            &repo_refs(),
            &default_settings(),
            fixed_now(),
        )
        .await
        .unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].bucket, ReadinessBucket::CiBlocked);

        let n: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM signals WHERE source = 'github_pr'")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(n.0, 0, "표시 전용 → escalate 신호 0(매트릭스 미진입)");
    }

    /// (3) CI 통과로 바뀌면 레거시 escalated 신호가 auto-resolve(status=done)된다.
    /// 표시 전용 전환 후 sync는 신호를 만들지 않으므로 레거시 행을 직접 시드해 정리 동작을 검증한다.
    #[tokio::test]
    async fn ci_green_auto_resolves() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        // 레거시 escalated PR 신호(표시 전용 전환 전에 만들어진 것)를 시드.
        seed_legacy_pr_signal(&db, &proj.id, 42).await;
        assert_eq!(pr_signal_statuses(&db).await, vec!["new"], "시드는 active");
        // 사람이 quadrant를 결정(set_quadrant는 status도 classified로 전이)한 상태를 모사 —
        // CI-green 정리 경로에서도 그 quadrant가 보존돼야 함(INVARIANT #1).
        let id: (String,) =
            sqlx::query_as("SELECT id FROM signals WHERE source = 'github_pr' LIMIT 1")
                .fetch_one(&db)
                .await
                .unwrap();
        set_quadrant(&db, &id.0, Quadrant::Q1DoNow).await.unwrap();

        // 같은 PR이 CI green으로 fetch됨 → active_keys 비어 있음 → 레거시 신호 정리.
        let provider = FakeProvider::new(vec![raw_pr(
            42,
            CiStatus::Passing,
            RawPrState::Open,
            "MIR-DEV-7 버그",
        )]);
        sync_pr_radar(
            &db,
            &provider,
            &proj.id,
            &repo_refs(),
            &default_settings(),
            fixed_now(),
        )
        .await
        .unwrap();
        // CI-green 정리 경로: status만 done으로 전이하고 사람 quadrant는 보존(INVARIANT #1).
        let row: (String, String) = sqlx::query_as(
            "SELECT status, quadrant FROM signals WHERE source = 'github_pr' LIMIT 1",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(
            row.0, "done",
            "원인 해소(CI green) → status만 done으로 auto-resolve"
        );
        assert_eq!(
            row.1, "q1_do_now",
            "CI-green 정리 경로에서도 사람 quadrant 보존(INVARIANT #1)"
        );
    }

    /// (4) merged로 바뀌면 레거시 escalated 신호가 auto-resolve(open 목록에서 사라짐 = 원인 해소).
    #[tokio::test]
    async fn merged_auto_resolves() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        seed_legacy_pr_signal(&db, &proj.id, 42).await;

        let provider = FakeProvider::new(vec![raw_pr(
            42,
            CiStatus::None,
            RawPrState::Merged,
            "MIR-DEV-7 버그",
        )]);
        sync_pr_radar(
            &db,
            &provider,
            &proj.id,
            &repo_refs(),
            &default_settings(),
            fixed_now(),
        )
        .await
        .unwrap();
        assert_eq!(
            pr_signal_statuses(&db).await,
            vec!["done"],
            "merged(또는 표시 전용 전환) → auto-resolve"
        );
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
        let err = sync_pr_radar(
            &db,
            &provider,
            &proj.id,
            &repo_refs(),
            &default_settings(),
            fixed_now(),
        )
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
        let err = sync_pr_radar(
            &db,
            &provider,
            &proj.id,
            &repo_refs(),
            &default_settings(),
            fixed_now(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Terminal, "terminal 분류 보존");
        assert!(!err.retryable, "terminal은 재시도 불가");
    }

    /// INVARIANT #1 잠금: auto_resolve는 status만 'done'으로 전환하며 사람이 결정한 quadrant는 건드리지 않는다.
    #[tokio::test]
    async fn auto_resolve_preserves_human_quadrant() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        // 레거시 escalated 신호를 시드하고 사람이 quadrant를 직접 지정한 상황을 모사.
        seed_legacy_pr_signal(&db, &proj.id, 42).await;
        let id: (String,) =
            sqlx::query_as("SELECT id FROM signals WHERE source = 'github_pr' LIMIT 1")
                .fetch_one(&db)
                .await
                .unwrap();
        set_quadrant(&db, &id.0, Quadrant::Q1DoNow).await.unwrap();
        // PR이 사라진 상태(provider에 PR 없음) → auto_resolve 작동.
        let provider = FakeProvider::new(vec![]);
        sync_pr_radar(
            &db,
            &provider,
            &proj.id,
            &repo_refs(),
            &default_settings(),
            fixed_now(),
        )
        .await
        .unwrap();
        let row: (String, String) = sqlx::query_as(
            "SELECT status, quadrant FROM signals WHERE source = 'github_pr' LIMIT 1",
        )
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(row.0, "done", "레거시 신호는 status만 done으로 정리");
        assert_eq!(
            row.1, "q1_do_now",
            "사람 quadrant 결정은 보존(INVARIANT #1)"
        );
    }
}
