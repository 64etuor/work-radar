//! news_items SQLite 캐시 — upsert + 최근순 조회 + 7일 만료 purge.
//! ON CONFLICT 패턴은 signal_store dedup 답습.

use chrono::{Duration, Utc};

use super::filter_store::{FilterMode, KeywordFilter};
use super::NewsItem;
use crate::db::Db;
use crate::error::AppError;

/// 비-2xx 위험 절은 항상 `&'static str` 상수(injection surface 0). 값은 `?`+bind만.
/// ESCAPE '\' 절로 LIKE 메타문자(%, _, \)를 리터럴로 강제.
const INCLUDE_FRAGMENT: &str = r"n.title LIKE ? ESCAPE '\' COLLATE NOCASE";
const EXCLUDE_FRAGMENT: &str = r"n.title NOT LIKE ? ESCAPE '\' COLLATE NOCASE";

/// LIKE 패턴에 삽입하기 전 메타문자 이스케이프.
/// SQLite `ESCAPE '\'` 절 대응 — 순서 중요: `\` 먼저, 그 다음 `%`, `_`.
fn like_escape(s: &str) -> String {
    s.replace('\\', r"\\")
        .replace('%', r"\%")
        .replace('_', r"\_")
}

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

/// 활성 소스만 합본해 posted_at DESC로 limit개. 필터 있으면 include OR + exclude AND 적용.
pub async fn list_recent(
    db: &Db,
    limit: u32,
    filters: &[KeywordFilter],
) -> Result<Vec<NewsItem>, AppError> {
    let includes: Vec<&KeywordFilter> = filters
        .iter()
        .filter(|f| f.mode == FilterMode::Include)
        .collect();
    let excludes: Vec<&KeywordFilter> = filters
        .iter()
        .filter(|f| f.mode == FilterMode::Exclude)
        .collect();

    let include_clause = if includes.is_empty() {
        String::new()
    } else {
        // OR: 적어도 하나 매치.
        let parts: Vec<&'static str> = (0..includes.len()).map(|_| INCLUDE_FRAGMENT).collect();
        format!(" AND ({})", parts.join(" OR "))
    };
    let exclude_clause = if excludes.is_empty() {
        String::new()
    } else {
        // AND: 모두 미매치.
        let parts: Vec<&'static str> = (0..excludes.len()).map(|_| EXCLUDE_FRAGMENT).collect();
        format!(" AND ({})", parts.join(" AND "))
    };

    // SAFETY: 필터 fragment는 모두 closed-set `&'static str`. 동적 값은 ?로만.
    let sql = format!(
        "SELECT n.source, n.external_id, n.title, n.url, n.comments_url, n.comment_count, n.posted_at \
         FROM news_items n \
         JOIN news_source_pref p ON p.source = n.source AND p.enabled = 1 \
         WHERE 1=1{include_clause}{exclude_clause} \
         ORDER BY n.posted_at DESC \
         LIMIT ?"
    );

    let mut q = sqlx::query_as::<_, NewsItemRow>(&sql);
    for kw in &includes {
        q = q.bind(format!("%{}%", like_escape(&kw.keyword)));
    }
    for kw in &excludes {
        q = q.bind(format!("%{}%", like_escape(&kw.keyword)));
    }
    q = q.bind(limit as i64);

    let rows = q.fetch_all(db).await?;
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

    fn item(source: &str, id: &str, title: &str) -> NewsItem {
        NewsItem {
            source: source.into(),
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
        upsert_many(&p, &[item("hn", "1", "old"), item("hn", "1", "new")])
            .await
            .unwrap();
        let rows = list_recent(&p, 10, &[]).await.unwrap();
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
        upsert_many(&p, &[item("hn", "1", "hn-1")]).await.unwrap();
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
        let rows = list_recent(&p, 10, &[]).await.unwrap();
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

    #[tokio::test]
    async fn include_filter_keeps_only_matching() {
        let p = pool().await;
        upsert_many(
            &p,
            &[
                item("hn", "1", "AI breakthrough"),
                item("hn", "2", "Crypto crashes"),
                item("hn", "3", "Tauri 2 released"),
            ],
        )
        .await
        .unwrap();
        let filters = vec![KeywordFilter {
            id: 1,
            keyword: "AI".into(),
            mode: FilterMode::Include,
        }];
        let rows = list_recent(&p, 10, &filters).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].external_id, "1");
    }

    #[tokio::test]
    async fn exclude_filter_removes_matching() {
        let p = pool().await;
        upsert_many(
            &p,
            &[
                item("hn", "1", "AI breakthrough"),
                item("hn", "2", "Crypto crashes"),
                item("hn", "3", "Tauri 2 released"),
            ],
        )
        .await
        .unwrap();
        let filters = vec![KeywordFilter {
            id: 1,
            keyword: "crypto".into(),
            mode: FilterMode::Exclude,
        }];
        let rows = list_recent(&p, 10, &filters).await.unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
        assert_eq!(ids.len(), 2);
        assert!(!ids.contains(&"2"));
    }

    #[tokio::test]
    async fn include_or_logic_multiple_keywords() {
        let p = pool().await;
        upsert_many(
            &p,
            &[
                item("hn", "1", "AI news"),
                item("hn", "2", "Rust 1.90"),
                item("hn", "3", "Web design"),
            ],
        )
        .await
        .unwrap();
        let filters = vec![
            KeywordFilter {
                id: 1,
                keyword: "AI".into(),
                mode: FilterMode::Include,
            },
            KeywordFilter {
                id: 2,
                keyword: "Rust".into(),
                mode: FilterMode::Include,
            },
        ];
        let rows = list_recent(&p, 10, &filters).await.unwrap();
        assert_eq!(rows.len(), 2);
        let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
        assert!(ids.contains(&"1") && ids.contains(&"2"));
    }

    #[tokio::test]
    async fn include_and_exclude_combined() {
        let p = pool().await;
        upsert_many(
            &p,
            &[
                item("hn", "1", "AI breakthrough"),
                item("hn", "2", "AI crypto coin"),
                item("hn", "3", "Crypto crashes"),
            ],
        )
        .await
        .unwrap();
        let filters = vec![
            KeywordFilter {
                id: 1,
                keyword: "AI".into(),
                mode: FilterMode::Include,
            },
            KeywordFilter {
                id: 2,
                keyword: "crypto".into(),
                mode: FilterMode::Exclude,
            },
        ];
        let rows = list_recent(&p, 10, &filters).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].external_id, "1",
            "include='AI' AND exclude='crypto' → '1'만"
        );
    }

    #[tokio::test]
    async fn case_insensitive_match() {
        let p = pool().await;
        upsert_many(&p, &[item("hn", "1", "Rust 1.90")])
            .await
            .unwrap();
        let filters = vec![KeywordFilter {
            id: 1,
            keyword: "RUST".into(),
            mode: FilterMode::Include,
        }];
        let rows = list_recent(&p, 10, &filters).await.unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[tokio::test]
    async fn like_metacharacters_are_escaped() {
        let p = pool().await;
        upsert_many(
            &p,
            &[
                item("hn", "1", "C++ 28 release"),
                item("hn", "2", "100% sure"),
                item("hn", "3", "unit_test framework"),
                item("hn", "4", "100x speedup"), // should NOT match "100%"
                item("hn", "5", "unitXtest tools"), // should NOT match "unit_test"
            ],
        )
        .await
        .unwrap();

        // include = "100%" → only literal "100%" matches, NOT "100x".
        let f = vec![KeywordFilter {
            id: 1,
            keyword: "100%".into(),
            mode: FilterMode::Include,
        }];
        let rows = list_recent(&p, 10, &f).await.unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
        assert_eq!(ids, vec!["2"], "100% include는 literal % 만 매치");

        // include = "unit_test" → only literal "unit_test" matches, NOT "unitXtest".
        let f = vec![KeywordFilter {
            id: 1,
            keyword: "unit_test".into(),
            mode: FilterMode::Include,
        }];
        let rows = list_recent(&p, 10, &f).await.unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
        assert_eq!(ids, vec!["3"], "unit_test include는 literal _ 만 매치");
    }
}
