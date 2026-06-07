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
    let candidate_limit = candidate_limit(opts.total_limit);
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
    q = q.bind(per_source_limit).bind(candidate_limit);

    let rows = q.fetch_all(db).await?;
    Ok(rank_and_trim(
        rows.into_iter().map(Into::into).collect(),
        opts.total_limit as usize,
        opts.hot_only,
    ))
}

fn candidate_limit(total_limit: u32) -> i64 {
    let base = i64::from(total_limit);
    // 핫/트렌딩이 total_limit 밖으로 밀려도 후보군에 남아있게 넉넉히 overfetch.
    base.saturating_mul(4).max(base.saturating_add(20))
}

/// "핫" 키워드 부스트 셋(소문자 substring 매치). engagement 신호가 거의 없는 대부분의
/// 소스에서도 화제성 항목을 살짝 끌어올린다. 작게 유지 — display-only 휴리스틱.
const HOT_KEYWORDS: &[&str] = &[
    "ai",
    "gpt",
    "llm",
    "rust",
    "security",
    "breach",
    "release",
    "launch",
    "open source",
    "breakthrough",
];

/// 표시 전용 composite "hotness" 점수. 순수 함수 — DB 쓰기/스키마 변경 없음.
///
/// 세 신호 합산:
/// - recency: 발행 후 경과 시간에 대한 지수 감쇠(반감기 ~12h). 신선할수록 높음. **항상 존재**.
/// - engagement: `comment_count`가 있으면 `ln(1+count)`로 접음. 없으면 0 기여(자격 박탈 아님).
/// - keyword: 제목에 핫 키워드가 있으면 작은 가산 부스트.
///
/// comment_count가 reddit 한 소스에만 있으므로 engagement 단독으로는 hot-only가 비어버린다.
/// recency가 항상 양수라 모든 항목에 점수가 매겨져 hot-only가 절대 비지 않는다.
fn hotness(item: &NewsItem) -> f64 {
    let hours_since = chrono::DateTime::parse_from_rfc3339(&item.posted_at)
        .map(|t| (Utc::now() - t.with_timezone(&Utc)).num_seconds() as f64 / 3600.0)
        .unwrap_or(f64::MAX)
        .max(0.0);
    // 반감기 12h 지수 감쇠: 0h→1.0, 12h→0.5, 24h→0.25 …
    let recency = 0.5_f64.powf(hours_since / 12.0);

    let engagement = item
        .comment_count
        .map_or(0.0, |c| (1.0 + f64::from(c)).ln());

    let title_lc = item.title.to_lowercase();
    let keyword_boost = if HOT_KEYWORDS.iter().any(|k| title_lc.contains(k)) {
        0.5
    } else {
        0.0
    };

    recency + engagement + keyword_boost
}

/// 후보군을 표시용으로 정리한다.
/// - `hot_only == true`: composite `hotness` 내림차순으로 재정렬 후 상위 `total_limit`.
///   recency가 항상 양수라 comment_count가 전혀 없어도 절대 비지 않는다.
/// - `hot_only == false`: DB가 매긴 sort_mode 순서를 보존하되, total_limit로 잘릴 때
///   상위 hotness 항목이 가시 윈도우에서 밀려나지 않도록 promote(기존 핫-survive 계약 유지).
fn rank_and_trim(items: Vec<NewsItem>, total_limit: usize, hot_only: bool) -> Vec<NewsItem> {
    if hot_only {
        let mut scored: Vec<(f64, NewsItem)> =
            items.into_iter().map(|i| (hotness(&i), i)).collect();
        // 점수 내림차순. NaN 방지 위해 total_cmp 사용.
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        return scored
            .into_iter()
            .take(total_limit)
            .map(|(_, i)| i)
            .collect();
    }

    // hot_only=false: 자를 필요 없으면 DB 순서 그대로.
    if items.len() <= total_limit {
        return items;
    }

    // 잘릴 때만 hotness 상위 항목을 앞으로 promote해 가시 윈도우에서 살아남게 한다.
    // hot 그룹은 hotness 내림차순(가장 화제인 것이 선두), rest는 DB sort_mode 순서 유지.
    let threshold = hot_threshold(&items);
    let mut hot = Vec::with_capacity(items.len());
    let mut rest = Vec::with_capacity(items.len());
    for item in items {
        if hotness(&item) >= threshold {
            hot.push(item);
        } else {
            rest.push(item);
        }
    }
    hot.sort_by(|a, b| hotness(b).total_cmp(&hotness(a)));
    hot.extend(rest);
    hot.truncate(total_limit);
    hot
}

/// hotness 상위 분위(top-quartile) 컷오프 — 이 이상이면 "핫"으로 분류해 promote 대상.
fn hot_threshold(items: &[NewsItem]) -> f64 {
    let mut scores: Vec<f64> = items.iter().map(hotness).collect();
    if scores.is_empty() {
        return f64::MAX;
    }
    scores.sort_by(|a, b| b.total_cmp(a));
    let idx = ((scores.len().saturating_sub(1)) as f64 * 0.25).floor() as usize;
    scores[idx]
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
            hot_only: false,
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
    async fn hot_items_survive_total_limit_cut() {
        let p = pool().await;
        let now = Utc::now();
        let mut items = Vec::new();
        for i in 0..6 {
            let mut n = item("hn", &format!("h{i}"), &format!("hn-{i}"));
            n.posted_at = (now - Duration::seconds(i as i64)).to_rfc3339();
            n.comment_count = if i == 5 { Some(100) } else { Some(i as u32) };
            items.push(n);
        }
        upsert_many(&p, &items).await.unwrap();
        let mut opts = test_opts();
        opts.total_limit = 3;
        opts.per_source_limit = 0;
        opts.sort_mode = SortMode::Recent;
        let rows = list_recent(&p, &opts, &[]).await.unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
        assert_eq!(ids.len(), 3);
        assert_eq!(
            ids[0], "h5",
            "핫 아이템은 total_limit 밖에 있어도 후보군에서 살아남아야 함"
        );
    }

    #[tokio::test]
    async fn hot_only_ranks_by_engagement_without_emptying() {
        let p = pool().await;
        // 두 항목 동일 시각 → recency 동률, engagement(comment_count)가 순서를 가른다.
        let now = Utc::now();
        let mut cool = item("hn", "1", "cool");
        cool.comment_count = Some(3);
        cool.posted_at = now.to_rfc3339();
        let mut hot = item("hn", "2", "hot");
        hot.comment_count = Some(50);
        hot.posted_at = now.to_rfc3339();
        upsert_many(&p, &[cool, hot]).await.unwrap();
        let mut opts = test_opts();
        opts.hot_only = true;
        opts.total_limit = 10;
        let rows = list_recent(&p, &opts, &[]).await.unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
        // 새 composite: hot_only는 비우지 않고 hotness 내림차순으로 랭크 — 높은 engagement가 선두.
        assert_eq!(
            ids,
            vec!["2", "1"],
            "hot_only=true면 비우지 말고 engagement 높은 순으로 랭크"
        );
    }

    fn dated(source: &str, id: &str, secs_ago: i64, count: Option<u32>) -> NewsItem {
        let mut n = item(source, id, id);
        n.posted_at = (Utc::now() - Duration::seconds(secs_ago)).to_rfc3339();
        n.comment_count = count;
        n
    }

    #[test]
    fn rank_and_trim_hot_only_never_empty_without_comment_counts() {
        // 모든 아이템이 comment_count 없음(reddit 외 9개 소스 현실). hot-only가 비면 안 됨.
        let items = vec![
            dated("d2", "1", 30, None),
            dated("d2", "2", 10, None),
            dated("d2", "3", 50, None),
            dated("d2", "4", 5, None),
        ];
        let out = rank_and_trim(items, 3, true);
        assert_eq!(out.len(), 3, "hot-only는 min(limit, len)만큼 채워야 함");
        // 최신순(가장 작은 secs_ago 먼저): 4(5s) > 2(10s) > 1(30s).
        let ids: Vec<&str> = out.iter().map(|i| i.external_id.as_str()).collect();
        assert_eq!(ids, vec!["4", "2", "1"], "최신순 정렬");
    }

    #[test]
    fn rank_and_trim_newer_and_more_engaged_rank_higher() {
        let items = vec![
            dated("hn", "old_zero", 100_000, Some(0)),
            dated("hn", "new_zero", 60, None),
            dated("hn", "new_hot", 30, Some(500)),
        ];
        let out = rank_and_trim(items, 3, true);
        let ids: Vec<&str> = out.iter().map(|i| i.external_id.as_str()).collect();
        assert_eq!(ids[0], "new_hot", "최신 + 높은 engagement가 1위");
        assert_eq!(
            ids.last(),
            Some(&"old_zero"),
            "오래되고 engagement 0인 항목이 꼴찌"
        );
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
