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
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 고유한 임시 DB 경로. nanos만으로는 coarse 클록 + 병렬 테스트에서 충돌(같은 파일
    /// 공유 → 마이그레이션 레이스)할 수 있어 per-call 원자 카운터로 유일성을 보장한다.
    fn temp_db_path() -> std::path::PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("work-radar-test-{nanos}-{seq}.db"))
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

    /// Phase 1 마이그레이션(0002): signals 확장 컬럼 + routines/routine_checks.
    #[tokio::test]
    async fn migration_0002_adds_capture_board_schema() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        // signals 새 컬럼 6개 존재 (PRAGMA table_info)
        let cols: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM pragma_table_info('signals') WHERE name IN \
             ('kind','area','suggested_area','today_for_date','today_done_at','today_rank') ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .expect("query signals columns failed");
        assert_eq!(
            cols.len(),
            6,
            "expected 6 new signals columns from 0002, got {cols:?}"
        );

        // routines + routine_checks 테이블 존재
        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN \
             ('routines','routine_checks') ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .expect("query routine tables failed");
        assert_eq!(tables.len(), 2, "expected routines + routine_checks");

        // 새 컬럼에 실제 write/read 동작 (Today 멤버십)
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, kind, today_for_date, today_rank) \
             VALUES ('s2', 'today item', 'braindump', 'thought', 'work', '2026-05-21', 0)",
        )
        .execute(&pool)
        .await
        .expect("insert with new columns failed");
        let kind: (String,) = sqlx::query_as("SELECT kind FROM signals WHERE id='s2'")
            .fetch_one(&pool)
            .await
            .expect("read kind failed");
        assert_eq!(kind.0, "work");

        // routine + 날짜별 체크 라운드트립 (UNIQUE(routine_id, date))
        sqlx::query(
            "INSERT INTO routines (id, title, freq, weekdays) \
             VALUES ('r1', '아침 운동', 'weekly', '[\"wed\",\"fri\"]')",
        )
        .execute(&pool)
        .await
        .expect("insert routine failed");
        sqlx::query(
            "INSERT INTO routine_checks (id, routine_id, date) VALUES ('rc1','r1','2026-05-21')",
        )
        .execute(&pool)
        .await
        .expect("insert routine_check failed");
        let dup = sqlx::query(
            "INSERT INTO routine_checks (id, routine_id, date) VALUES ('rc2','r1','2026-05-21')",
        )
        .execute(&pool)
        .await;
        assert!(
            dup.is_err(),
            "UNIQUE(routine_id,date) should reject same-day duplicate"
        );

        pool.close().await;
        std::fs::remove_file(&path).ok();
    }

    /// Phase 4 마이그레이션(0004): pr_self_checks 테이블 + UNIQUE(repo_full_name, pr_number).
    #[tokio::test]
    async fn migration_0004_adds_pr_self_checks() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = 'pr_self_checks'",
        )
        .fetch_all(&pool)
        .await
        .expect("query pr_self_checks failed");
        assert_eq!(tables.len(), 1, "expected pr_self_checks table from 0004");

        sqlx::query(
            "INSERT INTO pr_self_checks (id, repo_full_name, pr_number) VALUES ('p1','o/r',42)",
        )
        .execute(&pool)
        .await
        .expect("insert self-check failed");
        let dup = sqlx::query(
            "INSERT INTO pr_self_checks (id, repo_full_name, pr_number) VALUES ('p2','o/r',42)",
        )
        .execute(&pool)
        .await;
        assert!(
            dup.is_err(),
            "UNIQUE(repo_full_name,pr_number) should reject duplicate"
        );

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
