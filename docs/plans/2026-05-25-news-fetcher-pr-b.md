# PR B — 뉴스 페처 백엔드 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **다음 세션 시작 지침은 본 문서 §0 "Session Handoff" 먼저 읽을 것.**

**Goal:** HackerNews · GeekNews · Lobsters 3개 외부 뉴스 소스를 Rust에서 페치 → SQLite 캐시 → tauri-specta IPC로 노출. 15분 주기 background task + bounded retry. 글로벌 소스 on/off 설정. 프런트 표시(PR C)는 별도.

**Architecture:**
`src-tauri/src/news/`에 `NewsSource` trait + 3 impls + SQLite store + tokio interval fetcher. 글로벌 설정은 `app_config` 테이블에 source pref 추가(에이전트 패턴과 동일). 토큰/시크릿 없음(공개 API/RSS) — keyring 무관. IPC 커맨드는 `news_list_recent` / `news_sources_available` / `news_sources_set_enabled` + 이벤트 2종(`news_items_updated`/`news_fetch_failed`).

**Tech Stack:** Rust 1.80+, sqlx 0.8 (sqlite), reqwest 0.12, tokio 1.x, tauri 2 + specta + tauri-specta. RSS 파싱은 `feed-rs` 또는 `rss` crate. JSON은 `serde_json`.

---

## §0 Session Handoff (다음 세션에서 가장 먼저 읽기)

### 현재 상태 (2026-05-25 세션 종료 시점)
- 브랜치 `dev` @ `35094c2..` (PR A 머지 완료)
- PR A — 매트릭스 정중앙 BrainDump 원형 토글 + 펄스/펼침 애니메이션 dev push 완료
- PR A follow-up(비차단): cmux 브라우저 스모크 실측(Esc → 토글만 닫힘 + window.hide 미호출 + 트리거 포커스 복원) — 사용자가 환경에서 확인 필요
- 변경된 핵심 파일: `BrainDumpToggle.tsx`(신규), `MatrixCanvas.tsx`, `CaptureBoard.tsx`, `styles.css`, `CapturePanel.tsx`(삭제)
- 하단 `.news-ticker-slot`은 빈 라인(border-top만) — PR B+C에서 채움

### 다음 세션 첫 액션 체크리스트
1. **컨텍스트 로드** — 이 plan(§0~§9)과 spec(`docs/specs/2026-05-25-brain-dump-toggle-and-news-ticker-design.md`) §5 정독.
2. **dev 최신 확인** — `git fetch origin && git status -sb` → `dev` clean이어야 진행.
3. **브랜치 생성** — `git checkout -b feat/news-fetcher-pr-b`.
4. **메모리 확인**: `MEMORY.md`의 다음 항목들이 본 PR 직결:
   - `sqlx-sqlite` (마이그레이션 패턴, dedup upsert, FTS5 — 본 PR은 FTS5 미사용)
   - `tauri-specta-ipc` (typed binding, command/event 어노테이션, capabilities)
   - `octocrab-keyring` — **본 PR 무관**(공개 API 토큰 없음). 단, 본 PR이 처음으로 외부 HTTP를 Rust에 추가하므로 `keep all network in Rust(렌더러에 노출 X)` 원칙은 그대로 적용 — 프런트에서 `fetch` 호출 금지.
   - `work-radar parallel worktree contaminates` — agents 순차 실행 필수.
   - `work-radar no cargo in agent shell` — `export PATH="$HOME/.cargo/bin:$PATH"` 후 cargo 실행, husky pre-commit도 동일.
   - `rtk cargo summary unreliable` — `rtk proxy cargo`로 verify.
   - `executor late writes` — agent 완료 후 항상 `git status`로 진짜 변경 파일 확인.

### INVARIANTS 적용 가드
| # | 불변식 | PR B 적용 |
|---|---|---|
| ① | 결정 레일 자동화 금지 | 뉴스 아이템은 **표시만** — 큐/매트릭스 자동 주입 절대 금지(아예 wiring 안 함) |
| ② | 외부 mutation Acceptance | 뉴스 페치는 read-only — 무관 |
| ③ | 신호 dedup upsert | 뉴스 `news_items` 도 `(source, external_id) UNIQUE` upsert로 동일 패턴 |
| ⑤ | bounded retry | 페치 실패 최대 3회 지수 백오프 + jitter, terminal failure는 `news_fetch_failed` 이벤트로 surface |
| ⑥ | 코드 worktree | 본 PR은 코드 변경 worktree 의무 무관(단일 트리 OK) |
| ⑦ | SSOT 분리 | 뉴스 원본 SSOT=외부 사이트, SQLite=캐시(`fetched_at` 7일 만료 nightly cleanup) |

---

## File Structure

| 파일 | 변경 | 책임 |
|---|---|---|
| `src-tauri/migrations/0016_news_items.sql` | **Create** | `news_items` 테이블 + 인덱스 |
| `src-tauri/migrations/0017_news_source_pref.sql` | **Create** | 소스별 on/off 설정 테이블 |
| `src-tauri/src/news/mod.rs` | **Create** | `NewsSource` trait, `NewsItem` 타입, registry, AppError 통합 |
| `src-tauri/src/news/hn.rs` | **Create** | HackerNews Firebase API impl |
| `src-tauri/src/news/geeknews.rs` | **Create** | GeekNews RSS impl |
| `src-tauri/src/news/lobsters.rs` | **Create** | Lobsters JSON impl |
| `src-tauri/src/news/store.rs` | **Create** | SQLite upsert + 조회 + cleanup |
| `src-tauri/src/news/pref_store.rs` | **Create** | 소스 on/off 저장 |
| `src-tauri/src/news/fetcher.rs` | **Create** | 15분 주기 tokio interval task (scheduler.rs 패턴 답습) |
| `src-tauri/src/commands/news.rs` | **Create** | tauri commands: `news_list_recent`, `news_sources_available`, `news_sources_set_enabled` |
| `src-tauri/src/commands/mod.rs` | **Modify** | `pub mod news;` 등록 |
| `src-tauri/src/lib.rs` (또는 `main.rs`) | **Modify** | news 모듈 등록 + setup hook에서 `fetcher::spawn(state)` 호출 + specta builder에 commands 등록 |
| `Cargo.toml` (src-tauri) | **Modify** | `feed-rs` 또는 `rss` 의존성 추가(반드시 `cargo add` 사용) |
| `src/bindings.ts` | **Auto-regen** | specta generate로 새 커맨드 타입 자동 노출 |

---

## Pre-flight

- [ ] **Step 0.1: dev 최신화 + 브랜치**

```bash
cd /Users/davidpark/private_project/work-radar
export PATH="$HOME/.cargo/bin:$PATH"
rtk git fetch origin
rtk git checkout dev && rtk git pull --ff-only
rtk git status -sb         # clean이어야 함
rtk git checkout -b feat/news-fetcher-pr-b
```

- [ ] **Step 0.2: RSS 의존성 결정 — `cargo add`로만**

`feed-rs` vs `rss` — `feed-rs`가 RSS+Atom 통합 파싱이라 GeekNews/Lobsters 모두 커버. 본 plan은 `feed-rs` 기준.

```bash
cd /Users/davidpark/private_project/work-radar/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
rtk cargo add feed-rs --features ""
rtk cargo add chrono --features "serde"   # 이미 있으면 no-op
```

검증: `Cargo.toml` diff 확인. `reqwest`/`tokio`/`sqlx`/`tauri-specta`는 이미 설치돼 있음.

- [ ] **Step 0.3: scheduler.rs 패턴 정독**

읽기 전용:
```bash
rg -n "tokio::time::interval|setup" src-tauri/src/scheduler.rs src-tauri/src/lib.rs
```
`scheduler::spawn(state)`가 어떻게 `setup` hook에서 호출되는지 확인 — fetcher.rs도 같은 시그니처(`pub fn spawn(state: AppState)`).

---

## Task 1 — DB 스키마 (마이그레이션 2개)

**Files:**
- Create: `src-tauri/migrations/0016_news_items.sql`
- Create: `src-tauri/migrations/0017_news_source_pref.sql`

- [ ] **Step 1.1: 0016 작성**

```sql
-- 0016_news_items.sql
-- 외부 뉴스 소스(HN/GeekNews/Lobsters) 캐시.
-- (source, external_id)로 dedup upsert(signal_store 패턴 동일).
-- fetched_at 인덱스로 최근순 정렬 + 7일 만료 cleanup 효율.

CREATE TABLE news_items (
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    comments_url TEXT,
    comment_count INTEGER,
    posted_at TEXT NOT NULL,   -- RFC3339
    fetched_at TEXT NOT NULL,  -- RFC3339
    PRIMARY KEY (source, external_id)
) STRICT;

CREATE INDEX news_items_fetched_at ON news_items(fetched_at DESC);
CREATE INDEX news_items_posted_at ON news_items(posted_at DESC);
```

- [ ] **Step 1.2: 0017 작성**

```sql
-- 0017_news_source_pref.sql
-- 소스별 on/off. 기본 enabled=1 — fetcher가 처음 페치할 때 registry로부터 누락 행 upsert.

CREATE TABLE news_source_pref (
    source TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1
) STRICT;
```

- [ ] **Step 1.3: 컴파일 확인**

```bash
cd /Users/davidpark/private_project/work-radar/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo check 2>&1 | tail -15
```
Expected: 0 errors. 마이그레이션은 런타임에 적용되므로 cargo check만으로는 SQL 문법 검증 안 됨 — Task 2의 store.rs 작성 후 store unit test에서 schema 동작 검증.

---

## Task 2 — `NewsSource` trait + 타입 + registry (mod.rs)

**Files:**
- Create: `src-tauri/src/news/mod.rs`

- [ ] **Step 2.1: 작성**

```rust
//! 외부 뉴스 소스(HN/GeekNews/Lobsters) 통합 페치 백엔드.
//!
//! INVARIANT #1(결정 레일 자동화 금지): 뉴스는 표시만 — 큐/매트릭스에 자동 주입 절대 금지.
//! INVARIANT #5(bounded retry): fetcher.rs에서 페치 실패 시 최대 3회 지수 백오프 + jitter.
//! INVARIANT #7(SSOT 분리): 원본 SSOT=외부 사이트, SQLite=캐시(`fetched_at` 7일 만료).

pub mod fetcher;
pub mod geeknews;
pub mod hn;
pub mod lobsters;
pub mod pref_store;
pub mod store;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::AppResult;

/// 정규화된 뉴스 아이템 — 모든 소스가 이 형태로 반환.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsItem {
    /// 소스 id (예: "hn", "geeknews", "lobsters"). registry id와 동일.
    pub source: String,
    /// 소스 내 안정적 id (HN: story id, RSS: guid).
    pub external_id: String,
    pub title: String,
    pub url: String,
    pub comments_url: Option<String>,
    pub comment_count: Option<u32>,
    pub posted_at: DateTime<Utc>,
}

/// 소스 메타 정보 — IPC `news_sources_available`이 반환.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NewsSourceMeta {
    pub id: String,
    pub label: String,
    pub enabled: bool,
}

#[async_trait]
pub trait NewsSource: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;
    /// 페치. 실패는 AppError로 — 호출자(fetcher.rs)가 retry 결정.
    async fn fetch(&self, client: &Client) -> AppResult<Vec<NewsItem>>;
}

/// 컴파일 시 고정 — 새 소스 추가 = 한 줄.
pub fn registry() -> Vec<Box<dyn NewsSource>> {
    vec![
        Box::new(hn::HnSource),
        Box::new(geeknews::GeekNewsSource),
        Box::new(lobsters::LobstersSource),
    ]
}
```

- [ ] **Step 2.2: cargo check**

```bash
cd /Users/davidpark/private_project/work-radar/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo check 2>&1 | tail -15
```
Expected: 하위 모듈(`hn`/`geeknews`/`lobsters`/`pref_store`/`store`/`fetcher`)이 없으니 unresolved module 에러. 정상 — Task 3~7에서 채움. 진행.

---

## Task 3 — `store.rs` (SQLite upsert + 조회 + cleanup)

**Files:**
- Create: `src-tauri/src/news/store.rs`

- [ ] **Step 3.1: 작성**

```rust
//! news_items SQLite 캐시 — upsert + 최근순 조회 + 7일 만료 purge.
//! ON CONFLICT 패턴은 signal_store dedup 답습.

use chrono::{Duration, Utc};
use sqlx::SqlitePool;

use crate::error::AppResult;
use super::NewsItem;

/// 새/갱신 아이템 upsert. 동일 (source, external_id) → title/comment_count/fetched_at 갱신.
pub async fn upsert_many(pool: &SqlitePool, items: &[NewsItem]) -> AppResult<()> {
    if items.is_empty() {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;
    for item in items {
        sqlx::query(
            r#"
            INSERT INTO news_items
                (source, external_id, title, url, comments_url, comment_count, posted_at, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(source, external_id) DO UPDATE SET
                title = excluded.title,
                url = excluded.url,
                comments_url = excluded.comments_url,
                comment_count = excluded.comment_count,
                posted_at = excluded.posted_at,
                fetched_at = excluded.fetched_at
            "#,
        )
        .bind(&item.source)
        .bind(&item.external_id)
        .bind(&item.title)
        .bind(&item.url)
        .bind(&item.comments_url)
        .bind(item.comment_count.map(|v| v as i64))
        .bind(item.posted_at.to_rfc3339())
        .bind(&now)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// 활성 소스만 합본해 posted_at DESC로 limit개. 활성 0개면 빈 Vec.
pub async fn list_recent(pool: &SqlitePool, limit: u32) -> AppResult<Vec<NewsItem>> {
    let rows = sqlx::query_as::<_, NewsItemRow>(
        r#"
        SELECT n.source, n.external_id, n.title, n.url, n.comments_url, n.comment_count, n.posted_at
        FROM news_items n
        JOIN news_source_pref p ON p.source = n.source AND p.enabled = 1
        ORDER BY n.posted_at DESC
        LIMIT ?
        "#,
    )
    .bind(limit as i64)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

/// 7일 초과 아이템 정리 — fetcher tick 시작 시 호출.
pub async fn purge_expired(pool: &SqlitePool) -> AppResult<u64> {
    let cutoff = (Utc::now() - Duration::days(7)).to_rfc3339();
    let r = sqlx::query("DELETE FROM news_items WHERE fetched_at < ?")
        .bind(cutoff)
        .execute(pool)
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
            posted_at: chrono::DateTime::parse_from_rfc3339(&r.posted_at)
                .map(|d| d.with_timezone(&chrono::Utc))
                .unwrap_or_else(|_| Utc::now()),
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
            .execute(&p).await.unwrap();
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
            posted_at: Utc::now(),
        }
    }

    #[tokio::test]
    async fn upsert_dedup_keeps_latest_title() {
        let p = pool().await;
        upsert_many(&p, &[item("1", "old"), item("1", "new")]).await.unwrap();
        let rows = list_recent(&p, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "new");
    }

    #[tokio::test]
    async fn list_recent_excludes_disabled_sources() {
        let p = pool().await;
        sqlx::query("INSERT INTO news_source_pref(source, enabled) VALUES ('geeknews', 0)")
            .execute(&p).await.unwrap();
        upsert_many(&p, &[item("1", "hn-1")]).await.unwrap();
        // geeknews 아이템 직접 삽입(소스 trait fetch 없이 store 단위 검증)
        sqlx::query(
            "INSERT INTO news_items(source, external_id, title, url, posted_at, fetched_at)
             VALUES ('geeknews', 'gn-1', 'gn', 'http://x', ?, ?)",
        )
        .bind(Utc::now().to_rfc3339())
        .bind(Utc::now().to_rfc3339())
        .execute(&p).await.unwrap();
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
        .execute(&p).await.unwrap();
        let n = purge_expired(&p).await.unwrap();
        assert_eq!(n, 1);
    }
}
```

- [ ] **Step 3.2: cargo test (store만)**

```bash
cd /Users/davidpark/private_project/work-radar/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo test --lib news::store:: 2>&1 | tail -20
```
Expected: 3 tests pass. 실패면 SQL 문법/마이그레이션 순서 점검(in-memory DB가 `sqlx::migrate!` 적용 성공해야 함).

---

## Task 4 — `pref_store.rs` (소스 on/off)

**Files:**
- Create: `src-tauri/src/news/pref_store.rs`

- [ ] **Step 4.1: 작성**

```rust
//! 소스별 on/off pref. registry()에 없는 소스 행이 DB에 있으면 그냥 무시(미래 호환).
//! 등록 안 된 새 소스가 registry에 추가되면 첫 호출 시 default enabled로 upsert.

use sqlx::SqlitePool;

use crate::error::AppResult;
use super::{registry, NewsSourceMeta};

/// 등록된 모든 소스 + 현재 enabled 상태. registry 순서 보존.
pub async fn list_available(pool: &SqlitePool) -> AppResult<Vec<NewsSourceMeta>> {
    let saved: std::collections::HashMap<String, bool> = sqlx::query_as::<_, (String, i64)>(
        "SELECT source, enabled FROM news_source_pref",
    )
    .fetch_all(pool)
    .await?
    .into_iter()
    .map(|(s, e)| (s, e != 0))
    .collect();

    let mut out = Vec::new();
    for src in registry() {
        let id = src.id().to_string();
        let enabled = saved.get(&id).copied().unwrap_or(true); // 기본 ON
        out.push(NewsSourceMeta {
            label: src.label().to_string(),
            id,
            enabled,
        });
    }
    Ok(out)
}

/// upsert one source pref.
pub async fn set_enabled(pool: &SqlitePool, source: &str, enabled: bool) -> AppResult<()> {
    sqlx::query(
        r#"
        INSERT INTO news_source_pref(source, enabled) VALUES (?, ?)
        ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled
        "#,
    )
    .bind(source)
    .bind(if enabled { 1 } else { 0 })
    .execute(pool)
    .await?;
    Ok(())
}

/// fetcher가 활성 소스만 페치하도록 — `list_available()`에서 enabled=true만 추출.
pub async fn enabled_ids(pool: &SqlitePool) -> AppResult<Vec<String>> {
    Ok(list_available(pool)
        .await?
        .into_iter()
        .filter(|m| m.enabled)
        .map(|m| m.id)
        .collect())
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
    async fn default_enabled_true_for_all() {
        let p = pool().await;
        let list = list_available(&p).await.unwrap();
        assert_eq!(list.len(), 3);
        assert!(list.iter().all(|m| m.enabled));
    }

    #[tokio::test]
    async fn set_then_read_back() {
        let p = pool().await;
        set_enabled(&p, "geeknews", false).await.unwrap();
        let list = list_available(&p).await.unwrap();
        assert_eq!(list.iter().find(|m| m.id == "geeknews").unwrap().enabled, false);
        assert!(enabled_ids(&p).await.unwrap().contains(&"hn".to_string()));
        assert!(!enabled_ids(&p).await.unwrap().contains(&"geeknews".to_string()));
    }
}
```

- [ ] **Step 4.2: cargo test**

```bash
rtk proxy cargo test --lib news::pref_store:: 2>&1 | tail -15
```
Expected: 2 tests pass.

---

## Task 5 — `hn.rs` (HackerNews Firebase API)

**Files:**
- Create: `src-tauri/src/news/hn.rs`

API:
- `https://hacker-news.firebaseio.com/v0/topstories.json` → `[id, id, ...]` (최대 500개)
- `https://hacker-news.firebaseio.com/v0/item/{id}.json` → `{ id, title, url, kids, descendants, time, ... }`
- Item 30개로 제한, 병렬 페치 — `tokio::task::JoinSet`.

- [ ] **Step 5.1: 작성**

```rust
//! Hacker News (Firebase v0). 무인증, JSON, top stories 30건 병렬 페치.

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use reqwest::Client;
use serde::Deserialize;
use tokio::task::JoinSet;

use crate::error::{AppError, AppResult};
use super::{NewsItem, NewsSource};

const TOP_URL: &str = "https://hacker-news.firebaseio.com/v0/topstories.json";
const ITEM_URL: &str = "https://hacker-news.firebaseio.com/v0/item";
const TAKE: usize = 30;

#[derive(Deserialize)]
struct Item {
    id: u64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    descendants: Option<u32>,
    /// Unix seconds.
    #[serde(default)]
    time: Option<i64>,
    /// "story" / "comment" / ...
    #[serde(default, rename = "type")]
    kind: Option<String>,
}

pub struct HnSource;

#[async_trait]
impl NewsSource for HnSource {
    fn id(&self) -> &'static str { "hn" }
    fn label(&self) -> &'static str { "Hacker News" }

    async fn fetch(&self, client: &Client) -> AppResult<Vec<NewsItem>> {
        let ids: Vec<u64> = client.get(TOP_URL).send().await
            .map_err(|e| AppError::external(format!("HN topstories: {e}")))?
            .json().await
            .map_err(|e| AppError::external(format!("HN topstories json: {e}")))?;

        let mut set: JoinSet<AppResult<Option<NewsItem>>> = JoinSet::new();
        for id in ids.into_iter().take(TAKE) {
            let client = client.clone();
            set.spawn(async move {
                let item: Item = client.get(format!("{ITEM_URL}/{id}.json"))
                    .send().await
                    .map_err(|e| AppError::external(format!("HN item {id}: {e}")))?
                    .json().await
                    .map_err(|e| AppError::external(format!("HN item {id} json: {e}")))?;
                Ok(item_to_news(item))
            });
        }

        let mut out = Vec::with_capacity(TAKE);
        while let Some(j) = set.join_next().await {
            match j {
                Ok(Ok(Some(n))) => out.push(n),
                Ok(Ok(None)) => {}
                Ok(Err(e)) => tracing::warn!(error = %e, "HN item skip"),
                Err(e) => tracing::warn!(error = %e, "HN join error"),
            }
        }
        Ok(out)
    }
}

fn item_to_news(it: Item) -> Option<NewsItem> {
    if it.kind.as_deref() != Some("story") { return None; }
    let title = it.title?;
    let url = it.url.unwrap_or_else(|| format!("https://news.ycombinator.com/item?id={}", it.id));
    let posted_at: DateTime<Utc> = it.time
        .and_then(|t| Utc.timestamp_opt(t, 0).single())
        .unwrap_or_else(Utc::now);
    Some(NewsItem {
        source: "hn".into(),
        external_id: it.id.to_string(),
        title,
        url,
        comments_url: Some(format!("https://news.ycombinator.com/item?id={}", it.id)),
        comment_count: it.descendants,
        posted_at,
    })
}
```

> **주의**: `AppError::external(...)`는 `crate::error::AppError`의 한 variant이어야 함. 만약 이름이 다르면(`AppError::Network`, `AppError::Other` 등) `src-tauri/src/error.rs` 보고 맞게 교체. **다음 세션이 첫 액션에서 `error.rs` 읽고 사용 패턴 확인할 것**(이미 시그널/노션 모듈이 외부 호출 에러를 어떻게 표현하는지 grep).

- [ ] **Step 5.2: cargo check만 (네트워크 테스트는 CI 비포함)**

```bash
rtk proxy cargo check --lib 2>&1 | tail -10
```
Expected: 0 errors.

---

## Task 6 — `geeknews.rs` (RSS)

**Files:**
- Create: `src-tauri/src/news/geeknews.rs`

GeekNews RSS: `https://news.hada.io/rss/news` (또는 `/rss/all` — 다음 세션에서 정확한 endpoint를 한 번 brower로 확인).

- [ ] **Step 6.1: 작성**

```rust
//! GeekNews(news.hada.io) RSS. feed-rs 통합 파서. 댓글 수는 RSS에 없음 → None.

use async_trait::async_trait;
use chrono::Utc;
use feed_rs::parser;
use reqwest::Client;

use crate::error::{AppError, AppResult};
use super::{NewsItem, NewsSource};

const RSS_URL: &str = "https://news.hada.io/rss/news";

pub struct GeekNewsSource;

#[async_trait]
impl NewsSource for GeekNewsSource {
    fn id(&self) -> &'static str { "geeknews" }
    fn label(&self) -> &'static str { "GeekNews" }

    async fn fetch(&self, client: &Client) -> AppResult<Vec<NewsItem>> {
        let bytes = client.get(RSS_URL).send().await
            .map_err(|e| AppError::external(format!("GeekNews fetch: {e}")))?
            .bytes().await
            .map_err(|e| AppError::external(format!("GeekNews bytes: {e}")))?;
        let feed = parser::parse(&bytes[..])
            .map_err(|e| AppError::external(format!("GeekNews parse: {e}")))?;

        Ok(feed.entries.into_iter().filter_map(|e| {
            let title = e.title.as_ref()?.content.clone();
            let url = e.links.first()?.href.clone();
            let external_id = e.id.clone();
            let posted_at = e.published.or(e.updated).unwrap_or_else(Utc::now);
            Some(NewsItem {
                source: "geeknews".into(),
                external_id,
                title,
                url,
                comments_url: None,
                comment_count: None,
                posted_at,
            })
        }).collect())
    }
}
```

- [ ] **Step 6.2: cargo check**

Expected: 0 errors. `feed-rs`가 RSS+Atom 둘 다 파싱.

---

## Task 7 — `lobsters.rs` (JSON)

**Files:**
- Create: `src-tauri/src/news/lobsters.rs`

API: `https://lobste.rs/hottest.json` → array of stories with `short_id`, `title`, `url`, `comments_url`, `comment_count`, `created_at`.

- [ ] **Step 7.1: 작성**

```rust
//! Lobsters hottest.json — title/url/comments_url/comment_count/created_at 모두 한 번에.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use reqwest::Client;
use serde::Deserialize;

use crate::error::{AppError, AppResult};
use super::{NewsItem, NewsSource};

const URL: &str = "https://lobste.rs/hottest.json";

#[derive(Deserialize)]
struct Story {
    short_id: String,
    title: String,
    url: String,
    comments_url: String,
    comment_count: u32,
    created_at: DateTime<Utc>,
}

pub struct LobstersSource;

#[async_trait]
impl NewsSource for LobstersSource {
    fn id(&self) -> &'static str { "lobsters" }
    fn label(&self) -> &'static str { "Lobsters" }

    async fn fetch(&self, client: &Client) -> AppResult<Vec<NewsItem>> {
        let stories: Vec<Story> = client.get(URL).send().await
            .map_err(|e| AppError::external(format!("Lobsters fetch: {e}")))?
            .json().await
            .map_err(|e| AppError::external(format!("Lobsters json: {e}")))?;

        Ok(stories.into_iter().map(|s| NewsItem {
            source: "lobsters".into(),
            external_id: s.short_id,
            title: s.title,
            url: s.url,
            comments_url: Some(s.comments_url),
            comment_count: Some(s.comment_count),
            posted_at: s.created_at,
        }).collect())
    }
}
```

- [ ] **Step 7.2: cargo check**

Expected: 0 errors.

---

## Task 8 — `fetcher.rs` (15분 주기 + bounded retry + 이벤트)

**Files:**
- Create: `src-tauri/src/news/fetcher.rs`

- [ ] **Step 8.1: 작성**

```rust
//! 15분 주기 background fetcher.
//! - scheduler.rs 패턴 답습(`tokio::time::interval` 고정 간격, busy-loop 없음).
//! - 페치당 최대 3회 지수 백오프 + jitter, 모두 실패 시 `news_fetch_failed` 이벤트 발행.
//! - 성공 시 `news_items_updated` 이벤트.
//! - tick 시작에서 7일 만료 cleanup 수행.

use std::time::Duration;

use rand::Rng;
use reqwest::Client;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter};

use crate::state::AppState;
use super::{pref_store, registry, store, NewsSource};

const TICK: Duration = Duration::from_secs(15 * 60);
const REQ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ATTEMPTS: u32 = 3;

#[derive(Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewsFetchFailed {
    pub source: String,
    pub error: String,
}

/// AppHandle setup hook에서 호출. scheduler.rs와 동일 패턴.
pub fn spawn(state: AppState, app: AppHandle) {
    tokio::spawn(async move {
        let client = Client::builder()
            .timeout(REQ_TIMEOUT)
            .user_agent("work-radar/news-fetcher")
            .build()
            .expect("reqwest client");
        let mut ticker = tokio::time::interval(TICK);
        // 최초 즉시 실행 + 이후 15분 주기.
        loop {
            ticker.tick().await;
            if let Err(e) = tick(&state, &app, &client).await {
                tracing::warn!(error = %e, "news fetcher tick failed");
            }
        }
    });
}

async fn tick(state: &AppState, app: &AppHandle, client: &Client) -> crate::error::AppResult<()> {
    let _ = store::purge_expired(state.pool()).await; // 실패 무시(다음 tick 재시도)
    let enabled = pref_store::enabled_ids(state.pool()).await?;
    if enabled.is_empty() { return Ok(()); }

    let mut any_success = false;
    for source in registry() {
        if !enabled.iter().any(|id| id == source.id()) { continue; }
        match fetch_with_retry(&*source, client).await {
            Ok(items) => {
                store::upsert_many(state.pool(), &items).await?;
                any_success = true;
            }
            Err(e) => {
                let _ = app.emit(
                    "news_fetch_failed",
                    NewsFetchFailed {
                        source: source.id().to_string(),
                        error: e.to_string(),
                    },
                );
            }
        }
    }
    if any_success {
        let _ = app.emit("news_items_updated", ());
    }
    Ok(())
}

async fn fetch_with_retry(
    source: &dyn NewsSource,
    client: &Client,
) -> crate::error::AppResult<Vec<super::NewsItem>> {
    let mut delay_ms = 500u64;
    let mut last_err: Option<crate::error::AppError> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        match source.fetch(client).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                tracing::debug!(source = source.id(), attempt, error = %e, "news fetch retry");
                last_err = Some(e);
                if attempt == MAX_ATTEMPTS { break; }
                let jitter = rand::thread_rng().gen_range(0..200);
                tokio::time::sleep(Duration::from_millis(delay_ms + jitter)).await;
                delay_ms = (delay_ms * 2).min(10_000);
            }
        }
    }
    Err(last_err.expect("retry loop sets last_err on failure"))
}
```

- [ ] **Step 8.2: 의존성 확인**

`rand` crate가 이미 있는지 — 없으면 추가:
```bash
rtk proxy cargo add rand 2>&1 | tail -3
```

- [ ] **Step 8.3: cargo check**

Expected: 0 errors. `AppState`의 `pool()` 메서드와 `crate::error::AppError`/`AppResult` 시그니처가 맞는지 — 안 맞으면 grep으로 `signal_store`가 어떻게 쓰는지 보고 동일 패턴.

---

## Task 9 — `commands/news.rs` (tauri-specta IPC)

**Files:**
- Create: `src-tauri/src/commands/news.rs`
- Modify: `src-tauri/src/commands/mod.rs`

- [ ] **Step 9.1: 작성**

```rust
//! tauri-specta IPC commands — news_list_recent / news_sources_available / news_sources_set_enabled.

use specta::Type;

use crate::error::AppResult;
use crate::news::{pref_store, store, NewsItem, NewsSourceMeta};
use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub async fn news_list_recent(state: tauri::State<'_, AppState>, limit: u32) -> AppResult<Vec<NewsItem>> {
    store::list_recent(state.pool(), limit).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_sources_available(state: tauri::State<'_, AppState>) -> AppResult<Vec<NewsSourceMeta>> {
    pref_store::list_available(state.pool()).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_sources_set_enabled(
    state: tauri::State<'_, AppState>,
    source: String,
    enabled: bool,
) -> AppResult<()> {
    pref_store::set_enabled(state.pool(), &source, enabled).await
}

/// fetcher가 발행하는 이벤트 — specta로 타입 노출. 프런트는 listen하면 페이로드 타입 자동.
#[allow(dead_code)]
#[derive(serde::Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewsItemsUpdated; // 페이로드 없음(empty struct)
```

- [ ] **Step 9.2: `commands/mod.rs` 등록**

`src-tauri/src/commands/mod.rs` 끝에 추가:
```rust
pub mod news;
```

- [ ] **Step 9.3: cargo check**

Expected: 0 errors.

---

## Task 10 — `lib.rs`에 모듈 등록 + fetcher spawn + specta builder 등록

**Files:**
- Modify: `src-tauri/src/lib.rs` (또는 `main.rs` — `Builder::default().setup(...)` 있는 곳)

- [ ] **Step 10.1: 모듈 등록**

`src-tauri/src/lib.rs` 상단에 추가:
```rust
mod news;
```
또는 이미 `mod commands;`만 있고 news가 commands 안이라면 추가 mod 선언 불필요. **다음 세션이 lib.rs 보고 정확한 위치 파악**.

- [ ] **Step 10.2: specta builder에 commands 등록**

기존 `Builder::<tauri::Wry>::new().commands(collect_commands![...])` 호출을 찾아 추가:
```rust
commands::news::news_list_recent,
commands::news::news_sources_available,
commands::news::news_sources_set_enabled,
```

- [ ] **Step 10.3: 이벤트 등록**

기존 `events(collect_events![...])` 자리에 추가(없으면 새로):
```rust
news::fetcher::NewsFetchFailed,
commands::news::NewsItemsUpdated,
```

- [ ] **Step 10.4: setup hook에서 fetcher spawn**

```rust
.setup(|app| {
    // ... 기존 setup ...
    let state: tauri::State<AppState> = app.state();
    let s = (*state).clone();   // AppState가 Clone이어야 함 — 기존 패턴 확인
    let h = app.handle().clone();
    news::fetcher::spawn(s, h);
    Ok(())
})
```

- [ ] **Step 10.5: cargo check + bindings 재생성**

```bash
cd /Users/davidpark/private_project/work-radar/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo check --lib 2>&1 | tail -10
```
Expected: 0 errors.

bindings 재생성(specta는 cargo test/build 시 자동 export):
```bash
rtk proxy cargo test --lib --features specta-export 2>&1 | tail -10
# 또는 프로젝트가 사용하는 generate 명령 (CLAUDE.md/AGENTS.md 패턴 확인)
```

`src/bindings.ts`에 `newsListRecent`/`newsSourcesAvailable`/`newsSourcesSetEnabled` + `NewsItem`/`NewsSourceMeta`/`NewsFetchFailed` 타입이 보이면 통과.

---

## Task 11 — 전체 검증 + 커밋

- [ ] **Step 11.1: 풀세트 검증**

```bash
cd /Users/davidpark/private_project/work-radar
export PATH="$HOME/.cargo/bin:$PATH"
rtk tsc --noEmit 2>&1 | tail -5
pnpm lint 2>&1 | tail -10
cd src-tauri && rtk proxy cargo test --lib news:: 2>&1 | tail -15
rtk proxy cargo clippy --lib -- -D warnings 2>&1 | tail -10
```
Expected: 모두 0 errors.

- [ ] **Step 11.2: 수동 확인 (앱 부팅)**

```bash
cd /Users/davidpark/private_project/work-radar
pnpm tauri dev
```
- 로그(콘솔)에 "news fetcher tick failed" 같은 워닝이 첫 15분 내 없는지(첫 즉시 tick 성공해야)
- DB 검사: `sqlite3 ~/Library/Application\ Support/com.work-radar.app/db.sqlite "select count(*), source from news_items group by source;"` — 3개 소스 row 존재해야
- IPC 직접 호출(devtools 콘솔):
  ```js
  await __TAURI__.invoke('news_list_recent', { limit: 5 })
  ```
  → 최신 5건 JSON 반환

- [ ] **Step 11.3: 커밋**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && \
rtk git add -A && \
rtk git commit -m "feat(news): 외부 뉴스 소스 페처 백엔드 (PR B)

신규 src-tauri/src/news/ 모듈:
- NewsSource trait + HnSource/GeekNewsSource/LobstersSource
- store.rs: (source, external_id) UNIQUE upsert + 7일 만료 purge
- pref_store.rs: 소스별 on/off (기본 ON)
- fetcher.rs: 15분 주기 tokio::interval, 페치당 최대 3회 지수
  백오프+jitter, 실패 시 news_fetch_failed 이벤트, 성공 시
  news_items_updated 이벤트
- commands/news.rs: news_list_recent / news_sources_available
  / news_sources_set_enabled (tauri-specta)

DB: 0016_news_items.sql + 0017_news_source_pref.sql

INVARIANT:
- #1 결정 레일 무침투(표시 only — 큐/매트릭스 자동 주입 0)
- #3 dedup upsert
- #5 bounded retry (3회)
- #7 SSOT 분리 (원본=외부, SQLite=캐시)

검증: cargo test news:: pass·clippy 0·typecheck 0·lint 0(49 baseline)·
bindings 재생성 확인."
```

- [ ] **Step 11.4: dev 머지 + push**

```bash
export PATH="$HOME/.cargo/bin:$PATH" && \
rtk git checkout dev && \
rtk git merge --ff-only feat/news-fetcher-pr-b && \
rtk git push origin dev
```

- [ ] **Step 11.5: decisions.md 한 줄**

`docs/decisions.md` 끝에:
```
- **PR B — 뉴스 페처 백엔드 머지**: `src-tauri/src/news/` 신설 — `NewsSource` trait + HN(Firebase JSON)/GeekNews(RSS)/Lobsters(JSON) 3 impls. `news_items` (source, external_id) UNIQUE upsert + 7일 만료 nightly purge. 15분 주기 `tokio::interval` fetcher(첫 tick 즉시 실행), 페치당 최대 3회 지수 백오프+jitter — 실패 시 `news_fetch_failed` 이벤트(소스별), 성공 시 `news_items_updated`. 글로벌 소스 on/off는 `news_source_pref`(기본 ON). IPC 3개: `news_list_recent`/`news_sources_available`/`news_sources_set_enabled` (tauri-specta). 토큰 무관(공개 API/RSS). INVARIANTS: #1 표시 only(큐/매트릭스 자동 주입 0)·#3 dedup upsert·#5 bounded retry·#7 외부 SSOT+SQLite 캐시. 검증: cargo test news:: pass·clippy 0·typecheck 0·lint 0. bindings 재생성. dev push. Follow-up(비차단): GeekNews RSS endpoint 정확성 첫 tick 후 콘솔/DB로 사용자 확인.
```

---

## §9 Self-Review

**1. Spec §5 coverage:**

| spec §5 항목 | task |
|---|---|
| NewsSource trait | Task 2 |
| HN/GeekNews/Lobsters impls | Task 5/6/7 |
| (source, external_id) UNIQUE upsert | Task 1+3 |
| 7일 만료 cleanup | Task 3 (`purge_expired`) |
| 15분 주기 + 지수 백오프 3회 + 이벤트 | Task 8 |
| 글로벌 설정(news_source_pref) | Task 1+4 |
| IPC 3개 + 이벤트 2개 | Task 9+10 |
| INVARIANTS ①/③/⑤/⑦ | 모든 task에 매핑 |

**2. Placeholder scan:** 없음. 모든 step에 실제 코드/명령.

**3. Type consistency:** `AppError`/`AppResult`는 `crate::error`의 기존 타입 사용 — Task 5 §주의에서 다음 세션이 정확한 variant 이름 확인하라고 명시. `AppState.pool()` 시그니처도 마찬가지.

**4. 의존성 가드:**
- `feed-rs`, `rand`(없으면) — `cargo add`로만(Cargo.toml 직접 편집 금지: AGENTS.md 패턴)
- `async-trait`, `reqwest`, `tokio`, `sqlx`, `serde`, `chrono`, `tracing`, `specta`, `tauri-specta` — 이미 존재

**5. 위험:**
- HN Firebase `topstories.json` 응답이 500개 → 30개만 페치하지만 30 HTTP 호출은 부담. `tokio::task::JoinSet` 병렬로 ~1-2초.
- GeekNews RSS endpoint 정확성 미확정 — Step 6.1에서 다음 세션이 한 번 brower로 확인.
- 첫 즉시 tick(`ticker.tick()` 첫 호출은 즉시 반환)이 setup hook 직후 — DB 마이그레이션이 끝났는지 race 가능성. setup hook이 마이그레이션 await 후에 spawn 호출하는지 확인.
- specta-export feature gate가 프로젝트에 어떻게 구성됐는지 — Step 10.5에서 정확한 명령 사용.

**6. 후속(다음 PR):**
- PR C: NewsTicker UI + 설정 다이얼로그 뉴스 섹션 + 빈 상태(소스 0/아이템 0). hover 일시정지 + `prefers-reduced-motion` 폴백(spec §6).

---

## Plan complete

**다음 세션 실행 옵션** (세션 핸드오프):
1. **Subagent-Driven** — task별 fresh subagent + critic 최종 리뷰
2. **Inline Execution** — controller가 직접 실행
3. **Autonomous loop** — 메모리 `work-radar autonomous phase loop` 패턴 (brainstorm 끝났으므로 plan 단계도 끝, 바로 impl→verify→critic→commit→push 루프)

**권장**: PR A에서 검증된 패턴대로 **Inline + 단일 critic 최종 리뷰**가 효율적. 세션 시작 시 사용자에게 한 번 확인 후 진행.
