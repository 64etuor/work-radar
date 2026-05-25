//! news_items SQLite 캐시 — upsert + 최근순 조회 + 7일 만료 purge.
//! ON CONFLICT 패턴은 signal_store dedup 답습.

use chrono::{Duration, Utc};

use super::filter_store::{FilterMode, KeywordFilter};
use super::options_store::{NewsOptions, SortMode};
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

/// SortMode → 외부 SELECT의 ORDER BY 고정 절. closed-set → `&'static str` only.
/// 모든 모드 마지막에 `n.external_id DESC` tiebreak를 둬서 같은 timestamp(arXiv 배치
/// 등에서 흔함) 시에도 결정적 순서를 보장(v3 minor).
fn order_clause(mode: SortMode) -> &'static str {
    match mode {
        SortMode::Recent => "ORDER BY n.posted_at DESC, n.external_id DESC",
        SortMode::Comments => {
            "ORDER BY COALESCE(n.comment_count, 0) DESC, n.posted_at DESC, n.external_id DESC"
        }
        // mixed: rn ASC로 라운드 우선, 같은 rn 내에서 source ASC tiebreak로 deterministic,
        // 그 다음 최신순 + external_id tiebreak(v3 minor).
        SortMode::Mixed => "ORDER BY n.rn ASC, n.source ASC, n.posted_at DESC, n.external_id DESC",
    }
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

/// 활성 소스만 합본해 opts 설정대로 조회. 필터 있으면 include OR + exclude AND 적용.
/// per-source 한도는 ROW_NUMBER() 윈도우 함수로 적용(0=무제한).
pub async fn list_recent(
    db: &Db,
    opts: &NewsOptions,
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

    let per_source_limit = if opts.per_source_limit == 0 {
        i64::MAX
    } else {
        opts.per_source_limit as i64
    };
    let order = order_clause(opts.sort_mode);

    // SAFETY: include_clause/exclude_clause/order 모두 closed-set static fragment 조합.
    // 동적 값은 후속 .bind만.
    let sql = format!(
        "WITH ranked AS ( \
             SELECT n.*, \
                    ROW_NUMBER() OVER ( \
                        PARTITION BY n.source \
                        ORDER BY n.posted_at DESC, n.external_id DESC \
                    ) AS rn \
             FROM news_items n \
             JOIN news_source_pref p ON p.source = n.source AND p.enabled = 1 \
             WHERE 1=1{include_clause}{exclude_clause} \
         ) \
         SELECT n.source, n.external_id, n.title, n.url, n.comments_url, n.comment_count, n.posted_at \
         FROM ranked AS n \
         WHERE n.rn <= ? \
         {order} \
         LIMIT ?"
    );

    let mut q = sqlx::query_as::<_, NewsItemRow>(&sql);
    for kw in &includes {
        q = q.bind(format!("%{}%", like_escape(&kw.keyword)));
    }
    for kw in &excludes {
        q = q.bind(format!("%{}%", like_escape(&kw.keyword)));
    }
    q = q.bind(per_source_limit).bind(opts.total_limit as i64);

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

    fn test_opts() -> NewsOptions {
        NewsOptions {
            total_limit: 10,
            per_source_limit: 0,
            sort_mode: SortMode::Recent,
            fetch_interval_minutes: 15,
            marquee_seconds: 60,
        }
    }

    #[tokio::test]
    async fn upsert_dedup_keeps_latest_title() {
        let p = pool().await;
        upsert_many(&p, &[item("hn", "1", "old"), item("hn", "1", "new")])
            .await
            .unwrap();
        let rows = list_recent(&p, &test_opts(), &[]).await.unwrap();
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
        let rows = list_recent(&p, &test_opts(), &[]).await.unwrap();
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
        let rows = list_recent(&p, &test_opts(), &filters).await.unwrap();
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
        let rows = list_recent(&p, &test_opts(), &filters).await.unwrap();
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
        let rows = list_recent(&p, &test_opts(), &filters).await.unwrap();
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
        let rows = list_recent(&p, &test_opts(), &filters).await.unwrap();
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
        let rows = list_recent(&p, &test_opts(), &filters).await.unwrap();
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
        let rows = list_recent(&p, &test_opts(), &f).await.unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
        assert_eq!(ids, vec!["2"], "100% include는 literal % 만 매치");

        // include = "unit_test" → only literal "unit_test" matches, NOT "unitXtest".
        let f = vec![KeywordFilter {
            id: 1,
            keyword: "unit_test".into(),
            mode: FilterMode::Include,
        }];
        let rows = list_recent(&p, &test_opts(), &f).await.unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
        assert_eq!(ids, vec!["3"], "unit_test include는 literal _ 만 매치");
    }

    #[tokio::test]
    async fn per_source_limit_caps_per_source() {
        let p = pool().await;
        sqlx::query(
            "INSERT INTO news_source_pref(source, enabled) VALUES ('geeknews', 1) \
             ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled",
        )
        .execute(&p)
        .await
        .unwrap();
        for i in 0..5 {
            upsert_many(&p, &[item("hn", &format!("h{i}"), &format!("hn-{i}"))])
                .await
                .unwrap();
            upsert_many(
                &p,
                &[item("geeknews", &format!("g{i}"), &format!("gn-{i}"))],
            )
            .await
            .unwrap();
        }
        let mut opts = test_opts();
        opts.per_source_limit = 2;
        opts.total_limit = 100;
        let rows = list_recent(&p, &opts, &[]).await.unwrap();
        assert_eq!(rows.iter().filter(|r| r.source == "hn").count(), 2);
        assert_eq!(rows.iter().filter(|r| r.source == "geeknews").count(), 2);
    }

    #[tokio::test]
    async fn sort_mode_comments_orders_by_comment_count_desc() {
        let p = pool().await;
        let mut a = item("hn", "1", "a");
        a.comment_count = Some(10);
        let mut b = item("hn", "2", "b");
        b.comment_count = Some(50);
        let mut c = item("hn", "3", "c");
        c.comment_count = Some(20);
        upsert_many(&p, &[a, b, c]).await.unwrap();
        let mut opts = test_opts();
        opts.sort_mode = SortMode::Comments;
        let rows = list_recent(&p, &opts, &[]).await.unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
        assert_eq!(ids, vec!["2", "3", "1"]);
    }

    #[tokio::test]
    async fn sort_mode_mixed_round_robin_deterministic() {
        let p = pool().await;
        sqlx::query(
            "INSERT INTO news_source_pref(source, enabled) VALUES ('geeknews', 1), ('lobsters', 1) \
             ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled",
        )
        .execute(&p)
        .await
        .unwrap();
        // 각 소스 2개씩.
        upsert_many(
            &p,
            &[
                item("hn", "h1", "hn-1"),
                item("hn", "h2", "hn-2"),
                item("geeknews", "g1", "gn-1"),
                item("geeknews", "g2", "gn-2"),
                item("lobsters", "l1", "lb-1"),
                item("lobsters", "l2", "lb-2"),
            ],
        )
        .await
        .unwrap();
        let mut opts = test_opts();
        opts.sort_mode = SortMode::Mixed;
        opts.total_limit = 6;
        let rows = list_recent(&p, &opts, &[]).await.unwrap();
        // rn=1 라운드 3건(source ASC: geeknews, hn, lobsters), 그 다음 rn=2 라운드.
        let sources: Vec<&str> = rows.iter().map(|r| r.source.as_str()).collect();
        assert_eq!(
            &sources[..3],
            &["geeknews", "hn", "lobsters"],
            "라운드 1 source ASC"
        );
        assert_eq!(
            &sources[3..],
            &["geeknews", "hn", "lobsters"],
            "라운드 2 source ASC"
        );
    }
}
