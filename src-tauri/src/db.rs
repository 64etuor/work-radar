//! SQLite 풀 + 마이그레이션. 이 DB가 매트릭스 상태·신호·승격·잡의 SSOT.
//! 스키마 변경은 `migrations/`의 새 파일로만 (임의 ALTER 금지 — INVARIANT).

use std::path::Path;
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};
use sqlx::SqlitePool;

/// 앱 전역에서 공유되는 DB 핸들 (Tauri managed state).
pub type Db = SqlitePool;

/// DB 파일을 열고(없으면 생성) 마이그레이션을 적용한다.
pub async fn init_db(db_path: &Path) -> Result<Db, sqlx::Error> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    // WAL + busy_timeout: 풀(max 5)과 30초 스케줄러 백그라운드 writer가 동시에 쓰므로
    // 기본 rollback 저널이면 writer 경합 시 즉시 SQLITE_BUSY가 난다. WAL로 reader/writer를
    // 분리하고, busy_timeout으로 짧은 writer 경합은 대기로 흡수한다. synchronous=Normal은
    // WAL에서 안전하며(크래시 시 마지막 트랜잭션만 손실 가능) fsync 비용을 줄인다.
    let opts = SqliteConnectOptions::new()
        .filename(db_path)
        .create_if_missing(true)
        .foreign_keys(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_secs(5));

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

    /// init_db가 WAL + busy_timeout을 실제로 적용하는지 — 동시 writer SQLITE_BUSY 가드(아키텍처 권고).
    #[tokio::test]
    async fn init_db_enables_wal_and_busy_timeout() {
        let pool = init_db(&temp_db_path()).await.expect("init_db failed");
        let (journal_mode,): (String,) = sqlx::query_as("PRAGMA journal_mode")
            .fetch_one(&pool)
            .await
            .expect("journal_mode query failed");
        assert_eq!(journal_mode.to_lowercase(), "wal");
        let (busy_timeout,): (i64,) = sqlx::query_as("PRAGMA busy_timeout")
            .fetch_one(&pool)
            .await
            .expect("busy_timeout query failed");
        assert_eq!(busy_timeout, 5000);
    }

    /// Phase 16(0011) routines rebuild가 routine_checks 완료 이력을 **보존**하는지 — 데이터 손실 가드.
    /// 충실 재현: 0001~0010 적용 → routine + check seed → 0011을 **트랜잭션 안에서** 실행
    /// (sqlx 마이그레이터와 동일 — `PRAGMA foreign_keys=OFF`가 no-op이라 FK가 켜진 채 rebuild된다).
    /// FK-안전 순서가 아니면 `DROP TABLE routines`의 cascade가 routine_checks를 지운다.
    #[tokio::test]
    async fn migration_0011_preserves_routine_checks_under_transaction() {
        let path = temp_db_path();
        let opts = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .foreign_keys(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("connect failed");

        let base = concat!(env!("CARGO_MANIFEST_DIR"), "/migrations");
        for f in [
            "0001_init.sql",
            "0002_capture_board.sql",
            "0003_promotion_unique.sql",
            "0004_pr_self_check.sql",
            "0005_notion_done_statuses.sql",
            "0006_google_calendar_ids.sql",
            "0007_debt_snapshots.sql",
            "0008_remove_mismatch.sql",
            "0009_scheduled_notifications.sql",
            "0010_retro_tags.sql",
        ] {
            let sql = std::fs::read_to_string(format!("{base}/{f}")).unwrap();
            sqlx::raw_sql(&sql)
                .execute(&pool)
                .await
                .unwrap_or_else(|e| panic!("apply {f}: {e}"));
        }

        // 완료 이력을 가진 루틴 seed.
        sqlx::query("INSERT INTO routines (id, title, freq, active, created_at) VALUES ('r1','run','daily',1,datetime('now'))")
            .execute(&pool).await.expect("seed routine");
        sqlx::query(
            "INSERT INTO routine_checks (id, routine_id, date) VALUES ('rc1','r1','2026-05-20')",
        )
        .execute(&pool)
        .await
        .expect("seed routine_check");

        // 0011을 트랜잭션 안에서 실행(마이그레이터 충실 재현 — PRAGMA OFF no-op).
        let sql11 = std::fs::read_to_string(format!("{base}/0011_routines_phase16.sql")).unwrap();
        let mut tx = pool.begin().await.unwrap();
        sqlx::raw_sql(&sql11)
            .execute(&mut *tx)
            .await
            .expect("apply 0011 in tx");
        tx.commit().await.unwrap();

        // routine_checks 완료 이력이 cascade로 지워지지 않고 보존되어야 한다.
        let (checks,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM routine_checks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            checks, 1,
            "0011 rebuild가 routine_checks 완료 이력을 보존해야 한다 (cascade 금지)"
        );
        let (routines,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM routines")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(routines, 1, "routines 행 보존");

        // 확장된 freq CHECK + 신규 컬럼이 동작.
        sqlx::query(
            "INSERT INTO routines (id, title, freq, anchor_date, rank, time_of_day, reminder_offset_min, active, created_at) \
             VALUES ('r2','m','monthly','2026-05-01',0,'09:00',30,1,datetime('now'))",
        )
        .execute(&pool)
        .await
        .expect("biweekly/monthly freq + 신규 컬럼 insert 가능해야 함");

        let _ = std::fs::remove_file(&path);
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

    /// Phase 10b 마이그레이션(0006): projects.google_calendar_ids 컬럼 + JSON write/read.
    #[tokio::test]
    async fn migration_0006_adds_google_calendar_ids() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        let cols: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM pragma_table_info('projects') WHERE name = 'google_calendar_ids'",
        )
        .fetch_all(&pool)
        .await
        .expect("query projects columns failed");
        assert_eq!(
            cols.len(),
            1,
            "expected google_calendar_ids column from 0006"
        );

        // 선택 목록 JSON write/read 라운드트립 (선택 목록은 로컬 SQLite SSOT — INVARIANT #7).
        sqlx::query(
            "INSERT INTO projects (id, name, kind, credential_ref, google_calendar_ids) \
             VALUES ('p-cal', '업무', 'work', 'cref-cal', '[{\"id\":\"primary\",\"summary\":\"내 캘린더\"}]')",
        )
        .execute(&pool)
        .await
        .expect("insert project with calendars failed");
        let ids: (Option<String>,) =
            sqlx::query_as("SELECT google_calendar_ids FROM projects WHERE id='p-cal'")
                .fetch_one(&pool)
                .await
                .expect("read google_calendar_ids failed");
        assert_eq!(
            ids.0.as_deref(),
            Some("[{\"id\":\"primary\",\"summary\":\"내 캘린더\"}]")
        );

        pool.close().await;
        std::fs::remove_file(&path).ok();
    }

    /// Phase 13 마이그레이션(0009): scheduled_notifications 테이블 + due-query 인덱스 + write/read.
    #[tokio::test]
    async fn migration_0009_adds_scheduled_notifications() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = 'scheduled_notifications'",
        )
        .fetch_all(&pool)
        .await
        .expect("query scheduled_notifications failed");
        assert_eq!(
            tables.len(),
            1,
            "expected scheduled_notifications table from 0009"
        );

        // fired_at NULL 기본값으로 INSERT → due-query가 미발사로 본다.
        sqlx::query(
            "INSERT INTO scheduled_notifications (id, fire_at, title, source) \
             VALUES ('sn1', '2026-05-22 09:00:00', '루틴 알림', 'routine')",
        )
        .execute(&pool)
        .await
        .expect("insert scheduled_notification failed");
        let unfired: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM scheduled_notifications WHERE fired_at IS NULL")
                .fetch_one(&pool)
                .await
                .expect("count unfired failed");
        assert_eq!(unfired.0, 1, "새 행은 미발사(fired_at NULL)로 진입");

        pool.close().await;
        std::fs::remove_file(&path).ok();
    }

    /// Phase 20 마이그레이션(0012): hermes_bridge/hermes_messages 테이블 + offset 전진 + update dedup.
    #[tokio::test]
    async fn migration_0012_adds_hermes_bridge() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN \
             ('hermes_bridge','hermes_messages') ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .expect("query hermes tables failed");
        assert_eq!(
            tables.len(),
            2,
            "expected hermes_bridge + hermes_messages from 0012"
        );

        // 단일 브리지 행 upsert + offset 전진 라운드트립.
        sqlx::query("INSERT INTO hermes_bridge (id, chat_id) VALUES ('singleton', '12345')")
            .execute(&pool)
            .await
            .expect("insert hermes_bridge failed");
        sqlx::query("UPDATE hermes_bridge SET last_offset = 42 WHERE id = 'singleton'")
            .execute(&pool)
            .await
            .expect("advance offset failed");
        let (chat, offset): (String, i64) =
            sqlx::query_as("SELECT chat_id, last_offset FROM hermes_bridge WHERE id='singleton'")
                .fetch_one(&pool)
                .await
                .expect("read bridge failed");
        assert_eq!(chat, "12345");
        assert_eq!(offset, 42);

        // 수신 메시지 update_id UNIQUE: 같은 update를 두 번 기록하면 두 번째는 거부(멱등 fetch).
        sqlx::query(
            "INSERT INTO hermes_messages (id, direction, text, update_id) VALUES ('m1','received','hi',7)",
        )
        .execute(&pool)
        .await
        .expect("insert received failed");
        let dup = sqlx::query(
            "INSERT INTO hermes_messages (id, direction, text, update_id) VALUES ('m2','received','hi again',7)",
        )
        .execute(&pool)
        .await;
        assert!(dup.is_err(), "UNIQUE(update_id)로 중복 update 거부");

        // 송신(update_id NULL)은 partial UNIQUE에서 자유 — 여러 건 가능.
        for id in ["s1", "s2"] {
            sqlx::query(
                "INSERT INTO hermes_messages (id, direction, text) VALUES (?1,'sent','cmd')",
            )
            .bind(id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("insert sent {id}: {e}"));
        }

        pool.close().await;
        std::fs::remove_file(&path).ok();
    }

    /// Phase 20 마이그레이션(0013): skills 테이블 + binding UNIQUE + kind CHECK + 시드/폴백 라운드트립.
    #[tokio::test]
    async fn migration_0013_adds_skills_registry() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        let tables: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' AND name = 'skills'")
                .fetch_all(&pool)
                .await
                .expect("query skills table failed");
        assert_eq!(tables.len(), 1, "expected skills table from 0013");

        // 인앱 프롬프트 시드는 lib.rs/커맨드가 하지만, 마이그레이션 단독은 빈 표여야 한다(시드는 별도).
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM skills")
            .fetch_one(&pool)
            .await
            .expect("count skills failed");
        assert_eq!(n, 0, "마이그레이션 단독은 빈 레지스트리(시드는 앱 시작 시)");

        // kind CHECK: 허용 밖 kind는 거부.
        let bad_kind = sqlx::query("INSERT INTO skills (id, name, kind) VALUES ('k1','x','bogus')")
            .execute(&pool)
            .await;
        assert!(bad_kind.is_err(), "kind CHECK가 허용 밖 값을 거부해야 한다");

        // binding UNIQUE(부분 인덱스): 같은 binding 두 인앱 행은 거부, binding NULL(external)은 자유.
        sqlx::query(
            "INSERT INTO skills (id, name, kind, prompt, binding) \
             VALUES ('k_enrich','enrich','in_app_prompt','p','enrich')",
        )
        .execute(&pool)
        .await
        .expect("insert in_app skill failed");
        let dup = sqlx::query(
            "INSERT INTO skills (id, name, kind, prompt, binding) \
             VALUES ('k_enrich2','enrich2','in_app_prompt','p2','enrich')",
        )
        .execute(&pool)
        .await;
        assert!(
            dup.is_err(),
            "binding UNIQUE가 같은 잡 중복 바인딩을 거부해야 한다"
        );

        // binding NULL(external)은 여러 건 가능(partial UNIQUE에서 자유).
        for id in ["e1", "e2"] {
            sqlx::query(
                "INSERT INTO skills (id, name, kind, source_path) \
                 VALUES (?1, 'ext', 'external', '/p/SKILL.md')",
            )
            .bind(id)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("insert external {id}: {e}"));
        }

        pool.close().await;
        std::fs::remove_file(&path).ok();
    }

    /// Phase 18 마이그레이션(0014): app_config key-value 테이블 + upsert(ON CONFLICT) 라운드트립.
    #[tokio::test]
    async fn migration_0014_adds_app_config() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = 'app_config'",
        )
        .fetch_all(&pool)
        .await
        .expect("query app_config table failed");
        assert_eq!(tables.len(), 1, "expected app_config table from 0014");

        // upsert: 같은 key 두 번 → 마지막 값으로 갱신(중복 행 아님).
        for v in ["Ctrl+Space", "Cmd+Shift+K"] {
            sqlx::query(
                "INSERT INTO app_config (key, value) VALUES ('nav.global_hotkey', ?1) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .bind(v)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("upsert app_config {v}: {e}"));
        }
        let (val,): (String,) =
            sqlx::query_as("SELECT value FROM app_config WHERE key='nav.global_hotkey'")
                .fetch_one(&pool)
                .await
                .expect("read app_config failed");
        assert_eq!(val, "Cmd+Shift+K", "upsert가 마지막 값으로 갱신해야 한다");

        pool.close().await;
        std::fs::remove_file(&path).ok();
    }

    /// Phase 17 마이그레이션(0010): signals.impact_high/regret 컬럼 + bool(0/1) write/read.
    #[tokio::test]
    async fn migration_0010_adds_retro_tags() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        let cols: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM pragma_table_info('signals') WHERE name IN ('impact_high','regret') ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .expect("query signals columns failed");
        assert_eq!(
            cols.len(),
            2,
            "expected impact_high + regret from 0010, got {cols:?}"
        );

        // 기존 행은 NULL(미태깅)로 진입, 사람이 1/0으로 태깅한다(INVARIANT #1).
        sqlx::query(
            "INSERT INTO signals (id, title, source, type, today_done_at, impact_high) \
             VALUES ('rt1', '회고 항목', 'braindump', 'thought', '2026-05-22', 1)",
        )
        .execute(&pool)
        .await
        .expect("insert with retro tag failed");
        let (impact, regret): (Option<i64>, Option<i64>) =
            sqlx::query_as("SELECT impact_high, regret FROM signals WHERE id='rt1'")
                .fetch_one(&pool)
                .await
                .expect("read retro tags failed");
        assert_eq!(impact, Some(1), "고임팩트 태그 1");
        assert_eq!(regret, None, "미태깅은 NULL");

        pool.close().await;
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn migration_0024_adds_inbox_items() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        let tables: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM sqlite_master WHERE type='table' AND name = 'inbox_items'",
        )
        .fetch_all(&pool)
        .await
        .expect("query inbox table failed");
        assert_eq!(tables.len(), 1, "expected inbox_items table from 0024");

        sqlx::query(
            "INSERT INTO inbox_items (id, source, source_id, title, severity, priority) \
             VALUES ('i1', 'test', 'same', 'Alert', 'warning', 'high')",
        )
        .execute(&pool)
        .await
        .expect("insert inbox item failed");
        let duplicate = sqlx::query(
            "INSERT INTO inbox_items (id, source, source_id, title) \
             VALUES ('i2', 'test', 'same', 'Duplicate')",
        )
        .execute(&pool)
        .await;
        assert!(
            duplicate.is_err(),
            "source/source_id must dedup inbox alerts"
        );

        pool.close().await;
        std::fs::remove_file(&path).ok();
    }

    #[tokio::test]
    async fn migration_0025_adds_agent_recovery_columns() {
        let path = temp_db_path();
        let pool = init_db(&path).await.expect("init_db failed");

        let cols: Vec<(String,)> = sqlx::query_as(
            "SELECT name FROM pragma_table_info('agent_runs') \
             WHERE name IN ('heartbeat_at','recovery_count','lock_path') ORDER BY name",
        )
        .fetch_all(&pool)
        .await
        .expect("query agent recovery columns failed");
        assert_eq!(
            cols,
            vec![
                ("heartbeat_at".to_string(),),
                ("lock_path".to_string(),),
                ("recovery_count".to_string(),),
            ]
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
