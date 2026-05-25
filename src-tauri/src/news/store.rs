//! news_items SQLite 캐시 — upsert + 최근순 조회 + 7일 만료 purge.
//! ON CONFLICT 패턴은 signal_store dedup 답습.

use chrono::{Duration, Utc};

use super::NewsItem;
use crate::db::Db;
use crate::error::AppError;

/// 새/갱신 아이템 upsert. 동일 (source, external_id) → title/comment_count/fetched_at 갱신.
pub async fn upsert_many(db: &Db, items: &[NewsItem]) -> Result<(), AppError> {
    if items.is_empty() {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339();
    let mut tx = db.begin().await?;
    for item in items {
        sqlx::query(
            "INSERT INTO news_items \
                 (source, external_id, title, url, comments_url, comment_count, posted_at, fetched_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(source, external_id) DO UPDATE SET \
                 title = excluded.title, \
                 url = excluded.url, \
                 comments_url = excluded.comments_url, \
                 comment_count = excluded.comment_count, \
                 posted_at = excluded.posted_at, \
                 fetched_at = excluded.fetched_at",
        )
        .bind(&item.source)
        .bind(&item.external_id)
        .bind(&item.title)
        .bind(&item.url)
        .bind(&item.comments_url)
        .bind(item.comment_count.map(|v| v as i64))
        .bind(&item.posted_at)
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 활성 소스만 합본해 posted_at DESC로 limit개. 활성 0개면 빈 Vec.
pub async fn list_recent(db: &Db, limit: u32) -> Result<Vec<NewsItem>, AppError> {
    let rows = sqlx::query_as::<_, NewsItemRow>(
        "SELECT n.source, n.external_id, n.title, n.url, n.comments_url, n.comment_count, n.posted_at \
         FROM news_items n \
         JOIN news_source_pref p ON p.source = n.source AND p.enabled = 1 \
         ORDER BY n.posted_at DESC \
         LIMIT ?",
    )
    .bind(limit as i64)
    .fetch_all(db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// 7일 초과 아이템 정리 — fetcher tick 시작 시 호출.
pub async fn purge_expired(db: &Db) -> Result<u64, AppError> {
    let cutoff = (Utc::now() - Duration::days(7)).to_rfc3339();
    let r = sqlx::query("DELETE FROM news_items WHERE fetched_at < ?")
        .bind(cutoff)
        .execute(db)
        .await?;
    Ok(r.rows_affected())
}

#[derive(sqlx::FromRow)]
struct NewsItemRow {
    source: String,
    external_id: String,
    title: String,
    url: String,
    comments_url: Option<String>,
    comment_count: Option<i64>,
    posted_at: String,
}

impl From<NewsItemRow> for NewsItem {
    fn from(r: NewsItemRow) -> Self {
        Self {
            source: r.source,
            external_id: r.external_id,
            title: r.title,
            url: r.url,
            comments_url: r.comments_url,
            comment_count: r.comment_count.and_then(|v| u32::try_from(v).ok()),
            posted_at: r.posted_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::SqlitePool;

    async fn pool() -> SqlitePool {
        let p = SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&p).await.unwrap();
        sqlx::query("INSERT INTO news_source_pref(source, enabled) VALUES ('hn', 1)")
            .execute(&p)
            .await
            .unwrap();
        p
    }

    fn item(id: &str, title: &str) -> NewsItem {
        NewsItem {
            source: "hn".into(),
            external_id: id.into(),
            title: title.into(),
            url: format!("https://example.com/{id}"),
            comments_url: None,
            comment_count: Some(42),
            posted_at: Utc::now().to_rfc3339(),
        }
    }

    #[tokio::test]
    async fn upsert_dedup_keeps_latest_title() {
        let p = pool().await;
        upsert_many(&p, &[item("1", "old"), item("1", "new")])
            .await
            .unwrap();
        let rows = list_recent(&p, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "new");
    }

    #[tokio::test]
    async fn list_recent_excludes_disabled_sources() {
        let p = pool().await;
        sqlx::query("INSERT INTO news_source_pref(source, enabled) VALUES ('geeknews', 0)")
            .execute(&p)
            .await
            .unwrap();
        upsert_many(&p, &[item("1", "hn-1")]).await.unwrap();
        // geeknews 아이템 직접 삽입(소스 trait fetch 없이 store 단위 검증)
        sqlx::query(
            "INSERT INTO news_items(source, external_id, title, url, posted_at, fetched_at)
             VALUES ('geeknews', 'gn-1', 'gn', 'http://x', ?, ?)",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .execute(&p)
        .await
        .unwrap();
        let rows = list_recent(&p, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].source, "hn");
    }

    #[tokio::test]
    async fn purge_removes_old() {
        let p = pool().await;
        // fetched_at 강제 8일 전 직접 삽입
        sqlx::query(
            "INSERT INTO news_items(source, external_id, title, url, posted_at, fetched_at)
             VALUES ('hn', '1', 't', 'http://x', ?, ?)",
        )
        .bind(Utc::now().to_rfc3339())
        .bind((Utc::now() - Duration::days(8)).to_rfc3339())
        .execute(&p)
        .await
        .unwrap();
        let n = purge_expired(&p).await.unwrap();
        assert_eq!(n, 1);
    }
}
