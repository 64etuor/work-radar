use tauri::State;

use crate::commands::signal_store;
use crate::db::Db;
use crate::error::AppError;
use crate::keychain;
use crate::models::{
    CreateProjectInput, CreateRepoInput, Project, ProjectKind, Provider, Repo,
    SetProjectCalendarColorInput, SetProjectDefaultWriteCalendarInput, SetProjectNotionDbIdsInput,
    TokenKind, WorkSignal,
};
use crate::notion::normalize_notion_db_id;

// ── Projects (Phase 0) ────────────────────────────────────────────────────────

/// 순수 DB 조회. command와 테스트가 공유한다 (State 없이 풀만 받음).
pub(crate) async fn fetch_projects(db: &Db) -> Result<Vec<Project>, sqlx::Error> {
    sqlx::query_as::<_, Project>(&format!(
        "SELECT {PROJECT_COLS} FROM projects ORDER BY created_at"
    ))
    .fetch_all(db)
    .await
}

/// 모든 프로젝트 목록. Phase 0에서는 빈 DB라 빈 배열을 반환한다.
#[tauri::command]
#[specta::specta]
pub async fn list_projects(db: State<'_, Db>) -> Result<Vec<Project>, AppError> {
    Ok(fetch_projects(db.inner()).await?)
}

/// 단일 프로젝트 조회(id로). 없으면 None. External Action Gate write 툴이 제안자가 준 project_id의
/// 실재성·소유 검증과 credential_ref/이름/kind 해석에 쓴다(#11: raw project_ref 신뢰 금지).
pub(crate) async fn fetch_project(
    db: &Db,
    project_id: &str,
) -> Result<Option<Project>, sqlx::Error> {
    sqlx::query_as::<_, Project>(&format!(
        "SELECT {PROJECT_COLS} FROM projects WHERE id = ?1"
    ))
    .bind(project_id)
    .fetch_optional(db)
    .await
}

/// Project SELECT/RETURNING 공통 컬럼.
const PROJECT_COLS: &str = "id, name, kind, notion_backlog_db_id, notion_agenda_db_id, \
     google_calendar_ids, calendar_color, default_write_calendar_id, credential_ref, \
     created_at, updated_at";
/// Repo SELECT/RETURNING 공통 컬럼.
const REPO_COLS: &str = "id, project_id, provider, remote_url, local_path, default_branch, \
     enabled, created_at";

/// 프로젝트 생성. `credential_ref`는 백엔드가 생성하는 keychain 분리 키(토큰 본문 아님).
/// Notion DB ID는 저장 전 정규화(dashed UUID 형식). 유효하지 않은 ID는 Protocol 에러.
pub(crate) async fn insert_project(
    db: &Db,
    input: &CreateProjectInput,
) -> Result<Project, sqlx::Error> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(sqlx::Error::Protocol("empty project name".into()));
    }
    // Notion DB ID 정규화 — 사용자가 URL이나 raw hex를 붙여넣어도 표준 UUID로 저장한다.
    let backlog_db_id = input
        .notion_backlog_db_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(normalize_notion_db_id)
        .transpose()
        .map_err(|e| sqlx::Error::Protocol(format!("notion_backlog_db_id: {e}")))?;
    let agenda_db_id = input
        .notion_agenda_db_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(normalize_notion_db_id)
        .transpose()
        .map_err(|e| sqlx::Error::Protocol(format!("notion_agenda_db_id: {e}")))?;
    sqlx::query_as::<_, Project>(&format!(
        "INSERT INTO projects \
            (id, name, kind, notion_backlog_db_id, notion_agenda_db_id, \
             credential_ref) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, lower(hex(randomblob(16)))) \
         RETURNING {PROJECT_COLS}"
    ))
    .bind(name)
    .bind(input.kind)
    .bind(&backlog_db_id)
    .bind(&agenda_db_id)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_project(
    db: State<'_, Db>,
    input: CreateProjectInput,
) -> Result<Project, AppError> {
    insert_project(db.inner(), &input).await.map_err(|e| {
        // Protocol 에러는 검증 실패(빈 이름 / 잘못된 Notion ID) — validation으로.
        match e {
            sqlx::Error::Protocol(msg) => AppError::validation("projects.invalid_input", msg),
            other => AppError::from(other),
        }
    })
}

pub(crate) async fn delete_project_core(db: &Db, project_id: &str) -> Result<(), AppError> {
    let Some((credential_ref,)) =
        sqlx::query_as::<_, (String,)>("SELECT credential_ref FROM projects WHERE id = ?1")
            .bind(project_id)
            .fetch_optional(db)
            .await?
    else {
        return Err(AppError::not_found(
            "projects.not_found",
            "project not found",
        ));
    };

    let res = sqlx::query("DELETE FROM projects WHERE id = ?1")
        .bind(project_id)
        .execute(db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::not_found(
            "projects.not_found",
            "project not found",
        ));
    }

    for kind in [
        TokenKind::Notion,
        TokenKind::Github,
        TokenKind::GoogleCalendar,
        TokenKind::Gmail,
    ] {
        if let Err(e) = keychain::delete_token(&credential_ref, kind) {
            tracing::warn!(
                code = "projects.delete_token_cleanup_failed",
                token_kind = kind.as_str(),
                error = %e,
                "project token cleanup failed"
            );
        }
    }

    Ok(())
}

/// 프로젝트 삭제. 로컬 SQLite 액션이며 외부 write 없음.
/// FK 규칙: repos는 cascade, signals/routines/agent_runs 등은 project_id=NULL.
/// keychain 토큰은 credential_ref 기준으로 best-effort cleanup 한다.
#[tauri::command]
#[specta::specta]
pub async fn delete_project(db: State<'_, Db>, project_id: String) -> Result<(), AppError> {
    delete_project_core(db.inner(), &project_id).await
}

/// 기존 프로젝트 이름 변경(`set_project_calendar_color` 미러). trim 후 빈 값 거부.
/// 단일 컬럼 UPDATE — kind 토글과 독립이라 두 편집이 겹쳐도 서로 덮어쓰지 않는다(lost-update 방지).
/// 알 수 없는 id는 `projects.not_found`.
pub(crate) async fn set_project_name_core(
    db: &Db,
    project_id: &str,
    name: &str,
) -> Result<Project, AppError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppError::validation(
            "projects.invalid_input",
            "empty project name",
        ));
    }
    sqlx::query_as::<_, Project>(&format!(
        "UPDATE projects SET name = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {PROJECT_COLS}"
    ))
    .bind(project_id)
    .bind(name)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("projects.not_found", "project not found"))
}

#[tauri::command]
#[specta::specta]
pub async fn set_project_name(
    db: State<'_, Db>,
    project_id: String,
    name: String,
) -> Result<Project, AppError> {
    set_project_name_core(db.inner(), &project_id, &name).await
}

/// 기존 프로젝트 종류(개인/업무) 변경. 단일 컬럼 UPDATE — 이름 편집과 독립.
/// `kind` 변경은 라우팅 카테고리만 이동시킬 뿐 기존 신호를 재태깅하지 않는다(신호는 자신의 kind를 보유).
pub(crate) async fn set_project_kind_core(
    db: &Db,
    project_id: &str,
    kind: ProjectKind,
) -> Result<Project, AppError> {
    sqlx::query_as::<_, Project>(&format!(
        "UPDATE projects SET kind = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {PROJECT_COLS}"
    ))
    .bind(project_id)
    .bind(kind)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("projects.not_found", "project not found"))
}

#[tauri::command]
#[specta::specta]
pub async fn set_project_kind(
    db: State<'_, Db>,
    project_id: String,
    kind: ProjectKind,
) -> Result<Project, AppError> {
    set_project_kind_core(db.inner(), &project_id, kind).await
}

// 정본 = DESIGN.md §Colors. Life Wheel과 동일한 brand-aligned 패밀리 —
// 임의의 vivid 색상 8개 대신 brand accent + 그 derivations만 사용.
const PROJECT_CALENDAR_PALETTE: [&str; 8] = [
    "#1863DC", // Action Blue
    "#003C33", // Deep Enterprise Green
    "#FF7759", // Coral
    "#071829", // Dark Navy
    "#4C6EE6", // Focus Blue
    "#5A8A78", // sage
    "#A89175", // warm stone
    "#75758A", // Slate
];

pub(crate) fn default_project_calendar_color(project_id: &str) -> String {
    let mut hash: u64 = 14_695_981_039_346_656_037;
    for b in project_id.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    PROJECT_CALENDAR_PALETTE[(hash as usize) % PROJECT_CALENDAR_PALETTE.len()].to_string()
}

pub(crate) fn normalize_project_calendar_color(
    input: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(raw) = input else {
        return Ok(None);
    };
    let s = raw.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let hex = s.strip_prefix('#').unwrap_or(s);
    if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("calendar color must be #RRGGBB".into());
    }
    Ok(Some(format!("#{hex}", hex = hex.to_ascii_uppercase())))
}

pub(crate) fn readable_text_color(background: &str) -> String {
    fn channel(v: u8) -> f64 {
        let x = f64::from(v) / 255.0;
        if x <= 0.03928 {
            x / 12.92
        } else {
            ((x + 0.055) / 1.055).powf(2.4)
        }
    }

    let hex = background
        .trim()
        .strip_prefix('#')
        .unwrap_or(background.trim());
    if hex.len() != 6 {
        return "#212121".to_string();
    }
    let parse = |range: std::ops::Range<usize>| u8::from_str_radix(&hex[range], 16).ok();
    let (Some(r), Some(g), Some(b)) = (parse(0..2), parse(2..4), parse(4..6)) else {
        return "#212121".to_string();
    };
    let luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    let contrast_dark = (luminance + 0.05) / 0.05;
    let contrast_light = 1.05 / (luminance + 0.05);
    if contrast_light > contrast_dark {
        "#FFFFFF".to_string()
    } else {
        "#212121".to_string()
    }
}

pub(crate) fn effective_project_calendar_color(project_id: &str, color: Option<&str>) -> String {
    normalize_project_calendar_color(color)
        .ok()
        .flatten()
        .unwrap_or_else(|| default_project_calendar_color(project_id))
}

pub(crate) async fn update_project_calendar_color(
    db: &Db,
    input: &SetProjectCalendarColorInput,
) -> Result<Project, AppError> {
    let color = normalize_project_calendar_color(input.color.as_deref())
        .map_err(|e| AppError::validation("projects.invalid_calendar_color", e))?;
    sqlx::query_as::<_, Project>(&format!(
        "UPDATE projects SET calendar_color = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {PROJECT_COLS}"
    ))
    .bind(&input.project_id)
    .bind(&color)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("projects.not_found", "project not found"))
}

#[tauri::command]
#[specta::specta]
pub async fn set_project_calendar_color(
    db: State<'_, Db>,
    input: SetProjectCalendarColorInput,
) -> Result<Project, AppError> {
    let project = update_project_calendar_color(db.inner(), &input).await?;
    // 이벤트 색은 fetch 시점에 캐시에 박히므로, 색 변경 후 표시 캐시를 비워 다음 fetch가 새 색으로
    // 재구성되게 한다(프런트 ["calendarEvents"] 무효화만으론 Rust 60초 TTL이 stale 색을 반환).
    crate::commands::calendar::invalidate_calendar_events_cache().await;
    Ok(project)
}

/// 프로젝트별 "일정 생성 기본 캘린더" id 변경. Today×Timeline drop 시 사용된다 (spec §D9).
/// `calendar_id=None`이면 미설정으로 클리어 — 다음 드롭에서 다시 popover로 묻는다.
/// 유효성 검증(googleCalendarIds 멤버십)은 프런트가 담당 — 여기는 단순 저장.
pub(crate) async fn update_project_default_write_calendar(
    db: &Db,
    input: &SetProjectDefaultWriteCalendarInput,
) -> Result<Project, AppError> {
    let calendar_id = input
        .calendar_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    sqlx::query_as::<_, Project>(&format!(
        "UPDATE projects SET default_write_calendar_id = ?2, updated_at = datetime('now') \
         WHERE id = ?1 RETURNING {PROJECT_COLS}"
    ))
    .bind(&input.project_id)
    .bind(&calendar_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("projects.not_found", "project not found"))
}

#[tauri::command]
#[specta::specta]
pub async fn set_project_default_write_calendar(
    db: State<'_, Db>,
    input: SetProjectDefaultWriteCalendarInput,
) -> Result<Project, AppError> {
    update_project_default_write_calendar(db.inner(), &input).await
}

/// 입력 DB ID/URL을 표준 dashed UUID로 정규화한다. 빈 문자열/공백/None은 `None`(=바인딩 해제).
/// 형식 오류는 `projects.invalid_notion_db_id`(뷰 링크/garbage 거부 — notion::normalize 위임).
// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용(github_provider_for_cref 등과 동일).
#[allow(clippy::result_large_err)]
fn normalize_opt_notion_db_id(raw: Option<&str>) -> Result<Option<String>, AppError> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => crate::notion::normalize_notion_db_id(s)
            .map(Some)
            .map_err(|e| AppError::validation("projects.invalid_notion_db_id", e)),
    }
}

/// 프로젝트 Notion DB 바인딩(백로그/안건)을 갱신/해제한다 — 생성 후 오타 수정·변경·해제 경로.
/// 새로 바인딩되는(Some) DB는 프로젝트 토큰이 있으면 저장 전 라이브 접근 검증(`probe_database`)을
/// 거쳐 잘못된/접근 불가 DB를 조용히 바인딩하지 않는다. 토큰 미설정이면 형식 검증만으로 저장한다
/// (생성 시점과 동일 — 토큰은 생성 후 연결되므로 라이브 검증이 구조적으로 불가). 알 수 없는 id는
/// `projects.not_found`.
pub(crate) async fn set_project_notion_db_ids_core(
    db: &Db,
    input: &SetProjectNotionDbIdsInput,
) -> Result<Project, AppError> {
    let backlog = normalize_opt_notion_db_id(input.backlog_db_id.as_deref())?;
    let agenda = normalize_opt_notion_db_id(input.agenda_db_id.as_deref())?;

    if backlog.is_some() || agenda.is_some() {
        let cref: String = sqlx::query_scalar("SELECT credential_ref FROM projects WHERE id = ?1")
            .bind(&input.project_id)
            .fetch_optional(db)
            .await?
            .ok_or_else(|| AppError::not_found("projects.not_found", "project not found"))?;
        // 토큰이 있으면 라이브 검증한다. "토큰 없음"(생성 후 아직 연결 전)은 best-effort로 건너뛰되,
        // 진짜 keychain 에러는 삼키지 않고 노출한다 — 잘못된 바인딩을 조용히 저장하지 않기 위해.
        match crate::notion::notion_token_for_cref(&cref) {
            Ok(token) => {
                verify_notion_db_access(&token, backlog.as_deref()).await?;
                verify_notion_db_access(&token, agenda.as_deref()).await?;
            }
            Err(e) if e.code == "notion.token_missing" => {}
            Err(e) => return Err(e),
        }
    }

    sqlx::query_as::<_, Project>(&format!(
        "UPDATE projects SET notion_backlog_db_id = ?2, notion_agenda_db_id = ?3, \
             updated_at = datetime('now') WHERE id = ?1 RETURNING {PROJECT_COLS}"
    ))
    .bind(&input.project_id)
    .bind(&backlog)
    .bind(&agenda)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| AppError::not_found("projects.not_found", "project not found"))
}

/// 바인딩될 Notion DB id에 라이브 접근 검증. **확실히 접근 불가(잘못된 DB id/권한 = Terminal)만 차단**하고,
/// 일시적 실패(네트워크/5xx = Transient)는 통과시켜 blip에 유효 편집(부분 해제 포함)을 막지 않는다.
/// id가 None이면 통과(해제 경로).
// AppError는 큰 Err 변형 — 레포 관용대로 result_large_err 허용.
#[allow(clippy::result_large_err)]
async fn verify_notion_db_access(token: &str, db_id: Option<&str>) -> Result<(), AppError> {
    let Some(db_id) = db_id else {
        return Ok(());
    };
    match crate::notion::probe_database(token, db_id).await {
        Ok(_) => Ok(()),
        // 일시적 실패(네트워크/5xx)만 통과 — blip에 유효 편집을 막지 않는다.
        Err(crate::notion::NotionError::Transient(_)) => Ok(()),
        // 그 외(NotFound/Forbidden/Terminal 등 = 확실히 접근 불가)는 차단.
        Err(e) => Err(AppError::validation(
            "projects.notion_db_inaccessible",
            format!("Notion DB에 접근할 수 없습니다 — DB ID와 토큰 권한을 확인하세요 ({e})"),
        )),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn set_project_notion_db_ids(
    db: State<'_, Db>,
    input: SetProjectNotionDbIdsInput,
) -> Result<Project, AppError> {
    set_project_notion_db_ids_core(db.inner(), &input).await
}

// ── Repos (project별 멀티 레포) ───────────────────────────────────────────────

/// 전체 Repo 목록 (모든 project). 스킬 루트 합성(레포-로컬 에이전트 스킬 dir, P1.5 #4)이 소비한다 —
/// project 경계 없이 enabled Local 레포 전부를 스캔/path-guard 루트로 쓴다. 읽기 전용.
pub(crate) async fn fetch_all_repos(db: &Db) -> Result<Vec<Repo>, sqlx::Error> {
    sqlx::query_as::<_, Repo>(&format!(
        "SELECT {REPO_COLS} FROM repos ORDER BY created_at"
    ))
    .fetch_all(db)
    .await
}

pub(crate) async fn fetch_repos(db: &Db, project_id: &str) -> Result<Vec<Repo>, sqlx::Error> {
    sqlx::query_as::<_, Repo>(&format!(
        "SELECT {REPO_COLS} FROM repos WHERE project_id = ?1 ORDER BY created_at"
    ))
    .bind(project_id)
    .fetch_all(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_repos(db: State<'_, Db>, project_id: String) -> Result<Vec<Repo>, AppError> {
    Ok(fetch_repos(db.inner(), &project_id).await?)
}

pub(crate) async fn insert_repo(db: &Db, input: &CreateRepoInput) -> Result<Repo, sqlx::Error> {
    let default_branch = input
        .default_branch
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("main");
    sqlx::query_as::<_, Repo>(&format!(
        "INSERT INTO repos \
            (id, project_id, provider, remote_url, local_path, default_branch) \
         VALUES (lower(hex(randomblob(16))), ?1, ?2, ?3, ?4, ?5) \
         RETURNING {REPO_COLS}"
    ))
    .bind(&input.project_id)
    .bind(input.provider)
    .bind(&input.remote_url)
    .bind(&input.local_path)
    .bind(default_branch)
    .fetch_one(db)
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_repo(db: State<'_, Db>, input: CreateRepoInput) -> Result<Repo, AppError> {
    // GitHub 레포는 추가 전에 그 프로젝트 토큰으로 접근 가능한지 검증한다 — 없는/권한 없는 레포를
    // 조용히 저장했다가 사용 시점(PR Radar 등)에야 실패하던 문제를 막는다(개인 토큰으로 못 보는
    // org 레포 등). Local 레포·빈 URL은 검증 대상이 아니다.
    if matches!(input.provider, Provider::Github) {
        if let Some(url) = input
            .remote_url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            let cref: String =
                sqlx::query_scalar("SELECT credential_ref FROM projects WHERE id = ?1")
                    .bind(&input.project_id)
                    .fetch_optional(db.inner())
                    .await?
                    .ok_or_else(|| {
                        AppError::not_found("repos.project_not_found", "project not found")
                    })?;
            crate::github::validate_github_repo_access(&cref, url).await?;
        }
    }
    Ok(insert_repo(db.inner(), &input).await?)
}

/// 레포 연결 해제(제거). `repos` 행을 삭제한다 — 잘못 추가한 레포를 되돌리는 유일한 경로
/// (calendar/gmail `disconnect_*` 선례와 대칭). 토큰/keychain은 건드리지 않는다(프로젝트 공유).
/// 알 수 없는 id는 `repos.not_found`(UI 오작동을 조용히 삼키지 않음).
pub(crate) async fn delete_repo_core(db: &Db, repo_id: &str) -> Result<(), AppError> {
    let res = sqlx::query("DELETE FROM repos WHERE id = ?1")
        .bind(repo_id)
        .execute(db)
        .await?;
    if res.rows_affected() == 0 {
        return Err(AppError::not_found("repos.not_found", "repo not found"));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn delete_repo(db: State<'_, Db>, repo_id: String) -> Result<(), AppError> {
    delete_repo_core(db.inner(), &repo_id).await
}

// ── projectId 태깅 / reconcile (Phase 1 kind 힌트 → projectId) ─────────────────

#[tauri::command]
#[specta::specta]
pub async fn reconcile_signal_projects(db: State<'_, Db>) -> Result<u32, AppError> {
    Ok(signal_store::reconcile_signal_projects(db.inner()).await? as u32)
}

/// 신호의 소속 프로젝트를 명시 지정(또는 해제). 메타데이터.
#[tauri::command]
#[specta::specta]
pub async fn set_signal_project(
    db: State<'_, Db>,
    id: String,
    project_id: Option<String>,
) -> Result<WorkSignal, AppError> {
    Ok(signal_store::set_signal_project_tag(db.inner(), &id, project_id.as_deref()).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::shared::test_support::*;
    use crate::commands::signal_store::insert_signal;
    use crate::models::{CreateSignalInput, Kind};
    use crate::models::{ProjectKind, Provider};

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

    #[tokio::test]
    async fn delete_project_removes_project_and_preserves_local_history() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("임시 프로젝트", ProjectKind::Work))
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
            },
        )
        .await
        .unwrap();
        let sig = insert_signal(
            &db,
            &CreateSignalInput {
                title: "삭제 후에도 남을 완료 기록".into(),
                kind: Some(Kind::Work),
                project_id: Some(proj.id.clone()),
            },
        )
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO routines (id, project_id, title, freq, kind, area, active) \
             VALUES ('rt-delete-project', ?1, '삭제 후에도 남을 루틴', 'daily', 'work', 'work', 1)",
        )
        .bind(&proj.id)
        .execute(&db)
        .await
        .unwrap();

        delete_project_core(&db, &proj.id).await.unwrap();

        assert!(
            fetch_project(&db, &proj.id).await.unwrap().is_none(),
            "project row is deleted"
        );
        assert!(
            fetch_repos(&db, &proj.id).await.unwrap().is_empty(),
            "repos cascade away with project"
        );
        let repo_count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM repos WHERE id = ?1")
            .bind(repo.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(repo_count.0, 0);
        let signal_project: (Option<String>,) =
            sqlx::query_as("SELECT project_id FROM signals WHERE id = ?1")
                .bind(sig.id)
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(signal_project.0, None, "signals are kept as local history");
        let routine_project: (Option<String>,) =
            sqlx::query_as("SELECT project_id FROM routines WHERE id = 'rt-delete-project'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(
            routine_project.0, None,
            "routines are kept as local history"
        );

        let miss = delete_project_core(&db, &proj.id).await.unwrap_err();
        assert_eq!(miss.code, "projects.not_found");
    }

    #[tokio::test]
    async fn project_calendar_color_is_validated_and_resettable() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();

        let updated = update_project_calendar_color(
            &db,
            &SetProjectCalendarColorInput {
                project_id: proj.id.clone(),
                color: Some("2d6cdf".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(updated.calendar_color.as_deref(), Some("#2D6CDF"));

        let invalid = update_project_calendar_color(
            &db,
            &SetProjectCalendarColorInput {
                project_id: proj.id.clone(),
                color: Some("not-a-color".into()),
            },
        )
        .await;
        assert!(invalid.is_err());

        let reset = update_project_calendar_color(
            &db,
            &SetProjectCalendarColorInput {
                project_id: proj.id,
                color: None,
            },
        )
        .await
        .unwrap();
        assert!(reset.calendar_color.is_none());
    }

    /// 이름/kind per-field 편집: trim·공백거부·전환·미존재 id + 두 편집의 독립성(lost-update 방지).
    #[tokio::test]
    async fn set_project_name_and_kind_are_independent() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("Mirroless 오타", ProjectKind::Work))
            .await
            .unwrap();

        // 1) 이름 변경(trim) — kind는 건드리지 않는다.
        let renamed = set_project_name_core(&db, &proj.id, "  Mirrorless  ")
            .await
            .unwrap();
        assert_eq!(renamed.name, "Mirrorless");
        assert!(matches!(renamed.kind, ProjectKind::Work), "kind 불변");
        assert_eq!(renamed.id, proj.id, "id 불변");

        // 2) kind 전환(업무→개인) — 이름은 건드리지 않는다.
        let switched = set_project_kind_core(&db, &proj.id, ProjectKind::Personal)
            .await
            .unwrap();
        assert!(matches!(switched.kind, ProjectKind::Personal));
        assert_eq!(switched.name, "Mirrorless", "이름 불변(독립 컬럼)");

        // 3) 공백-only 이름 거부 — kind 변경은 보존된다(컬럼 분리).
        let blank = set_project_name_core(&db, &proj.id, "   ")
            .await
            .unwrap_err();
        assert_eq!(blank.code, "projects.invalid_input");
        let after = fetch_projects(&db).await.unwrap();
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].name, "Mirrorless");
        assert!(matches!(after[0].kind, ProjectKind::Personal));

        // 4) 알 수 없는 id → 두 커맨드 모두 projects.not_found.
        let miss_name = set_project_name_core(&db, "does-not-exist", "x")
            .await
            .unwrap_err();
        assert_eq!(miss_name.code, "projects.not_found");
        let miss_kind = set_project_kind_core(&db, "does-not-exist", ProjectKind::Work)
            .await
            .unwrap_err();
        assert_eq!(miss_kind.code, "projects.not_found");
    }

    #[tokio::test]
    async fn project_default_write_calendar_is_trimmed_and_resettable() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();

        // 1) Normal set.
        let updated = update_project_default_write_calendar(
            &db,
            &SetProjectDefaultWriteCalendarInput {
                project_id: proj.id.clone(),
                calendar_id: Some("cal_abc".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            updated.default_write_calendar_id.as_deref(),
            Some("cal_abc")
        );

        // 2) Whitespace-only input → 정규화 결과 None.
        let whitespace = update_project_default_write_calendar(
            &db,
            &SetProjectDefaultWriteCalendarInput {
                project_id: proj.id.clone(),
                calendar_id: Some("   ".into()),
            },
        )
        .await
        .unwrap();
        assert!(whitespace.default_write_calendar_id.is_none());

        // 다시 set 후 None으로 명시 리셋.
        update_project_default_write_calendar(
            &db,
            &SetProjectDefaultWriteCalendarInput {
                project_id: proj.id.clone(),
                calendar_id: Some("cal_xyz".into()),
            },
        )
        .await
        .unwrap();

        // 3) 명시 None reset.
        let reset = update_project_default_write_calendar(
            &db,
            &SetProjectDefaultWriteCalendarInput {
                project_id: proj.id.clone(),
                calendar_id: None,
            },
        )
        .await
        .unwrap();
        assert!(reset.default_write_calendar_id.is_none());

        // 4) Unknown project id → projects.not_found.
        let missing = update_project_default_write_calendar(
            &db,
            &SetProjectDefaultWriteCalendarInput {
                project_id: "does-not-exist".into(),
                calendar_id: Some("cal_abc".into()),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(missing.code, "projects.not_found");
    }

    #[test]
    fn readable_text_color_picks_high_contrast_foreground() {
        assert_eq!(readable_text_color("#111827"), "#FFFFFF");
        assert_eq!(readable_text_color("#F8FAFC"), "#212121");
        assert!(default_project_calendar_color("project-a").starts_with('#'));
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

    /// 레포 제거: 행이 사라지고, 이미 없는 id는 repos.not_found.
    #[tokio::test]
    async fn delete_repo_removes_row_and_reports_missing() {
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
            },
        )
        .await
        .unwrap();
        assert_eq!(fetch_repos(&db, &proj.id).await.unwrap().len(), 1);

        delete_repo_core(&db, &repo.id).await.unwrap();
        assert!(fetch_repos(&db, &proj.id).await.unwrap().is_empty());

        // 이미 없는 id(또는 오타) → not_found(조용히 성공하지 않음).
        let miss = delete_repo_core(&db, &repo.id).await.unwrap_err();
        assert_eq!(miss.code, "repos.not_found");
    }

    /// Notion DB 바인딩: 정규화 저장 / 형식 거부 / 빈 값=해제 / 미존재 id.
    /// (테스트 환경은 keychain 토큰이 없어 라이브 probe는 건너뛴다 — 형식·해제·UPDATE 경로만 검증.)
    #[tokio::test]
    async fn set_notion_db_ids_normalizes_clears_and_rejects_bad_format() {
        let db = fresh_db().await;
        let proj = insert_project(&db, &project_input("Mirrorless", ProjectKind::Work))
            .await
            .unwrap();

        // raw 32-hex → dashed UUID(36자)로 정규화 저장. agenda는 미설정.
        let raw = "0123456789abcdef0123456789abcdef";
        let updated = set_project_notion_db_ids_core(
            &db,
            &SetProjectNotionDbIdsInput {
                project_id: proj.id.clone(),
                backlog_db_id: Some(raw.into()),
                agenda_db_id: None,
            },
        )
        .await
        .unwrap();
        let stored = updated.notion_backlog_db_id.as_deref().unwrap();
        assert_eq!(stored.len(), 36, "dashed UUID");
        assert!(stored.contains('-'));
        assert!(updated.notion_agenda_db_id.is_none());

        // 잘못된 형식(뷰 링크/garbage) → validation 거부.
        let bad = set_project_notion_db_ids_core(
            &db,
            &SetProjectNotionDbIdsInput {
                project_id: proj.id.clone(),
                backlog_db_id: Some("12345".into()),
                agenda_db_id: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(bad.code, "projects.invalid_notion_db_id");

        // 빈/공백 문자열 → 바인딩 해제(NULL). (연결 해제 경로)
        let cleared = set_project_notion_db_ids_core(
            &db,
            &SetProjectNotionDbIdsInput {
                project_id: proj.id.clone(),
                backlog_db_id: Some("   ".into()),
                agenda_db_id: None,
            },
        )
        .await
        .unwrap();
        assert!(cleared.notion_backlog_db_id.is_none(), "빈 값=해제");

        // 알 수 없는 id(둘 다 None이면 검증 skip → UPDATE가 not_found).
        let miss = set_project_notion_db_ids_core(
            &db,
            &SetProjectNotionDbIdsInput {
                project_id: "does-not-exist".into(),
                backlog_db_id: None,
                agenda_db_id: None,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(miss.code, "projects.not_found");
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

        let n = signal_store::reconcile_signal_projects(&db).await.unwrap();
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
}
