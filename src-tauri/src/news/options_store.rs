//! 글로벌 뉴스 옵션 — 단일 row(id=1). get은 멱등 re-seed.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::Db;
use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortMode {
    Recent,
    Comments,
    Mixed,
}

impl SortMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Recent => "recent",
            Self::Comments => "comments",
            Self::Mixed => "mixed",
        }
    }
    fn parse(s: &str) -> Self {
        match s {
            "comments" => Self::Comments,
            "mixed" => Self::Mixed,
            _ => Self::Recent,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NewsOptions {
    /// 5..100. UI에서 clamp.
    pub total_limit: u32,
    /// 0=무제한.
    pub per_source_limit: u32,
    pub sort_mode: SortMode,
    /// 0/5/10/15/30/60. 0 = 자동 갱신 끔(fetcher 진짜 park, Notify 깨움만).
    pub fetch_interval_minutes: u32,
    /// 티커 마퀴 한 사이클 시간(초). UI slider에서 20..180으로 조절.
    pub marquee_seconds: u32,
    /// 댓글 있는 hot 항목만 표시.
    pub hot_only: bool,
}

impl Default for NewsOptions {
    fn default() -> Self {
        Self {
            total_limit: 30,
            per_source_limit: 10,
            sort_mode: SortMode::Recent,
            fetch_interval_minutes: 15,
            marquee_seconds: 60,
            hot_only: false,
        }
    }
}

/// 멱등 re-seed → SELECT. 누군가가 row를 지워도 다음 호출에서 자동 복구.
pub async fn get(db: &Db) -> Result<NewsOptions, AppError> {
    sqlx::query("INSERT INTO news_options(id) VALUES (1) ON CONFLICT DO NOTHING")
        .execute(db)
        .await?;
    let row: (i64, i64, String, i64, i64, i64) = sqlx::query_as(
        "SELECT total_limit, per_source_limit, sort_mode, fetch_interval_minutes, marquee_seconds, hot_only \
         FROM news_options WHERE id = 1",
    )
    .fetch_one(db)
    .await?;
    Ok(NewsOptions {
        total_limit: row.0 as u32,
        per_source_limit: row.1 as u32,
        sort_mode: SortMode::parse(&row.2),
        fetch_interval_minutes: row.3 as u32,
        marquee_seconds: row.4 as u32,
        hot_only: row.5 != 0,
    })
}

pub async fn set(db: &Db, o: &NewsOptions) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO news_options(id, total_limit, per_source_limit, sort_mode, fetch_interval_minutes, marquee_seconds, hot_only) \
         VALUES (1, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
             total_limit = excluded.total_limit, \
             per_source_limit = excluded.per_source_limit, \
             sort_mode = excluded.sort_mode, \
             fetch_interval_minutes = excluded.fetch_interval_minutes, \
             marquee_seconds = excluded.marquee_seconds, \
             hot_only = excluded.hot_only"
    )
    .bind(o.total_limit as i64)
    .bind(o.per_source_limit as i64)
    .bind(o.sort_mode.as_str())
    .bind(o.fetch_interval_minutes as i64)
    .bind(o.marquee_seconds as i64)
    .bind(if o.hot_only { 1_i64 } else { 0_i64 })
    .execute(db)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    async fn pool() -> SqlitePool {
        let p = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&p).await.unwrap();
        p
    }

    #[tokio::test]
    async fn defaults_are_recent_15min_30_10() {
        let p = pool().await;
        let o = get(&p).await.unwrap();
        assert_eq!(o, NewsOptions::default());
    }

    #[tokio::test]
    async fn set_then_get_roundtrip() {
        let p = pool().await;
        set(
            &p,
            &NewsOptions {
                total_limit: 50,
                per_source_limit: 0,
                sort_mode: SortMode::Mixed,
                fetch_interval_minutes: 30,
                marquee_seconds: 90,
                hot_only: true,
            },
        )
        .await
        .unwrap();
        let o = get(&p).await.unwrap();
        assert_eq!(o.total_limit, 50);
        assert_eq!(o.per_source_limit, 0);
        assert_eq!(o.sort_mode, SortMode::Mixed);
        assert_eq!(o.fetch_interval_minutes, 30);
        assert_eq!(o.marquee_seconds, 90);
        assert!(o.hot_only);
    }

    #[tokio::test]
    async fn set_works_after_row_delete() {
        let p = pool().await;
        sqlx::query("DELETE FROM news_options WHERE id = 1")
            .execute(&p)
            .await
            .unwrap();
        set(
            &p,
            &NewsOptions {
                total_limit: 42,
                per_source_limit: 7,
                sort_mode: SortMode::Comments,
                fetch_interval_minutes: 30,
                marquee_seconds: 120,
                hot_only: false,
            },
        )
        .await
        .unwrap();
        let o = get(&p).await.unwrap();
        assert_eq!(o.total_limit, 42);
        assert_eq!(o.per_source_limit, 7);
        assert_eq!(o.sort_mode, SortMode::Comments);
        assert_eq!(o.fetch_interval_minutes, 30);
        assert_eq!(o.marquee_seconds, 120);
        assert!(!o.hot_only);
    }

    #[tokio::test]
    async fn get_reseeds_after_row_delete() {
        let p = pool().await;
        sqlx::query("DELETE FROM news_options WHERE id = 1")
            .execute(&p)
            .await
            .unwrap();
        // get은 INSERT-then-SELECT 멱등 → row 다시 생기고 default 반환.
        let o = get(&p).await.unwrap();
        assert_eq!(o, NewsOptions::default());
    }
}
