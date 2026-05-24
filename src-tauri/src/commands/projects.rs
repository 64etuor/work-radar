use tauri::State;

use crate::commands::signal_store;
use crate::db::Db;
use crate::error::AppError;
use crate::models::{CreateProjectInput, CreateRepoInput, Project, Repo, WorkSignal};
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

/// Project SELECT/RETURNING 공통 컬럼.
const PROJECT_COLS: &str = "id, name, kind, notion_backlog_db_id, notion_agenda_db_id, \
     google_calendar_ids, credential_ref, \
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

// ── Repos (project별 멀티 레포) ───────────────────────────────────────────────

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
    Ok(insert_repo(db.inner(), &input).await?)
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
