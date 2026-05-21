//! Tauri IPC commands. specta가 이 시그니처에서 TS 바인딩을 생성한다.
//! INVARIANT: Notion/GitHub 등 외부 호출은 Rust에 둔다(토큰 렌더러 노출 금지).
//! INVARIANT #1: quadrant 변경은 오직 `classify_signal`(사람 결정)로만. 생성은 항상 unclassified.
//! INVARIANT #2: 외부 승격(notion/calendar)은 `create_promotion_draft`로 draft만 — 외부 무변경.

use tauri::State;

use crate::db::Db;
use crate::git::{summarize_status, CliGitProvider, GitProvider};
use crate::github::{HttpPrProvider, PrProvider, RawPr, RawPrState};
use crate::models::{
    CiStatus, CreateProjectInput, CreateRepoInput, CreateRoutineInput, CreateSignalInput,
    DiffFileSummary, DiffMode, FlushSummary, Kind, PingResult, PrRadarItem, Project, Promotion,
    PromotionOutcome, PromotionStatus, PromotionTarget, Quadrant, ReadinessBucket, Repo,
    RoutineToday, SignalStatus, TokenKind, TokenStatus, Weekday, WorkSignal, Worktree,
};
use crate::notion::{HttpNotionWriter, NotionError, NotionWriter};
use crate::{api, keychain};

/// WorkSignal SELECT/RETURNING 공통 컬럼 목록 (FromRow는 이름으로 매핑 → 순서 무관).
const SIGNAL_COLS: &str =
    "id, project_id, title, body, source, type, quadrant, suggested_quadrant, \
     kind, area, suggested_area, status, snooze_until, today_for_date, today_done_at, today_rank, \
     created_at, updated_at";

// ── Projects (Phase 0) ────────────────────────────────────────────────────────

/// 순수 DB 조회. command와 테스트가 공유한다 (State 없이 풀만 받음).
pub async fn fetch_projects(db: &Db) -> Result<Vec<Project>, sqlx::Error> {
    sqlx::query_as::<_, Project>(
        "SELECT id, name, kind, notion_backlog_db_id, notion_agenda_db_id, \
         ticket_key_pattern, credential_ref, created_at, updated_at \
         FROM projects ORDER BY created_at",
    )
    .fetch_all(db)
    .await
}

/// 모든 프로젝트 목록. Phase 0에서는 빈 DB라 빈 배열을 반환한다.
#[tauri::command]
#[specta::specta]
pub async fn list_projects(db: State<'_, Db>) -> Result<Vec<Project>, String> {
    fetch_projects(db.inner()).await.map_err(|e| e.to_string())
}

/// Project SELECT/RETURNING 공통 컬럼.
const PROJECT_COLS: &str = "id, name, kind, notion_backlog_db_id, notion_agenda_db_id, \
     ticket_key_pattern, credential_ref, created_at, updated_at";
/// Repo SELECT/RETURNING 공통 컬럼.
const REPO_COLS: &str = "id, project_id, provider, remote_url, local_path, default_branch, \
     ticket_key_pattern, enabled, created_at";

/// 프로젝트 생성. `credential_ref`는 백엔드가 생성하는 keychain 분리 키(토큰 본문 아님).
pub async fn insert_project(db: &Db, input: &CreateProjectInput) -> Result<Project, sqlx::Error> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(sqlx::Error::Protocol("empty project name".into()));
    }
    sqlx::query_as::<_, Project>(&format!(
        "INSERT INTO projects \
            (id, name, kind, notion_backlog_db_id, notion_agenda_db_id, ticket_key_pattern, credential_ref) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, lower(hex(randomblob(16)))) \
         RETURNING {PROJECT_COLS}"
    ))
    .bind(name)
    .bind(input.kind)
    .bind(&input.notion_backlog_db_id)
    .bind(&input.notion_agenda_db_id)
    .bind(&input.ticket_key_pattern)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_project(
    db: State<'_, Db>,
    input: CreateProjectInput,
) -> Result<Project, String> {
    insert_project(db.inner(), &input)
        .await
        .map_err(|e| e.to_string())
}

// ── Repos (project별 멀티 레포) ───────────────────────────────────────────────

pub async fn fetch_repos(db: &Db, project_id: &str) -> Result<Vec<Repo>, sqlx::Error> {
    sqlx::query_as::<_, Repo>(&format!(
        "SELECT {REPO_COLS} FROM repos WHERE project_id = ?1 ORDER BY created_at"
    ))
    .bind(project_id)
    .fetch_all(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_repos(db: State<'_, Db>, project_id: String) -> Result<Vec<Repo>, String> {
    fetch_repos(db.inner(), &project_id)
        .await
        .map_err(|e| e.to_string())
}

pub async fn insert_repo(db: &Db, input: &CreateRepoInput) -> Result<Repo, sqlx::Error> {
    let default_branch = input
        .default_branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("main");
    sqlx::query_as::<_, Repo>(&format!(
        "INSERT INTO repos \
            (id, project_id, provider, remote_url, local_path, default_branch, ticket_key_pattern) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5, ?6) \
         RETURNING {REPO_COLS}"
    ))
    .bind(&input.project_id)
    .bind(input.provider)
    .bind(&input.remote_url)
    .bind(&input.local_path)
    .bind(default_branch)
    .bind(&input.ticket_key_pattern)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_repo(db: State<'_, Db>, input: CreateRepoInput) -> Result<Repo, String> {
    insert_repo(db.inner(), &input)
        .await
        .map_err(|e| e.to_string())
}

// ── 토큰 (keychain 경유 — 토큰 본문은 절대 반환하지 않는다, INVARIANT) ──────────

/// project의 keychain 분리 키. 토큰 커맨드들이 공유한다.
async fn project_credential_ref(db: &Db, project_id: &str) -> Result<String, String> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT credential_ref FROM projects WHERE id = ?1")
            .bind(project_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    row.map(|r| r.0)
        .ok_or_else(|| "project not found".to_string())
}

/// 토큰 저장. 토큰은 IPC 인자로만 들어와 즉시 keychain으로 가고, 반환되지 않는다.
#[tauri::command]
#[specta::specta]
pub async fn set_project_token(
    db: State<'_, Db>,
    project_id: String,
    kind: TokenKind,
    token: String,
) -> Result<(), String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("empty token".into());
    }
    let cref = project_credential_ref(db.inner(), &project_id).await?;
    keychain::set_token(&cref, kind, token).map_err(|e| e.to_string())
}

/// 토큰 삭제(클리어).
#[tauri::command]
#[specta::specta]
pub async fn delete_project_token(
    db: State<'_, Db>,
    project_id: String,
    kind: TokenKind,
) -> Result<(), String> {
    let cref = project_credential_ref(db.inner(), &project_id).await?;
    keychain::delete_token(&cref, kind).map_err(|e| e.to_string())
}

/// 토큰 존재 여부만 (본문 미노출). UI 마스킹 표시용.
#[tauri::command]
#[specta::specta]
pub async fn project_token_status(
    db: State<'_, Db>,
    project_id: String,
) -> Result<TokenStatus, String> {
    let cref = project_credential_ref(db.inner(), &project_id).await?;
    Ok(TokenStatus {
        has_notion: keychain::has_token(&cref, TokenKind::Notion).map_err(|e| e.to_string())?,
        has_github: keychain::has_token(&cref, TokenKind::Github).map_err(|e| e.to_string())?,
    })
}

/// 토큰으로 외부 API ping(read-only). 토큰은 keychain에서 읽어 Rust 안에서만 쓰인다.
#[tauri::command]
#[specta::specta]
pub async fn ping_project_token(
    db: State<'_, Db>,
    project_id: String,
    kind: TokenKind,
) -> Result<PingResult, String> {
    let cref = project_credential_ref(db.inner(), &project_id).await?;
    let token = keychain::get_token(&cref, kind).map_err(|e| e.to_string())?;
    let Some(token) = token else {
        return Ok(PingResult {
            ok: false,
            detail: "토큰 없음".into(),
        });
    };
    Ok(match kind {
        TokenKind::Notion => api::ping_notion(&token).await,
        TokenKind::Github => api::ping_github(&token).await,
    })
}

// ── projectId 태깅 / reconcile (Phase 1 kind 힌트 → projectId) ─────────────────

/// 미태깅(project_id NULL) & kind 보유 신호를 같은 kind의 가장 오래된 프로젝트로 태깅.
/// 메타데이터 reconcile일 뿐 결정 레일(quadrant/승격)은 건드리지 않는다(INVARIANT #1).
pub async fn reconcile_inner(db: &Db) -> Result<u64, sqlx::Error> {
    let res = sqlx::query(
        "UPDATE signals SET \
            project_id = (SELECT p.id FROM projects p WHERE p.kind = signals.kind ORDER BY p.created_at LIMIT 1), \
            updated_at = datetime('now') \
         WHERE project_id IS NULL AND kind IS NOT NULL \
           AND EXISTS (SELECT 1 FROM projects p WHERE p.kind = signals.kind)",
    )
    .execute(db)
    .await?;
    Ok(res.rows_affected())
}

#[tauri::command]
#[specta::specta]
pub async fn reconcile_signal_projects(db: State<'_, Db>) -> Result<u32, String> {
    reconcile_inner(db.inner())
        .await
        .map(|n| n as u32)
        .map_err(|e| e.to_string())
}

/// 신호의 소속 프로젝트를 명시 지정(또는 해제). 메타데이터.
#[tauri::command]
#[specta::specta]
pub async fn set_signal_project(
    db: State<'_, Db>,
    id: String,
    project_id: Option<String>,
) -> Result<WorkSignal, String> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET project_id = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&id)
    .bind(&project_id)
    .fetch_one(db.inner())
    .await
    .map_err(|e| e.to_string())
}

// ── Signals: 생성 / 조회 / 분류 ──────────────────────────────────────────────

/// braindump 입력 정규화 (dedup 키 기준). 소문자 + 공백 정리.
fn normalize(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// 한 줄 braindump → 미분류 카드 생성.
/// INVARIANT #1: 항상 `unclassified`로 진입한다 (자동 분류 없음).
/// INVARIANT #3: 같은 입력은 dedup 키로 합쳐진다 (append 아님, upsert).
pub async fn insert_signal(db: &Db, input: &CreateSignalInput) -> Result<WorkSignal, sqlx::Error> {
    let title = input.title.trim();
    if title.is_empty() {
        return Err(sqlx::Error::Protocol("empty signal title".into()));
    }
    let dedup_key = format!("braindump:{}", normalize(title));

    // dedup: 동일 입력이 이미 있으면 touch 후 반환 (합쳐짐). 미태깅이면 project_id 보강.
    let existing = sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET updated_at = datetime('now'), project_id = COALESCE(project_id, ?2) \
         WHERE dedup_key = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&dedup_key)
    .bind(&input.project_id)
    .fetch_optional(db)
    .await?;
    if let Some(sig) = existing {
        return Ok(sig);
    }

    sqlx::query_as::<_, WorkSignal>(&format!(
        "INSERT INTO signals (id, project_id, title, source, type, quadrant, kind, dedup_key, status) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, 'braindump', 'thought', 'unclassified', ?3, ?4, 'new') \
         RETURNING {SIGNAL_COLS}"
    ))
    .bind(&input.project_id)
    .bind(title)
    .bind(input.kind)
    .bind(&dedup_key)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_signal(
    db: State<'_, Db>,
    input: CreateSignalInput,
) -> Result<WorkSignal, String> {
    insert_signal(db.inner(), &input)
        .await
        .map_err(|e| e.to_string())
}

/// 매트릭스 + 미분류 카드 (Today로 승격되지 않은 active 신호).
pub async fn fetch_signals(db: &Db) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE today_for_date IS NULL AND status NOT IN ('done','archived','snoozed') \
         ORDER BY created_at"
    ))
    .fetch_all(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_signals(db: State<'_, Db>) -> Result<Vec<WorkSignal>, String> {
    fetch_signals(db.inner()).await.map_err(|e| e.to_string())
}

/// 사분면 분류 (사람 결정 레일 — INVARIANT #1). quadrant를 바꾸는 유일한 경로.
pub async fn set_quadrant(
    db: &Db,
    id: &str,
    quadrant: Quadrant,
) -> Result<WorkSignal, sqlx::Error> {
    let status = if matches!(quadrant, Quadrant::Unclassified) {
        SignalStatus::New
    } else {
        SignalStatus::Classified
    };
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET quadrant = ?2, status = ?3, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(quadrant)
    .bind(status)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn classify_signal(
    db: State<'_, Db>,
    id: String,
    quadrant: Quadrant,
) -> Result<WorkSignal, String> {
    set_quadrant(db.inner(), &id, quadrant)
        .await
        .map_err(|e| e.to_string())
}

/// 상태 변경 (완료/보관 등). done/archive 카드 메뉴.
#[tauri::command]
#[specta::specta]
pub async fn set_signal_status(
    db: State<'_, Db>,
    id: String,
    status: SignalStatus,
) -> Result<WorkSignal, String> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET status = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&id)
    .bind(status)
    .fetch_one(db.inner())
    .await
    .map_err(|e| e.to_string())
}

/// 미루기 (snooze). 매트릭스에서 숨고 snooze_until에 복귀 시점 기록.
#[tauri::command]
#[specta::specta]
pub async fn snooze_signal(
    db: State<'_, Db>,
    id: String,
    until: String,
) -> Result<WorkSignal, String> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET status = 'snoozed', snooze_until = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&id)
    .bind(&until)
    .fetch_one(db.inner())
    .await
    .map_err(|e| e.to_string())
}

// ── Today 레일 (로컬 승격, Acceptance 불요 — architecture.md) ──────────────────

/// 매트릭스 카드를 Today로 승격. 로컬 액션이라 외부 변경 없음(Acceptance 불요).
/// 승격하면 매트릭스에서 빠지고(today_for_date set) 원 quadrant는 배지로 유지된다.
pub async fn promote_today_inner(db: &Db, id: &str, date: &str) -> Result<WorkSignal, sqlx::Error> {
    // 새 항목은 레일 맨 위에 (가장 작은 rank).
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET today_for_date = ?2, today_done_at = NULL, status = 'promoted', \
            today_rank = COALESCE((SELECT MIN(today_rank) FROM signals WHERE today_for_date IS NOT NULL), 0) - 1, \
            updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .bind(date)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn promote_today(
    db: State<'_, Db>,
    id: String,
    date: String,
) -> Result<WorkSignal, String> {
    promote_today_inner(db.inner(), &id, &date)
        .await
        .map_err(|e| e.to_string())
}

/// Today 승격 취소 → 원 사분면으로 복귀(없으면 미분류). 카운터 리셋.
pub async fn unpromote_today_inner(db: &Db, id: &str) -> Result<WorkSignal, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET today_for_date = NULL, today_done_at = NULL, today_rank = NULL, \
            status = CASE WHEN quadrant = 'unclassified' THEN 'new' ELSE 'classified' END, \
            updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(id)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn unpromote_today(db: State<'_, Db>, id: String) -> Result<WorkSignal, String> {
    unpromote_today_inner(db.inner(), &id)
        .await
        .map_err(|e| e.to_string())
}

/// Today 항목 완료 토글. 완료(done)=해당 날짜 기록 → 다음날 이월 안 됨.
#[tauri::command]
#[specta::specta]
pub async fn toggle_today_done(
    db: State<'_, Db>,
    id: String,
    date: String,
    done: bool,
) -> Result<WorkSignal, String> {
    let done_at: Option<String> = if done { Some(date) } else { None };
    sqlx::query_as::<_, WorkSignal>(&format!(
        "UPDATE signals SET today_done_at = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {SIGNAL_COLS}"
    ))
    .bind(&id)
    .bind(done_at)
    .fetch_one(db.inner())
    .await
    .map_err(|e| e.to_string())
}

/// Today 레일 재정렬. ordered_ids 순서대로 today_rank 부여.
#[tauri::command]
#[specta::specta]
pub async fn reorder_today(db: State<'_, Db>, ordered_ids: Vec<String>) -> Result<(), String> {
    let mut tx = db.inner().begin().await.map_err(|e| e.to_string())?;
    for (i, id) in ordered_ids.iter().enumerate() {
        sqlx::query("UPDATE signals SET today_rank = ?2 WHERE id = ?1")
            .bind(id)
            .bind(i as i32)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }
    tx.commit().await.map_err(|e| e.to_string())
}

/// 오늘의 Today 항목. 미완료는 매일 잔류(rollover), 완료(today_done_at=오늘)는 당일만 표시.
/// 이전 날짜에 완료된 항목은 이월되지 않으므로 제외된다. age는 프런트가 today_for_date로 계산.
pub async fn fetch_today(db: &Db, today: &str) -> Result<Vec<WorkSignal>, sqlx::Error> {
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {SIGNAL_COLS} FROM signals \
         WHERE today_for_date IS NOT NULL AND status NOT IN ('done','archived') \
           AND (today_done_at IS NULL OR today_done_at = ?1) \
         ORDER BY today_rank, today_for_date"
    ))
    .bind(today)
    .fetch_all(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_today(db: State<'_, Db>, today: String) -> Result<Vec<WorkSignal>, String> {
    fetch_today(db.inner(), &today)
        .await
        .map_err(|e| e.to_string())
}

// ── 승격 draft (외부 = Acceptance 게이트, INVARIANT #2) ────────────────────────

/// 백로그/안건/캘린더 승격 = `Promotion` draft만 생성. 외부(Notion/Calendar)는 변경하지 않는다.
/// 실제 외부 write는 Phase 3/11에서 Acceptance를 거쳐 수행된다.
pub async fn insert_promotion_draft(
    db: &Db,
    signal_id: &str,
    target: PromotionTarget,
) -> Result<Promotion, sqlx::Error> {
    // draft payload에 제목 스냅샷만 담는다 (미래 외부 write의 입력).
    let title: (String,) = sqlx::query_as("SELECT title FROM signals WHERE id = ?1")
        .bind(signal_id)
        .fetch_one(db)
        .await?;
    let payload = serde_json::json!({ "title": title.0 }).to_string();

    sqlx::query_as::<_, Promotion>(
        "INSERT INTO promotions (id, signal_id, target, status, draft_payload) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, 'draft', ?3) \
         RETURNING id, signal_id, target, status, draft_payload, created_external_id, created_at",
    )
    .bind(signal_id)
    .bind(target)
    .bind(&payload)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_promotion_draft(
    db: State<'_, Db>,
    signal_id: String,
    target: PromotionTarget,
) -> Result<Promotion, String> {
    insert_promotion_draft(db.inner(), &signal_id, target)
        .await
        .map_err(|e| e.to_string())
}

// ── Notion 승격 (write 레일, Phase 3 — 즉시 write) ─────────────────────────────
// INVARIANT #2: 사람이 카드 메뉴를 누르는 것이 곧 결정/accept다(자동화 출력 아님 → acceptances
//   테이블 미관여). 자동화-draft의 2단계 게이트(Phase 9)를 위해 `confirmed` 상태는 보존한다.
// INVARIANT #3: 같은 (signal,target)이 이미 created면 중복 write 없이 기존 결과를 반환하고,
//   오프라인 재시도는 같은 draft 행을 재사용한다(큐 중복 0).
// INVARIANT #5/#7: write는 notion.rs의 bounded retry/backoff/jitter를 거치고, 결과(외부 ID/URL)는
//   promotions(승격 이력 SSOT)에 기록된다. 토큰은 keychain에서만 읽혀 Rust 안에서만 쓰인다.

const PROMOTION_COLS: &str =
    "id, signal_id, target, status, draft_payload, created_external_id, created_at";

/// notion write 가능한 타깃의 signals.links 키. calendar/today는 None(이 경로 아님).
fn notion_link_key(target: PromotionTarget) -> Option<&'static str> {
    match target {
        PromotionTarget::NotionBacklog => Some("notionBacklogId"),
        PromotionTarget::NotionAgenda => Some("notionAgendaId"),
        _ => None,
    }
}

/// draft_payload(JSON)에서 문자열 필드 추출.
fn payload_str(payload: &str, key: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get(key).and_then(|s| s.as_str()).map(String::from))
}

/// (signal,target)의 특정 상태 promotion 1건(최신).
async fn find_promotion(
    db: &Db,
    signal_id: &str,
    target: PromotionTarget,
    status: PromotionStatus,
) -> Result<Option<Promotion>, sqlx::Error> {
    sqlx::query_as::<_, Promotion>(&format!(
        "SELECT {PROMOTION_COLS} FROM promotions \
         WHERE signal_id = ?1 AND target = ?2 AND status = ?3 \
         ORDER BY created_at DESC LIMIT 1"
    ))
    .bind(signal_id)
    .bind(target)
    .bind(status)
    .fetch_one(db)
    .await
    .map(Some)
    .or_else(|e| match e {
        sqlx::Error::RowNotFound => Ok(None),
        other => Err(other),
    })
}

/// write 성공 반영: promotion → created(+외부ID·URL을 payload에 머지), signal → links 머지 + linked.
async fn finalize_created(
    db: &Db,
    promo_id: &str,
    signal_id: &str,
    target: PromotionTarget,
    page: &crate::notion::CreatedPage,
) -> Result<(), sqlx::Error> {
    let existing: (String,) = sqlx::query_as("SELECT draft_payload FROM promotions WHERE id = ?1")
        .bind(promo_id)
        .fetch_one(db)
        .await?;
    let mut payload: serde_json::Value =
        serde_json::from_str(&existing.0).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("pageId".into(), serde_json::json!(page.id));
        obj.insert("url".into(), serde_json::json!(page.url));
    }
    sqlx::query(
        "UPDATE promotions SET status = 'created', created_external_id = ?2, draft_payload = ?3 \
         WHERE id = ?1",
    )
    .bind(promo_id)
    .bind(&page.id)
    .bind(payload.to_string())
    .execute(db)
    .await?;

    if let Some(key) = notion_link_key(target) {
        let row: (Option<String>,) = sqlx::query_as("SELECT links FROM signals WHERE id = ?1")
            .bind(signal_id)
            .fetch_one(db)
            .await?;
        let mut links: serde_json::Value = row
            .0
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(obj) = links.as_object_mut() {
            obj.insert(key.into(), serde_json::json!(page.id));
        }
        sqlx::query(
            "UPDATE signals SET links = ?2, status = 'linked', updated_at = datetime('now') \
             WHERE id = ?1",
        )
        .bind(signal_id)
        .bind(links.to_string())
        .execute(db)
        .await?;
    }
    Ok(())
}

/// 승격 실행을 직렬화하는 in-process 게이트. 같은 카드의 동시 승격(더블클릭, flush vs 수동)이
/// check-then-act 경합으로 중복 Notion 페이지/중복 created 행을 만드는 것을 막는다(INVARIANT #3).
/// Tauri 백엔드는 단일 프로세스라 in-process 게이트로 충분하고, 네트워크는 이미 RateLimiter로
/// paced되어 추가 지연은 무시 가능. (per-(signal,target) 분리는 향후 최적화 — 단일 사용자엔 불필요.)
/// DB 레벨 partial unique index(0003)가 구조적 2차 방어선.
static PROMOTION_GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// 승격 실행 코어(테스트 가능 — writer를 fake로 대체). keychain/네트워크는 호출자(command)가 담당.
/// 멱등(created 재사용) → draft find-or-create → write → 상태 전이(created/draft 큐잉/failed).
async fn execute_promotion<W: NotionWriter>(
    db: &Db,
    signal_id: &str,
    target: PromotionTarget,
    writer: &W,
    token: &str,
    db_id: &str,
) -> Result<PromotionOutcome, sqlx::Error> {
    // 같은 카드 동시 승격을 직렬화 — 두 번째는 아래 created 멱등 분기로 빠진다(중복 write 0).
    let _gate = PROMOTION_GATE.lock().await;

    // 멱등: 이미 created면 중복 write 없이 기존 결과 반환(INVARIANT #3).
    if let Some(done) = find_promotion(db, signal_id, target, PromotionStatus::Created).await? {
        return Ok(PromotionOutcome {
            page_url: payload_str(&done.draft_payload, "url"),
            promotion_id: done.id,
            status: PromotionStatus::Created,
            detail: "이미 등록됨".into(),
        });
    }
    // 큐 행(draft) 재사용 또는 생성. title 스냅샷은 payload에 보존된다.
    let promo = match find_promotion(db, signal_id, target, PromotionStatus::Draft).await? {
        Some(p) => p,
        None => insert_promotion_draft(db, signal_id, target).await?,
    };
    let title = payload_str(&promo.draft_payload, "title").unwrap_or_default();

    match writer.create_page(token, db_id, &title).await {
        Ok(page) => {
            finalize_created(db, &promo.id, signal_id, target, &page).await?;
            Ok(PromotionOutcome {
                promotion_id: promo.id,
                status: PromotionStatus::Created,
                page_url: Some(page.url),
                detail: "Notion 페이지 생성됨".into(),
            })
        }
        // 일시 실패: draft 유지(큐). 복구 시 flush가 재시도(INVARIANT #5: 무한 retry 아님).
        Err(NotionError::Transient(msg)) => Ok(PromotionOutcome {
            promotion_id: promo.id,
            status: PromotionStatus::Draft,
            page_url: None,
            detail: format!("오프라인/일시 오류 — 큐에 저장됨(복구 시 등록): {msg}"),
        }),
        // 영구 실패(인증/권한/검증 등): failed로 표시하고 사유 노출.
        Err(NotionError::Terminal(msg)) => {
            sqlx::query("UPDATE promotions SET status = 'failed' WHERE id = ?1")
                .bind(&promo.id)
                .execute(db)
                .await?;
            Ok(PromotionOutcome {
                promotion_id: promo.id,
                status: PromotionStatus::Failed,
                page_url: None,
                detail: msg,
            })
        }
    }
}

/// signal → project → (Notion 토큰, 대상 DB ID) 해석. notion 타깃 아님/미설정이면 명확한 Err.
async fn resolve_notion_target(
    db: &Db,
    signal_id: &str,
    target: PromotionTarget,
) -> Result<(String, String), String> {
    if notion_link_key(target).is_none() {
        return Err("Notion 타깃이 아님(calendar/today는 이 경로로 승격하지 않음)".into());
    }
    let sig: Option<(Option<String>,)> =
        sqlx::query_as("SELECT project_id FROM signals WHERE id = ?1")
            .bind(signal_id)
            .fetch_optional(db)
            .await
            .map_err(|e| e.to_string())?;
    let project_id = sig
        .ok_or("신호를 찾을 수 없음")?
        .0
        .ok_or("신호에 프로젝트가 지정되지 않음(설정에서 reconcile 필요)")?;

    let proj: Option<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT credential_ref, notion_backlog_db_id, notion_agenda_db_id FROM projects WHERE id = ?1",
    )
    .bind(&project_id)
    .fetch_optional(db)
    .await
    .map_err(|e| e.to_string())?;
    let (cref, backlog, agenda) = proj.ok_or("프로젝트를 찾을 수 없음")?;

    let db_id = match target {
        PromotionTarget::NotionBacklog => backlog,
        PromotionTarget::NotionAgenda => agenda,
        _ => None,
    }
    .ok_or("프로젝트에 Notion DB ID가 설정되지 않음(설정에서 바인딩 필요)")?;

    let token = keychain::get_token(&cref, TokenKind::Notion)
        .map_err(|e| e.to_string())?
        .ok_or("Notion 토큰이 없음(설정에서 토큰 저장 필요)")?;

    Ok((token, db_id))
}

/// 카드 → Notion 백로그/안건 즉시 승격(write). 사람이 누른 결정이므로 즉시 write한다(INVARIANT #2).
#[tauri::command]
#[specta::specta]
pub async fn promote_to_notion(
    db: State<'_, Db>,
    signal_id: String,
    target: PromotionTarget,
) -> Result<PromotionOutcome, String> {
    let (token, db_id) = resolve_notion_target(db.inner(), &signal_id, target).await?;
    let writer = HttpNotionWriter::new().map_err(|e| e.to_string())?;
    execute_promotion(db.inner(), &signal_id, target, &writer, &token, &db_id)
        .await
        .map_err(|e| e.to_string())
}

/// 오프라인 큐 flush: 토큰/DB가 갖춰진 draft notion 승격을 모두 재시도한다. 복구 시 호출.
async fn flush_inner<W: NotionWriter>(db: &Db, writer: &W) -> Result<FlushSummary, sqlx::Error> {
    let drafts = sqlx::query_as::<_, Promotion>(&format!(
        "SELECT {PROMOTION_COLS} FROM promotions \
         WHERE status = 'draft' AND target IN ('notion_backlog','notion_agenda') \
         ORDER BY created_at"
    ))
    .fetch_all(db)
    .await?;

    let mut summary = FlushSummary {
        created: 0,
        queued: 0,
        failed: 0,
    };
    for promo in drafts {
        // 토큰/DB 미설정이면 큐 유지(복구 대상). 네트워크/일시 오류도 draft로 남는다.
        let Ok((token, db_id)) = resolve_notion_target(db, &promo.signal_id, promo.target).await
        else {
            summary.queued += 1;
            continue;
        };
        // 한 건의 DB 오류가 배치 전체를 멈추지 않게 — 해당 건은 큐 유지하고 계속(복구 다음 회차에 재시도).
        match execute_promotion(db, &promo.signal_id, promo.target, writer, &token, &db_id).await {
            Ok(outcome) => match outcome.status {
                PromotionStatus::Created => summary.created += 1,
                PromotionStatus::Failed => summary.failed += 1,
                _ => summary.queued += 1,
            },
            Err(_) => summary.queued += 1,
        }
    }
    Ok(summary)
}

#[tauri::command]
#[specta::specta]
pub async fn flush_promotions(db: State<'_, Db>) -> Result<FlushSummary, String> {
    let writer = HttpNotionWriter::new().map_err(|e| e.to_string())?;
    flush_inner(db.inner(), &writer)
        .await
        .map_err(|e| e.to_string())
}

/// 승격 이력(undo/audit). signal_id가 있으면 그 신호만, 없으면 전체(최신순).
#[tauri::command]
#[specta::specta]
pub async fn list_promotions(
    db: State<'_, Db>,
    signal_id: Option<String>,
) -> Result<Vec<Promotion>, String> {
    let rows = if let Some(sid) = signal_id {
        sqlx::query_as::<_, Promotion>(&format!(
            "SELECT {PROMOTION_COLS} FROM promotions WHERE signal_id = ?1 ORDER BY created_at DESC"
        ))
        .bind(sid)
        .fetch_all(db.inner())
        .await
    } else {
        sqlx::query_as::<_, Promotion>(&format!(
            "SELECT {PROMOTION_COLS} FROM promotions ORDER BY created_at DESC"
        ))
        .fetch_all(db.inner())
        .await
    };
    rows.map_err(|e| e.to_string())
}

// ── FTS 검색 ──────────────────────────────────────────────────────────────────

/// 본문/제목 전역 검색 (FTS5). 빈 쿼리는 빈 결과.
#[tauri::command]
#[specta::specta]
pub async fn search_signals(db: State<'_, Db>, query: String) -> Result<Vec<WorkSignal>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    // 사용자 입력을 phrase로 감싸 FTS 연산자 오인을 막는다.
    let match_expr = format!("\"{}\"", q.replace('"', "\"\""));
    sqlx::query_as::<_, WorkSignal>(&format!(
        "SELECT {} FROM signals s \
         JOIN signals_fts f ON f.rowid = s.rowid \
         WHERE signals_fts MATCH ?1 ORDER BY rank",
        SIGNAL_COLS
            .split(", ")
            .map(|c| format!("s.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    ))
    .bind(match_expr)
    .fetch_all(db.inner())
    .await
    .map_err(|e| e.to_string())
}

// ── Routines (반복 작업, 별개 엔티티) ─────────────────────────────────────────

/// list_today_routines 조인 결과 (private — RoutineToday로 매핑).
#[derive(sqlx::FromRow)]
struct RoutineRow {
    id: String,
    title: String,
    freq: crate::models::RoutineFreq,
    weekdays: Option<String>,
    area: Option<crate::models::AreaTag>,
    kind: Option<Kind>,
    done: bool,
}

fn parse_weekdays(raw: Option<&str>) -> Vec<Weekday> {
    raw.and_then(|s| serde_json::from_str::<Vec<Weekday>>(s).ok())
        .unwrap_or_default()
}

/// 루틴 추가. weekly면 weekdays 사용, daily면 무시.
pub async fn insert_routine(
    db: &Db,
    input: &CreateRoutineInput,
) -> Result<RoutineToday, sqlx::Error> {
    let weekdays_json = serde_json::to_string(&input.weekdays).unwrap_or_else(|_| "[]".into());
    let row: (String,) = sqlx::query_as(
        "INSERT INTO routines (id, title, freq, weekdays, area, kind) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5) RETURNING id",
    )
    .bind(input.title.trim())
    .bind(input.freq)
    .bind(&weekdays_json)
    .bind(input.area)
    .bind(input.kind)
    .fetch_one(db)
    .await?;

    Ok(RoutineToday {
        id: row.0,
        title: input.title.trim().to_string(),
        freq: input.freq,
        weekdays: input.weekdays.clone(),
        area: input.area,
        kind: input.kind,
        done: false,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn create_routine(
    db: State<'_, Db>,
    input: CreateRoutineInput,
) -> Result<RoutineToday, String> {
    insert_routine(db.inner(), &input)
        .await
        .map_err(|e| e.to_string())
}

/// 오늘 해당하는 루틴 + 날짜별 완료 상태. daily 또는 (weekly && 오늘 요일 ∈ weekdays).
pub async fn fetch_today_routines(
    db: &Db,
    date: &str,
    weekday: Weekday,
) -> Result<Vec<RoutineToday>, sqlx::Error> {
    let rows = sqlx::query_as::<_, RoutineRow>(
        "SELECT r.id, r.title, r.freq, r.weekdays, r.area, r.kind, \
                (rc.id IS NOT NULL) AS done \
         FROM routines r \
         LEFT JOIN routine_checks rc ON rc.routine_id = r.id AND rc.date = ?1 \
         WHERE r.active = 1 ORDER BY r.created_at",
    )
    .bind(date)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let weekdays = parse_weekdays(r.weekdays.as_deref());
            let matches_today = match r.freq {
                crate::models::RoutineFreq::Daily => true,
                crate::models::RoutineFreq::Weekly => weekdays.contains(&weekday),
            };
            if !matches_today {
                return None;
            }
            Some(RoutineToday {
                id: r.id,
                title: r.title,
                freq: r.freq,
                weekdays,
                area: r.area,
                kind: r.kind,
                done: r.done,
            })
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn list_today_routines(
    db: State<'_, Db>,
    date: String,
    weekday: Weekday,
) -> Result<Vec<RoutineToday>, String> {
    fetch_today_routines(db.inner(), &date, weekday)
        .await
        .map_err(|e| e.to_string())
}

/// 루틴 완료 토글 (날짜별). done이면 RoutineCheck 추가, 아니면 삭제 → 다음날 자동 리셋.
#[tauri::command]
#[specta::specta]
pub async fn toggle_routine_check(
    db: State<'_, Db>,
    routine_id: String,
    date: String,
    done: bool,
) -> Result<(), String> {
    if done {
        sqlx::query(
            "INSERT OR IGNORE INTO routine_checks (id, routine_id, date) \
             VALUES (lower(hex(randomblob(16))), ?1, ?2)",
        )
        .bind(&routine_id)
        .bind(&date)
        .execute(db.inner())
        .await
        .map_err(|e| e.to_string())?;
    } else {
        sqlx::query("DELETE FROM routine_checks WHERE routine_id = ?1 AND date = ?2")
            .bind(&routine_id)
            .bind(&date)
            .execute(db.inner())
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

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

// ── Worktree & Branch Diff (Phase 5, read-only) ──────────────────────────────────
// INVARIANT #6: Diff Viewer는 워킹트리/브랜치를 변경하지 않는다(git.rs는 read 서브커맨드만).
// ambient — DB 영속 없이 매 호출마다 git에서 fresh 도출(PR Radar 선례). git 접근은 Rust에.

/// worktree 도출 대상 로컬 레포 (local_path 보유 + enabled).
struct LocalRepoRef {
    repo_id: String,
    project_id: String,
    /// 표시 라벨 (remote owner/repo 또는 local_path basename).
    label: String,
    local_path: String,
    default_branch: String,
}

/// 경로 마지막 세그먼트 (local 레포 라벨 fallback).
fn path_basename(p: &str) -> String {
    p.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(p)
        .to_string()
}

/// enabled + local_path 보유 레포 로드 (project_id=None이면 전체 — 멀티 repo 동시 표시).
async fn fetch_local_repo_refs(
    db: &Db,
    project_id: Option<&str>,
) -> Result<Vec<LocalRepoRef>, String> {
    let rows: Vec<(String, String, Option<String>, String, String)> = if let Some(pid) = project_id
    {
        sqlx::query_as(
            "SELECT id, project_id, remote_url, local_path, default_branch FROM repos \
             WHERE enabled = 1 AND local_path IS NOT NULL AND local_path != '' AND project_id = ?1 \
             ORDER BY created_at",
        )
        .bind(pid)
        .fetch_all(db)
        .await
    } else {
        sqlx::query_as(
            "SELECT id, project_id, remote_url, local_path, default_branch FROM repos \
             WHERE enabled = 1 AND local_path IS NOT NULL AND local_path != '' \
             ORDER BY created_at",
        )
        .fetch_all(db)
        .await
    }
    .map_err(|e| e.to_string())?;

    let mut refs = Vec::new();
    for (repo_id, pid, remote_url, local_path, default_branch) in rows {
        let label = remote_url
            .as_deref()
            .and_then(crate::github::parse_owner_repo)
            .map(|(o, r)| format!("{o}/{r}"))
            .unwrap_or_else(|| path_basename(&local_path));
        refs.push(LocalRepoRef {
            repo_id,
            project_id: pid,
            label,
            local_path,
            default_branch,
        });
    }
    Ok(refs)
}

/// worktree 도출 코어(테스트 가능 — provider를 fake로 대체). repo별 실패는 격리(그 repo만 건너뜀),
/// 전부 실패면 Err로 노출(삼키지 않음). bare 워킹트리/상태 조회 실패 worktree는 제외한다.
async fn collect_worktrees<G: GitProvider>(
    provider: &G,
    repos: &[LocalRepoRef],
    now: chrono::DateTime<chrono::Utc>,
) -> Result<Vec<Worktree>, String> {
    let mut out: Vec<Worktree> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut ok_any = false;
    let stamp = now.to_rfc3339(); // ambient — 이 도출 cycle의 단일 시각.

    for repo in repos {
        let raws = match provider.list_worktrees(&repo.local_path).await {
            Ok(v) => v,
            Err(e) => {
                errors.push(format!("{}: {e}", repo.label));
                continue;
            }
        };
        ok_any = true;
        for raw in raws {
            if raw.bare {
                continue; // bare는 diff 대상 아님.
            }
            let st = match provider.status(&raw.path).await {
                Ok(s) => s,
                Err(e) => {
                    // 상태를 못 읽으면 "clean"으로 거짓 표기하지 않고 제외 + 기록.
                    errors.push(format!("{} status: {e}", raw.path));
                    continue;
                }
            };
            out.push(Worktree {
                id: format!("{}:{}", repo.repo_id, raw.path),
                repo_id: repo.repo_id.clone(),
                project_id: repo.project_id.clone(),
                repo_label: repo.label.clone(),
                path: raw.path,
                branch: raw.branch,
                head: raw.head,
                base_branch: repo.default_branch.clone(),
                is_primary: raw.is_primary,
                status: summarize_status(st),
                dirty: st.dirty,
                ahead: st.ahead,
                behind: st.behind,
                last_fetched_at: stamp.clone(),
            });
        }
    }

    if !ok_any && !repos.is_empty() {
        return Err(format!(
            "모든 레포 worktree 조회 실패 — {}",
            errors.join("; ")
        ));
    }
    Ok(out)
}

/// repo별 worktree를 상태 배지(ahead/behind/dirty)와 함께 나열한다. project_id=None이면 멀티 repo 전체.
/// ambient — 매 호출 git에서 fresh 도출(영속 없음). read-only(INVARIANT #6).
#[tauri::command]
#[specta::specta]
pub async fn list_worktrees(
    db: State<'_, Db>,
    project_id: Option<String>,
) -> Result<Vec<Worktree>, String> {
    let repos = fetch_local_repo_refs(db.inner(), project_id.as_deref()).await?;
    if repos.is_empty() {
        return Ok(Vec::new());
    }
    collect_worktrees(&CliGitProvider, &repos, chrono::Utc::now()).await
}

/// worktree의 로컬+원격추적 브랜치 (branch↔branch 비교 picker용).
#[tauri::command]
#[specta::specta]
pub async fn list_worktree_branches(worktree_path: String) -> Result<Vec<String>, String> {
    CliGitProvider
        .branches(&worktree_path)
        .await
        .map_err(|e| e.to_string())
}

/// 비교 모드의 파일 목록(통계만 — hunk는 지연 로드). 대용량 diff 비차단의 1단계.
#[tauri::command]
#[specta::specta]
pub async fn worktree_diff_files(
    worktree_path: String,
    mode: DiffMode,
    base_ref: Option<String>,
    head_ref: Option<String>,
) -> Result<Vec<DiffFileSummary>, String> {
    CliGitProvider
        .diff_files(
            &worktree_path,
            mode,
            base_ref.as_deref(),
            head_ref.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())
}

/// 한 파일의 unified diff 텍스트(프런트 구문강조용). 선택한 파일만 지연 로드(비차단 2단계).
#[tauri::command]
#[specta::specta]
pub async fn worktree_file_diff(
    worktree_path: String,
    mode: DiffMode,
    base_ref: Option<String>,
    head_ref: Option<String>,
    path: String,
) -> Result<String, String> {
    CliGitProvider
        .file_diff(
            &worktree_path,
            mode,
            base_ref.as_deref(),
            head_ref.as_deref(),
            &path,
        )
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use crate::github::GithubError;
    use crate::models::{ProjectKind, Provider, RoutineFreq, SignalSource};
    use crate::notion::CreatedPage;
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 테스트용 fake Notion writer — 정해진 결과를 돌려주고 호출 횟수를 센다(실 네트워크 없음).
    /// `delay_ms`로 write 임계 구간을 넓혀 동시 승격 경합을 재현한다.
    struct CountingWriter {
        result: Result<CreatedPage, NotionError>,
        calls: AtomicU32,
        delay_ms: u64,
    }
    impl CountingWriter {
        fn ok(id: &str, url: &str) -> Self {
            Self {
                result: Ok(CreatedPage {
                    id: id.into(),
                    url: url.into(),
                }),
                calls: AtomicU32::new(0),
                delay_ms: 0,
            }
        }
        fn err(e: NotionError) -> Self {
            Self {
                result: Err(e),
                calls: AtomicU32::new(0),
                delay_ms: 0,
            }
        }
        fn slow_ok(id: &str, url: &str, delay_ms: u64) -> Self {
            let mut w = Self::ok(id, url);
            w.delay_ms = delay_ms;
            w
        }
    }
    impl NotionWriter for CountingWriter {
        async fn create_page(
            &self,
            _token: &str,
            _db_id: &str,
            _title: &str,
        ) -> Result<CreatedPage, NotionError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            if self.delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
            }
            self.result.clone()
        }
    }

    async fn fresh_db() -> Db {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("wr-cmd-test-{nanos}-{seq}.db"));
        init_db(&path).await.expect("init_db")
    }

    fn input(title: &str, kind: Option<Kind>) -> CreateSignalInput {
        CreateSignalInput {
            title: title.to_string(),
            kind,
            project_id: None,
        }
    }

    fn project_input(name: &str, kind: ProjectKind) -> CreateProjectInput {
        CreateProjectInput {
            name: name.to_string(),
            kind,
            notion_backlog_db_id: None,
            notion_agenda_db_id: None,
            ticket_key_pattern: None,
        }
    }

    /// 개인 1 + 업무 1 프로젝트 생성, credential_ref가 채워지고 서로 다르다(분리 키).
    #[tokio::test]
    async fn create_personal_and_work_projects() {
        let db = fresh_db().await;
        let personal = insert_project(&db, &project_input("내 삶", ProjectKind::Personal))
            .await
            .unwrap();
        let work = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        assert!(matches!(personal.kind, ProjectKind::Personal));
        assert!(matches!(work.kind, ProjectKind::Work));
        assert!(!personal.credential_ref.is_empty());
        assert_ne!(
            personal.credential_ref, work.credential_ref,
            "project별 keychain 키는 분리"
        );
        assert_eq!(fetch_projects(&db).await.unwrap().len(), 2);
    }

    /// repo 추가 후 project별 목록에 표시되고 default_branch 기본값이 채워진다.
    #[tokio::test]
    async fn create_repo_lists_under_project() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let repo = insert_repo(
            &db,
            &CreateRepoInput {
                project_id: proj.id.clone(),
                provider: Provider::Github,
                remote_url: Some("https://github.com/64etuor/work-radar".into()),
                local_path: None,
                default_branch: None,
                ticket_key_pattern: Some(r"MIR-DEV-\d+".into()),
            },
        )
        .await
        .unwrap();
        assert!(matches!(repo.provider, Provider::Github));
        assert_eq!(repo.default_branch, "main", "비면 main 기본값");
        assert!(repo.enabled);
        let repos = fetch_repos(&db, &proj.id).await.unwrap();
        assert_eq!(repos.len(), 1);
        // 다른 프로젝트엔 안 보임.
        let other = insert_project(&db, &project_input("내 삶", ProjectKind::Personal))
            .await
            .unwrap();
        assert!(fetch_repos(&db, &other.id).await.unwrap().is_empty());
    }

    /// reconcile: 미태깅 신호를 kind 매칭 프로젝트로 태깅 (Phase 1 kind 힌트 → projectId).
    #[tokio::test]
    async fn reconcile_tags_signals_by_kind() {
        let db = fresh_db().await;
        let personal = insert_project(&db, &project_input("내 삶", ProjectKind::Personal))
            .await
            .unwrap();
        let work = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let p_sig = insert_signal(&db, &input("커피 원두 주문", Some(Kind::Personal)))
            .await
            .unwrap();
        let w_sig = insert_signal(&db, &input("히어로 카피 다시", Some(Kind::Work)))
            .await
            .unwrap();
        // kind 없는 신호는 reconcile 대상 아님.
        let none_sig = insert_signal(&db, &input("kind 없음", None)).await.unwrap();
        assert!(p_sig.project_id.is_none());

        let n = reconcile_inner(&db).await.unwrap();
        assert_eq!(n, 2, "kind 보유 신호 2건만 태깅");

        let tagged: Vec<(String, Option<String>)> =
            sqlx::query_as("SELECT id, project_id FROM signals ORDER BY created_at")
                .fetch_all(&db)
                .await
                .unwrap();
        let pid = |id: &str| {
            tagged
                .iter()
                .find(|(i, _)| i == id)
                .and_then(|(_, p)| p.clone())
        };
        assert_eq!(pid(&p_sig.id), Some(personal.id));
        assert_eq!(pid(&w_sig.id), Some(work.id));
        assert_eq!(pid(&none_sig.id), None, "kind 없으면 미태깅 유지");
    }

    /// create_signal에 projectId를 주면 그대로 태깅된다.
    #[tokio::test]
    async fn create_signal_tags_project_id() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();
        let sig = insert_signal(
            &db,
            &CreateSignalInput {
                title: "프로젝트 태깅 신호".into(),
                kind: Some(Kind::Work),
                project_id: Some(proj.id.clone()),
            },
        )
        .await
        .unwrap();
        assert_eq!(sig.project_id, Some(proj.id));
    }

    /// INVARIANT #1: 생성된 카드는 항상 unclassified로 진입한다.
    #[tokio::test]
    async fn create_signal_is_always_unclassified() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("히어로 카피 다시", Some(Kind::Work)))
            .await
            .unwrap();
        assert!(matches!(sig.quadrant, Quadrant::Unclassified));
        assert!(matches!(sig.status, SignalStatus::New));
        assert!(matches!(sig.kind, Some(Kind::Work)));
        assert!(matches!(sig.source, SignalSource::Braindump));
        assert!(sig.today_for_date.is_none());
    }

    /// INVARIANT #3: 같은 입력은 dedup으로 합쳐진다 (새 행 생성 안 함).
    #[tokio::test]
    async fn create_signal_dedups_same_input() {
        let db = fresh_db().await;
        let a = insert_signal(&db, &input("커피 원두 주문", None))
            .await
            .unwrap();
        // 공백/대소문자만 다른 동일 입력.
        let b = insert_signal(&db, &input("  커피 원두 주문  ", None))
            .await
            .unwrap();
        assert_eq!(a.id, b.id, "동일 입력은 같은 신호로 합쳐져야 함");
        let all = fetch_signals(&db).await.unwrap();
        assert_eq!(all.len(), 1, "dedup이면 행은 하나");
    }

    /// INVARIANT #1: quadrant는 명시적 classify 호출로만 바뀐다.
    #[tokio::test]
    async fn classify_is_the_only_quadrant_path() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("PR CI 빨강 추적", Some(Kind::Work)))
            .await
            .unwrap();
        let classified = set_quadrant(&db, &sig.id, Quadrant::Q1DoNow).await.unwrap();
        assert!(matches!(classified.quadrant, Quadrant::Q1DoNow));
        assert!(matches!(classified.status, SignalStatus::Classified));
    }

    /// 승격 시 매트릭스에서 빠지고 Today에 나타난다. quadrant 배지는 유지된다.
    #[tokio::test]
    async fn promote_today_moves_card_to_today_rail() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("금요일 데모 리허설", Some(Kind::Work)))
            .await
            .unwrap();
        set_quadrant(&db, &sig.id, Quadrant::Q1DoNow).await.unwrap();
        promote_today_inner(&db, &sig.id, "2026-05-21")
            .await
            .unwrap();

        let matrix = fetch_signals(&db).await.unwrap();
        assert!(matrix.is_empty(), "승격된 카드는 매트릭스에서 제외");

        let today = fetch_today(&db, "2026-05-21").await.unwrap();
        assert_eq!(today.len(), 1);
        assert!(
            matches!(today[0].quadrant, Quadrant::Q1DoNow),
            "Q 배지 유지"
        );

        // 되돌리기 → 원 사분면으로 복귀, 매트릭스에 재등장.
        unpromote_today_inner(&db, &sig.id).await.unwrap();
        let matrix2 = fetch_signals(&db).await.unwrap();
        assert_eq!(matrix2.len(), 1);
        assert!(matches!(matrix2[0].quadrant, Quadrant::Q1DoNow));
        assert!(fetch_today(&db, "2026-05-21").await.unwrap().is_empty());
    }

    /// 완료된 Today 항목은 당일만 보이고 다음날 이월되지 않는다(rollover 제외).
    #[tokio::test]
    async fn completed_today_item_does_not_roll_over() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("세금계산서 확인", None))
            .await
            .unwrap();
        promote_today_inner(&db, &sig.id, "2026-05-21")
            .await
            .unwrap();

        // 미완료: 다음날에도 잔류(rollover).
        assert_eq!(fetch_today(&db, "2026-05-22").await.unwrap().len(), 1);

        // 5/21에 완료 처리.
        sqlx::query("UPDATE signals SET today_done_at = '2026-05-21' WHERE id = ?1")
            .bind(&sig.id)
            .execute(&db)
            .await
            .unwrap();
        assert_eq!(
            fetch_today(&db, "2026-05-21").await.unwrap().len(),
            1,
            "당일엔 보임"
        );
        assert!(
            fetch_today(&db, "2026-05-22").await.unwrap().is_empty(),
            "완료는 다음날 이월 안 됨"
        );
    }

    /// INVARIANT #2: 외부 승격은 draft만 — 외부 무변경, status=draft.
    #[tokio::test]
    async fn promotion_draft_is_draft_only() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("백로그 후보", Some(Kind::Work)))
            .await
            .unwrap();
        let promo = insert_promotion_draft(&db, &sig.id, PromotionTarget::NotionBacklog)
            .await
            .unwrap();
        assert!(matches!(
            promo.status,
            crate::models::PromotionStatus::Draft
        ));
        assert!(
            promo.created_external_id.is_none(),
            "외부 ID 없음(외부 무변경)"
        );
    }

    /// 루틴: 오늘 요일 매칭 + 날짜별 완료 토글 → 다음날 리셋.
    #[tokio::test]
    async fn routine_today_matching_and_per_date_check() {
        let db = fresh_db().await;
        // 수·금 루틴.
        insert_routine(
            &db,
            &CreateRoutineInput {
                title: "주간 회고".into(),
                freq: RoutineFreq::Weekly,
                weekdays: vec![Weekday::Wed, Weekday::Fri],
                area: None,
                kind: Some(Kind::Work),
            },
        )
        .await
        .unwrap();

        // 금요일이면 표시, 목요일이면 미표시.
        let fri = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        assert_eq!(fri.len(), 1);
        assert!(!fri[0].done);
        let thu = fetch_today_routines(&db, "2026-05-21", Weekday::Thu)
            .await
            .unwrap();
        assert!(thu.is_empty(), "목요일엔 수·금 루틴 미표시");

        // 금요일 완료 체크 → 그날만 done, 토요일은 새 날짜라 리셋.
        let rid = fri[0].id.clone();
        toggle_check(&db, &rid, "2026-05-22", true).await;
        let fri_done = fetch_today_routines(&db, "2026-05-22", Weekday::Fri)
            .await
            .unwrap();
        assert!(fri_done[0].done);
    }

    // 테스트 헬퍼: command 본문과 동일 로직 (State 없이).
    async fn toggle_check(db: &Db, routine_id: &str, date: &str, done: bool) {
        if done {
            sqlx::query(
                "INSERT OR IGNORE INTO routine_checks (id, routine_id, date) \
                 VALUES (lower(hex(randomblob(16))), ?1, ?2)",
            )
            .bind(routine_id)
            .bind(date)
            .execute(db)
            .await
            .unwrap();
        }
    }

    /// FTS: 본문/제목 매칭.
    #[tokio::test]
    async fn fts_matches_title() {
        let db = fresh_db().await;
        insert_signal(&db, &input("deploy radar pipeline", Some(Kind::Work)))
            .await
            .unwrap();
        let hits = sqlx::query_as::<_, WorkSignal>(&format!(
            "SELECT {} FROM signals s JOIN signals_fts f ON f.rowid = s.rowid \
             WHERE signals_fts MATCH ?1",
            SIGNAL_COLS
                .split(", ")
                .map(|c| format!("s.{c}"))
                .collect::<Vec<_>>()
                .join(", ")
        ))
        .bind("pipeline")
        .fetch_all(&db)
        .await
        .unwrap();
        assert_eq!(hits.len(), 1);
    }

    // ── Phase 3: Notion 승격(write) 코어 ──────────────────────────────────────

    async fn promo_status(db: &Db, signal_id: &str) -> String {
        let r: (String,) = sqlx::query_as("SELECT status FROM promotions WHERE signal_id = ?1")
            .bind(signal_id)
            .fetch_one(db)
            .await
            .unwrap();
        r.0
    }

    /// 성공: promotion=created(+외부ID), signal=linked(+links), page_url 반환.
    #[tokio::test]
    async fn promote_creates_page_logs_and_links_signal() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("백로그 후보", Some(Kind::Work)))
            .await
            .unwrap();
        let writer = CountingWriter::ok("page-1", "https://www.notion.so/page-1");

        let outcome = execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "tok",
            "db",
        )
        .await
        .unwrap();
        assert!(matches!(outcome.status, PromotionStatus::Created));
        assert_eq!(
            outcome.page_url.as_deref(),
            Some("https://www.notion.so/page-1")
        );

        // promotions: 외부 ID가 로컬에 기록됨(undo/audit 데이터, INVARIANT #7).
        let p: (String, Option<String>) = sqlx::query_as(
            "SELECT status, created_external_id FROM promotions WHERE signal_id = ?1",
        )
        .bind(&sig.id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(p.0, "created");
        assert_eq!(p.1.as_deref(), Some("page-1"));

        // signal: linked + links 미러.
        let s: (String, Option<String>) =
            sqlx::query_as("SELECT status, links FROM signals WHERE id = ?1")
                .bind(&sig.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(s.0, "linked");
        assert!(s.1.unwrap_or_default().contains("notionBacklogId"));
    }

    /// 일시 실패: draft 유지(오프라인 큐). status=draft, 외부 ID 없음.
    #[tokio::test]
    async fn promote_transient_keeps_draft_queued() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("일시 오류 후보", Some(Kind::Work)))
            .await
            .unwrap();
        let writer = CountingWriter::err(NotionError::Transient("connection refused".into()));

        let outcome = execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "t",
            "d",
        )
        .await
        .unwrap();
        assert!(matches!(outcome.status, PromotionStatus::Draft));
        assert_eq!(promo_status(&db, &sig.id).await, "draft", "큐에 남아야 함");
    }

    /// 영구 실패: failed로 표시.
    #[tokio::test]
    async fn promote_terminal_marks_failed() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("권한 오류 후보", Some(Kind::Work)))
            .await
            .unwrap();
        let writer = CountingWriter::err(NotionError::Terminal("HTTP 401".into()));

        let outcome = execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "t",
            "d",
        )
        .await
        .unwrap();
        assert!(matches!(outcome.status, PromotionStatus::Failed));
        assert_eq!(promo_status(&db, &sig.id).await, "failed");
    }

    /// 멱등(INVARIANT #3): 이미 created면 재승격이 중복 write/행 없이 기존 결과를 반환.
    #[tokio::test]
    async fn promote_is_idempotent_when_already_created() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("중복 클릭 후보", Some(Kind::Work)))
            .await
            .unwrap();
        let writer = CountingWriter::ok("p1", "https://www.notion.so/p1");

        execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "t",
            "d",
        )
        .await
        .unwrap();
        let again = execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "t",
            "d",
        )
        .await
        .unwrap();
        assert!(matches!(again.status, PromotionStatus::Created));
        assert_eq!(
            writer.calls.load(Ordering::Relaxed),
            1,
            "두 번째 클릭은 write를 다시 호출하지 않음"
        );
        let count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM promotions WHERE signal_id = ?1 AND target = 'notion_backlog'",
        )
        .bind(&sig.id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(count.0, 1, "promotion 행은 하나");
    }

    /// 복구 flush 전이: 큐(draft)에 있던 행을 재사용해 created로 전이(같은 행).
    #[tokio::test]
    async fn queued_draft_flushes_to_created() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("큐 후보", Some(Kind::Work)))
            .await
            .unwrap();
        // 오프라인에 쌓인 draft를 모사.
        let draft = insert_promotion_draft(&db, &sig.id, PromotionTarget::NotionBacklog)
            .await
            .unwrap();
        assert!(matches!(draft.status, PromotionStatus::Draft));

        let writer = CountingWriter::ok("p9", "https://www.notion.so/p9");
        let outcome = execute_promotion(
            &db,
            &sig.id,
            PromotionTarget::NotionBacklog,
            &writer,
            "t",
            "d",
        )
        .await
        .unwrap();
        assert!(matches!(outcome.status, PromotionStatus::Created));
        assert_eq!(outcome.promotion_id, draft.id, "같은 draft 행을 재사용");
        let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM promotions WHERE signal_id = ?1")
            .bind(&sig.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count.0, 1, "새 행을 만들지 않음");
    }

    /// 타깃 가드: calendar/today는 Notion write 경로로 승격 불가(Err).
    #[tokio::test]
    async fn resolve_rejects_non_notion_target() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("일정 후보", None)).await.unwrap();
        assert!(
            resolve_notion_target(&db, &sig.id, PromotionTarget::Calendar)
                .await
                .is_err()
        );
        assert!(resolve_notion_target(&db, &sig.id, PromotionTarget::Today)
            .await
            .is_err());
    }

    /// 프로젝트 미지정 신호는 명확한 Err(자동 추정 금지).
    #[tokio::test]
    async fn resolve_errors_without_project() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("미태깅 후보", None))
            .await
            .unwrap();
        let r = resolve_notion_target(&db, &sig.id, PromotionTarget::NotionBacklog).await;
        assert!(r.is_err(), "프로젝트 없으면 승격 불가");
    }

    /// INVARIANT #3(동시성): 같은 카드를 동시에 두 번 승격해도 write는 1회·created 행은 1개.
    /// (게이트 없으면 둘 다 created 없음을 보고 write를 2번 호출 → 중복 Notion 페이지.)
    #[tokio::test]
    async fn concurrent_promote_writes_once() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("동시 클릭 후보", Some(Kind::Work)))
            .await
            .unwrap();
        // write 임계 구간을 넓혀 두 호출이 확실히 겹치게 한다.
        let writer = CountingWriter::slow_ok("p1", "https://www.notion.so/p1", 30);

        let (a, b) = tokio::join!(
            execute_promotion(
                &db,
                &sig.id,
                PromotionTarget::NotionBacklog,
                &writer,
                "t",
                "d"
            ),
            execute_promotion(
                &db,
                &sig.id,
                PromotionTarget::NotionBacklog,
                &writer,
                "t",
                "d"
            ),
        );
        a.unwrap();
        b.unwrap();

        assert_eq!(
            writer.calls.load(Ordering::Relaxed),
            1,
            "동시 승격이라도 외부 write는 한 번만"
        );
        let created: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM promotions WHERE signal_id = ?1 AND status = 'created'",
        )
        .bind(&sig.id)
        .fetch_one(&db)
        .await
        .unwrap();
        assert_eq!(created.0, 1, "created 행은 하나");
    }

    /// 구조적 2차 방어선(0003): (signal,target)당 created는 DB가 1개로 강제한다.
    #[tokio::test]
    async fn partial_unique_index_blocks_second_created() {
        let db = fresh_db().await;
        let sig = insert_signal(&db, &input("유니크 후보", None))
            .await
            .unwrap();
        let first = sqlx::query(
            "INSERT INTO promotions (id, signal_id, target, status, draft_payload) \
             VALUES ('p1', ?1, 'notion_backlog', 'created', '{}')",
        )
        .bind(&sig.id)
        .execute(&db)
        .await;
        assert!(first.is_ok(), "첫 created는 성공");
        let dup = sqlx::query(
            "INSERT INTO promotions (id, signal_id, target, status, draft_payload) \
             VALUES ('p2', ?1, 'notion_backlog', 'created', '{}')",
        )
        .bind(&sig.id)
        .execute(&db)
        .await;
        assert!(
            dup.is_err(),
            "같은 (signal,target)의 두 번째 created는 partial unique index가 거부"
        );
    }

    // ── Phase 4: PR Radar (버킷/escalate/dedup/auto-resolve) ──────────────────

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

    // ── Phase 5: Worktree & Branch Diff ─────────────────────────────────────────

    use crate::git::{GitError, RawStatus, RawWorktree};

    /// fake GitProvider — repo_path별 worktree 목록 + worktree_path별 상태를 미리 심는다(실 git 없음).
    struct FakeGit {
        worktrees: std::collections::HashMap<String, Result<Vec<RawWorktree>, GitError>>,
        statuses: std::collections::HashMap<String, RawStatus>,
    }
    impl GitProvider for FakeGit {
        async fn list_worktrees(&self, repo_path: &str) -> Result<Vec<RawWorktree>, GitError> {
            self.worktrees
                .get(repo_path)
                .cloned()
                .unwrap_or_else(|| Ok(vec![]))
        }
        async fn status(&self, worktree_path: &str) -> Result<RawStatus, GitError> {
            Ok(self
                .statuses
                .get(worktree_path)
                .copied()
                .unwrap_or_default())
        }
        async fn branches(&self, _repo_path: &str) -> Result<Vec<String>, GitError> {
            Ok(vec![])
        }
        async fn diff_files(
            &self,
            _wt: &str,
            _mode: DiffMode,
            _base: Option<&str>,
            _head: Option<&str>,
        ) -> Result<Vec<DiffFileSummary>, GitError> {
            Ok(vec![])
        }
        async fn file_diff(
            &self,
            _wt: &str,
            _mode: DiffMode,
            _base: Option<&str>,
            _head: Option<&str>,
            _path: &str,
        ) -> Result<String, GitError> {
            Ok(String::new())
        }
    }

    fn raw_wt(path: &str, branch: Option<&str>, primary: bool, bare: bool) -> RawWorktree {
        RawWorktree {
            path: path.to_string(),
            branch: branch.map(|b| b.to_string()),
            head: "deadbeef".to_string(),
            is_primary: primary,
            bare,
        }
    }

    fn local_repo(repo_id: &str, project_id: &str, path: &str) -> LocalRepoRef {
        LocalRepoRef {
            repo_id: repo_id.to_string(),
            project_id: project_id.to_string(),
            label: format!("label-{repo_id}"),
            local_path: path.to_string(),
            default_branch: "dev".to_string(),
        }
    }

    fn now() -> chrono::DateTime<chrono::Utc> {
        chrono::Utc::now()
    }

    /// 멀티 repo의 worktree가 상태 배지(ahead/behind/dirty)와 함께 도출되고 bare는 제외된다.
    #[tokio::test]
    async fn collect_worktrees_multi_repo_with_status() {
        let mut worktrees = std::collections::HashMap::new();
        worktrees.insert(
            "/repoA".to_string(),
            Ok(vec![
                raw_wt("/repoA/main", Some("dev"), true, false),
                raw_wt("/repoA/feat", Some("feature"), false, false),
                raw_wt("/repoA/bare", None, false, true), // 제외 대상
            ]),
        );
        worktrees.insert(
            "/repoB".to_string(),
            Ok(vec![raw_wt("/repoB/main", None, true, false)]), // detached
        );
        let mut statuses = std::collections::HashMap::new();
        statuses.insert(
            "/repoA/main".to_string(),
            RawStatus {
                dirty: true,
                ahead: 0,
                behind: 0,
            },
        );
        statuses.insert(
            "/repoA/feat".to_string(),
            RawStatus {
                dirty: false,
                ahead: 2,
                behind: 1,
            },
        );
        // /repoB/main 상태 미지정 → default(clean).
        let provider = FakeGit {
            worktrees,
            statuses,
        };
        let repos = vec![
            local_repo("ra", "p1", "/repoA"),
            local_repo("rb", "p2", "/repoB"),
        ];

        let wts = collect_worktrees(&provider, &repos, now()).await.unwrap();
        // bare 제외 → A 2 + B 1 = 3.
        assert_eq!(wts.len(), 3);

        let main = wts.iter().find(|w| w.path == "/repoA/main").unwrap();
        assert_eq!(main.id, "ra:/repoA/main");
        assert_eq!(main.project_id, "p1");
        assert_eq!(main.branch.as_deref(), Some("dev"));
        assert!(main.is_primary);
        assert!(main.dirty);
        assert!(matches!(main.status, crate::models::WorktreeStatus::Dirty));
        assert_eq!(main.base_branch, "dev");

        let feat = wts.iter().find(|w| w.path == "/repoA/feat").unwrap();
        assert_eq!((feat.ahead, feat.behind), (2, 1));
        assert!(matches!(
            feat.status,
            crate::models::WorktreeStatus::Diverged
        ));

        let b = wts.iter().find(|w| w.path == "/repoB/main").unwrap();
        assert_eq!(b.branch, None, "detached → branch None");
        assert!(matches!(b.status, crate::models::WorktreeStatus::Clean));
        assert!(wts.iter().all(|w| w.path != "/repoA/bare"), "bare 제외");
    }

    /// 일부 repo 실패는 그 repo만 건너뛰고 나머지는 도출(격리). 전부 실패면 Err.
    #[tokio::test]
    async fn collect_worktrees_isolates_and_surfaces_failure() {
        let mut worktrees = std::collections::HashMap::new();
        worktrees.insert(
            "/bad".to_string(),
            Err(GitError("not a git repo".to_string())),
        );
        worktrees.insert(
            "/good".to_string(),
            Ok(vec![raw_wt("/good/main", Some("dev"), true, false)]),
        );
        let provider = FakeGit {
            worktrees,
            statuses: std::collections::HashMap::new(),
        };

        // 하나 실패 + 하나 성공 → 성공분만 반환(Err 아님).
        let mixed = vec![
            local_repo("bad", "p1", "/bad"),
            local_repo("good", "p1", "/good"),
        ];
        let wts = collect_worktrees(&provider, &mixed, now()).await.unwrap();
        assert_eq!(wts.len(), 1);
        assert_eq!(wts[0].path, "/good/main");

        // 전부 실패 → terminal failure 노출(삼키지 않음).
        let all_bad = vec![local_repo("bad", "p1", "/bad")];
        assert!(collect_worktrees(&provider, &all_bad, now()).await.is_err());
    }

    /// fetch_local_repo_refs: enabled + local_path 보유만, project 필터, 라벨 도출(remote→owner/repo).
    #[tokio::test]
    async fn fetch_local_repo_refs_filters_and_labels() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("업무", ProjectKind::Work))
            .await
            .unwrap();
        // remote+local 보유 → owner/repo 라벨.
        insert_repo(
            &db,
            &CreateRepoInput {
                project_id: proj.id.clone(),
                provider: Provider::Github,
                remote_url: Some("https://github.com/64etuor/work-radar".into()),
                local_path: Some("/work/work-radar".into()),
                default_branch: Some("dev".into()),
                ticket_key_pattern: None,
            },
        )
        .await
        .unwrap();
        // local_path 없는 레포 → 제외.
        insert_repo(
            &db,
            &CreateRepoInput {
                project_id: proj.id.clone(),
                provider: Provider::Github,
                remote_url: Some("https://github.com/64etuor/other".into()),
                local_path: None,
                default_branch: None,
                ticket_key_pattern: None,
            },
        )
        .await
        .unwrap();

        let refs = fetch_local_repo_refs(&db, Some(&proj.id)).await.unwrap();
        assert_eq!(refs.len(), 1, "local_path 보유 레포만");
        assert_eq!(refs[0].label, "64etuor/work-radar");
        assert_eq!(refs[0].local_path, "/work/work-radar");

        // 다른 프로젝트로 필터하면 0건.
        let other = insert_project(&db, &project_input("개인", ProjectKind::Personal))
            .await
            .unwrap();
        assert!(fetch_local_repo_refs(&db, Some(&other.id))
            .await
            .unwrap()
            .is_empty());
        // None이면 전체(이 DB엔 1건).
        assert_eq!(fetch_local_repo_refs(&db, None).await.unwrap().len(), 1);
    }
}
