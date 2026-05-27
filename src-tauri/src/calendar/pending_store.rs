//! pending_calendar_writes 큐 store (Today×Timeline PR 2).
//!
//! 큐 UPSERT 머지 + 800ms 디바운스 + backoff [1s, 3s, 9s] + 3회 terminal.
//! INVARIANT #5: bounded retry only — 3회 후엔 `last_error` 보존하고 워커가 더 시도하지 않는다.
//! `payload_json.staged=true`인 행은 워커가 `fetch_due_writes` 단계에서 skip
//! (cross-cal 변경의 명시 Acceptance 게이트, spec §6.2).

use chrono::{DateTime, Duration, Utc};
use sqlx::SqlitePool;

/// SQLite `datetime('now')`와 lexicographically 비교 가능한 UTC 문자열(`YYYY-MM-DD HH:MM:SS`).
/// chrono의 RFC3339(`...T...+00:00`)는 SQLite 형식과 비교가 안 맞아 due 판정이 실패한다.
pub(crate) fn format_sqlite_datetime(dt: DateTime<Utc>) -> String {
    dt.format("%Y-%m-%d %H:%M:%S").to_string()
}

use crate::models::PendingWrite;

/// 같은 `(target_kind, target_id, kind)`의 후속 write는 마지막 페이로드로 머지된다(spec §6).
/// `debounce_ms` 후가 next_attempt_at — 디바운스 윈도우 안의 다중 호출이 합쳐진다.
/// 머지될 때 attempts/last_error는 리셋(새 의도 = 깨끗한 1차 시도).
pub async fn upsert_write(
    pool: &SqlitePool,
    kind: &str,
    target_kind: &str,
    target_id: &str,
    calendar_id: &str,
    event_id: Option<&str>,
    payload_json: &str,
    debounce_ms: i64,
) -> sqlx::Result<i64> {
    let next = format_sqlite_datetime(Utc::now() + Duration::milliseconds(debounce_ms));
    let row: (i64,) = sqlx::query_as(
        r#"INSERT INTO pending_calendar_writes
             (kind, target_kind, target_id, calendar_id, event_id, payload_json, next_attempt_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(target_kind, target_id, kind) DO UPDATE SET
             calendar_id     = excluded.calendar_id,
             event_id        = excluded.event_id,
             payload_json    = excluded.payload_json,
             next_attempt_at = excluded.next_attempt_at,
             attempts        = 0,
             last_error      = NULL
           RETURNING id"#,
    )
    .bind(kind)
    .bind(target_kind)
    .bind(target_id)
    .bind(calendar_id)
    .bind(event_id)
    .bind(payload_json)
    .bind(next)
    .fetch_one(pool)
    .await?;
    Ok(row.0)
}

/// backoff 스케줄(spec §6.1): [1s, 3s, 9s]. 4회차 이상도 9s 캡(워커가 is_terminal_attempt로 중단).
pub fn backoff_ms_for_attempt(attempt: i32) -> i64 {
    match attempt {
        0 => 1_000,
        1 => 3_000,
        _ => 9_000,
    }
}

/// 3회 시도 후 더 이상 시도하지 않는다(spec §6.1, INVARIANT #5).
/// 워커는 record_failure로 attempts를 올린 뒤 그 값이 terminal이면 CalendarSyncFailed emit.
pub fn is_terminal_attempt(attempt: i32) -> bool {
    attempt >= 3
}

/// 워커가 한 사이클에 처리할 due 행 fetch. `staged=true` payload는 명시 commit 전엔 skip한다
/// (spec §6.2: cross-cal 변경 = 사람 Acceptance). 한 사이클 32개 캡으로 burst 격리.
pub async fn fetch_due_writes(pool: &SqlitePool) -> sqlx::Result<Vec<PendingWrite>> {
    sqlx::query_as::<_, PendingWrite>(
        r#"SELECT id, kind, target_kind, target_id, calendar_id, event_id,
                  payload_json, attempts, next_attempt_at, last_error, created_at
           FROM pending_calendar_writes
           WHERE next_attempt_at <= datetime('now')
             AND (json_extract(payload_json, '$.staged') IS NULL
                  OR json_extract(payload_json, '$.staged') = 0)
           ORDER BY next_attempt_at ASC
           LIMIT 32"#,
    )
    .fetch_all(pool)
    .await
}

/// 시도 실패 기록 — attempts += 1, next_attempt_at = now + backoff(prev_attempts), last_error 보존.
/// 워커가 이 함수 호출 후 `is_terminal_attempt`로 종료 여부 판단(이 함수는 큐를 지우지 않는다).
pub async fn record_failure(pool: &SqlitePool, id: i64, err: &str) -> sqlx::Result<()> {
    let row: (i32,) = sqlx::query_as("SELECT attempts FROM pending_calendar_writes WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;
    let backoff = backoff_ms_for_attempt(row.0);
    let next_attempts = row.0 + 1;
    let next_at = format_sqlite_datetime(Utc::now() + Duration::milliseconds(backoff));
    sqlx::query(
        "UPDATE pending_calendar_writes
         SET attempts = ?, next_attempt_at = ?, last_error = ?
         WHERE id = ?",
    )
    .bind(next_attempts)
    .bind(next_at)
    .bind(err)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// 성공/취소/IPC commit 후 큐에서 제거.
pub async fn delete_write(pool: &SqlitePool, id: i64) -> sqlx::Result<()> {
    sqlx::query("DELETE FROM pending_calendar_writes WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> sqlx::SqlitePool {
        let p = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&p).await.unwrap();
        p
    }

    /// Task 2: 같은 target+kind 후속 write는 머지(UNIQUE) — 최신 payload가 이긴다.
    #[tokio::test]
    async fn upsert_merges_same_target_kind() {
        let p = pool().await;
        upsert_write(
            &p,
            "patch",
            "signal",
            "s1",
            "cal1",
            None,
            r#"{"start":"T1"}"#,
            800,
        )
        .await
        .unwrap();
        upsert_write(
            &p,
            "patch",
            "signal",
            "s1",
            "cal1",
            None,
            r#"{"start":"T2"}"#,
            800,
        )
        .await
        .unwrap();
        let rows: Vec<(i64, String)> = sqlx::query_as(
            "SELECT id, payload_json FROM pending_calendar_writes WHERE target_id='s1'",
        )
        .fetch_all(&p)
        .await
        .unwrap();
        assert_eq!(rows.len(), 1, "same target+kind must merge");
        assert!(rows[0].1.contains("T2"), "latest payload must win");
    }

    /// Task 3: backoff 스케줄 [1s, 3s, 9s].
    #[test]
    fn backoff_delay_progression() {
        assert_eq!(backoff_ms_for_attempt(0), 1_000);
        assert_eq!(backoff_ms_for_attempt(1), 3_000);
        assert_eq!(backoff_ms_for_attempt(2), 9_000);
    }

    /// Task 3: 3회 시도 후 terminal — 4회차 이상도 terminal.
    #[test]
    fn backoff_terminal_after_three() {
        assert!(is_terminal_attempt(3));
        assert!(!is_terminal_attempt(2));
        assert!(is_terminal_attempt(4));
    }

    /// Task 4: staged=true payload는 워커가 skip(cross-cal Acceptance 게이트).
    #[tokio::test]
    async fn fetch_due_skips_staged() {
        let p = pool().await;
        let now = format_sqlite_datetime(Utc::now());
        sqlx::query(
            "INSERT INTO pending_calendar_writes
             (kind, target_kind, target_id, calendar_id, payload_json, next_attempt_at)
             VALUES ('patch','signal','s1','cal',?,?)",
        )
        .bind(r#"{"staged":true}"#)
        .bind(&now)
        .execute(&p)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO pending_calendar_writes
             (kind, target_kind, target_id, calendar_id, payload_json, next_attempt_at)
             VALUES ('patch','signal','s2','cal',?,?)",
        )
        .bind(r#"{}"#)
        .bind(&now)
        .execute(&p)
        .await
        .unwrap();
        let due = fetch_due_writes(&p).await.unwrap();
        assert_eq!(due.len(), 1, "staged row must be skipped");
        assert_eq!(due[0].target_id, "s2");
    }

    /// Task 5: 실패 기록 — attempts += 1, last_error 보존.
    #[tokio::test]
    async fn record_failure_updates_attempts_and_next() {
        let p = pool().await;
        let id = upsert_write(&p, "patch", "signal", "s1", "cal", None, "{}", 0)
            .await
            .unwrap();
        record_failure(&p, id, "boom").await.unwrap();
        let row: (i32, Option<String>) =
            sqlx::query_as("SELECT attempts, last_error FROM pending_calendar_writes WHERE id=?")
                .bind(id)
                .fetch_one(&p)
                .await
                .unwrap();
        assert_eq!(row.0, 1);
        assert_eq!(row.1.as_deref(), Some("boom"));
    }
}
