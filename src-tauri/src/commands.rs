//! Tauri IPC commands. specta가 이 시그니처에서 TS 바인딩을 생성한다.
//! INVARIANT: Notion/GitHub 등 외부 호출은 Rust에 둔다(토큰 렌더러 노출 금지).

use tauri::State;

use crate::db::Db;
use crate::models::Project;

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
