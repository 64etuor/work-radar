//! SQLite 풀 + 마이그레이션. 이 DB가 매트릭스 상태·신호·승격·잡의 SSOT.
//! 스키마 변경은 `migrations/`의 새 파일로만 (임의 ALTER 금지 — INVARIANT).

use std::path::Path;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;

/// 앱 전역에서 공유되는 DB 핸들 (Tauri managed state).
pub type Db = SqlitePool;

/// DB 파일을 열고(없으면 생성) 마이그레이션을 적용한다.
pub async fn init_db(db_path: &Path) -> Result<Db, sqlx::Error> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(opts)
        .await?;

    // 컴파일 타임에 ./migrations 의 파일들을 임베드해 적용한다.
    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_db_path() -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("work-radar-test-{nanos}.db"))
    }

    #[tokio::test]
    async fn migrations_create_six_tables_and_fts() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        // 6개 핵심 테이블 존재
        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN \
             ('projects','repos','signals','promotions','agent_runs','acceptances') ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .expect("query tables failed");
        assert_eq!(tables.len(), 6, "expected 6 core tables, got {tables:?}");

        // FTS5 가상 테이블 존재
        let fts: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE name='signals_fts'")
                .fetch_all(&pool)
                .await
                .expect("query fts failed");
        assert_eq!(fts.len(), 1, "expected signals_fts virtual table");

        // FTS5 실제 동작 검증: insert → match
        sqlx::query(
            "INSERT INTO signals (id, title, body, source, type) \
             VALUES ('s1', 'deploy radar', 'check the pr pipeline', 'braindump', 'thought')",
        )
        .execute(&pool)
        .await
        .expect("insert signal failed");

        let hits: Vec<(String,)> =
            sqlx::query_as("SELECT title FROM signals_fts WHERE signals_fts MATCH 'pipeline'")
                .fetch_all(&pool)
                .await
                .expect("fts match failed");
        assert_eq!(hits.len(), 1, "FTS5 should match the inserted signal");

        pool.close().await;
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn list_projects_returns_empty_on_fresh_db() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        let projects = crate::commands::fetch_projects(&pool)
            .await
            .expect("fetch_projects failed");
        assert!(projects.is_empty(), "fresh DB should have no projects");

        pool.close().await;
        std::fs::remove_file(&path).ok();
    }
}
