# 뉴스 커스터마이즈 (소스 확장 + 표시·필터·주기 옵션) Implementation Plan (v3)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **v3 changes vs v2** — ralplan iteration 2(Architect Sound-with-revisions + Critic ITERATE) 후 반영:
> - **R1**: `tokio::time::interval` 생성 직후 `set_missed_tick_behavior(Delay)` 명시(Tokio 기본은 `Burst` — 옵션 churn 후 back-to-back tick 방지, INVARIANT #5 보장).
> - **R6**: `select_next_wake(ticker, notify) -> WakeReason` 헬퍼 추출 → `spawn_loop`와 `notify_wakes_loop_immediately` 통합 테스트 둘 다 같은 helper 호출 → 진짜 production code 경로 검증.
> - **R7**: 변수 `woke_by_notify` → `woke_for_reconfig` 개명(park 안전망 polling도 true이므로 명명 정확화).
> - Minor: `mixed`/`ROW_NUMBER()` 정렬에 `n.external_id DESC` tiebreak 추가(rare 동일 timestamp 결정성).
> - Minor: `every_registry_id_has_resolved_pref` 테스트에 `list_available` 합성 의존성 주석.
> - Minor: `Field`/`SectionLabel` import 경로 명시(`./kit`).
>
> **v2 changes vs v1** — ralplan iteration 1(Architect Sound-with-revisions + Critic ITERATE) 후 반영:
> - **PR 재순서**: ~~D1→D2→D3→D4~~ → **D-Safe(필터) → D-Expand(소스+그룹) → D-Tune(옵션)**. arXiv flood 안전판이 먼저.
> - **D3 fetcher**: `tokio::time::interval` **유지**(drift 보정/MissedTickBehavior 보존) + `tokio::sync::Notify`로 옵션 변경 즉시 적용. `fetch_interval=0`은 진짜 park(Notify만 대기).
> - **`options_store::get`** 멱등 re-seed(`INSERT ON CONFLICT DO NOTHING` then SELECT) + `Default for NewsOptions`.
> - **GenericRssSource**: `published`/`updated` 둘 다 없는 entry는 **drop**(`Utc::now()` 폴백 금지 — 영원히 top 차지 버그).
> - **arXiv HTTPS** (`https://export.arxiv.org/...`), **Reddit per-source UA 헤더**.
> - **SQL**: `&'static str` 절 상수(injection surface 차단), 별칭 일관성(`n.*` everywhere), `mixed` 정렬 tiebreak `rn ASC, source ASC, posted_at DESC`.
> - **`GenericRssSource::TAKE` 캡** (default 30), `news_items(source, posted_at DESC)` 인덱스.
> - **D-Tune 통합 테스트**: `tokio::time::pause` + `advance`로 옵션 변경이 다음 tick 주기에 반영되는지 검증.
> - **각 PR 종료 시**: `decisions.md` 한 줄(통합 1줄 X) + `pnpm tauri dev` 부팅 스모크(AGENTS.md hard gate).
> - **빈 필터 결과 UX 카피** 추가.
> - **Registry-pref 커버리지 assertion**: 모든 `registry()` id가 pref 시드/기본값 일관.

**Goal:** PR B/C에서 깐 뉴스 페처(HN/GeekNews/Lobsters)를 사용자가 ① 더 많은 소스(한글/영문/AI) 중에서 골라, ② 소스별 표시 개수 한도, ③ 키워드 필터(include/exclude), ④ 정렬 기준, ⑤ 갱신 주기를 자기 손으로 설정할 수 있게 한다.

**Architecture:** 백엔드는 `NewsSource` trait 유지 + `GenericRssSource` 어댑터로 RSS 일반화 + `category` 메타 노출. 글로벌 옵션은 단일 row `news_options`, 키워드 필터는 `news_keyword_filters` rows. 페치 주기는 사용자 설정 변경 시 `tokio::sync::Notify`로 fetcher 즉시 깨움(다음 tick 즉시 새 주기). 정렬·필터는 `news_list_recent` SQL에서 적용(SSOT 단일).

**Tech Stack:** Rust 1.80+, sqlx 0.8 (sqlite), feed-rs, tokio (interval+Notify), tauri-specta. 프런트 shadcn `Switch`/`Select`/`Input`/`Button` + 기존 RQ 패턴.

---

## §0 범위·결정

### In scope — **3 PR (재순서)**

1. **D-Safe** (옛 D4): 키워드 필터 — 안전판 먼저. include/exclude rows + chip 에디터. 기존 `list_recent(db, limit)` 시그니처에 `filters` 추가만(옵션은 아직).
2. **D-Expand** (옛 D1+D2): 소스 10개 확장(`GenericRssSource`) + `NewsCategory` 메타 + 설정 화면 카테고리 그룹화. arXiv/Reddit 포함, 모두 default OFF.
3. **D-Tune** (옛 D3): 글로벌 옵션 — 총 한도/소스당 한도/정렬/갱신 주기. fetcher `Notify` 도입. breaking IPC(`news_list_recent` limit 인자 제거).

### Out of scope
- 사용자 정의 RSS URL 입력 (registry는 컴파일 시 고정)
- 즐겨찾기/읽음 상태
- 키워드 매치 강조(highlight)
- 푸시 알림 — INVARIANT #1 무관 명시

### INVARIANTS 가드

| # | 불변식 | 본 plan |
|---|---|---|
| ① | 결정 레일 자동화 금지 | 옵션·필터 모두 **표시만**. 큐/매트릭스 무접근 |
| ② | 외부 mutation Acceptance | read-only — 무관 |
| ③ | dedup upsert | 기존 `(source, external_id)` 그대로 |
| ⑤ | bounded retry | 갱신 주기 floor 5분(0=park, busy-poll 아님). fetcher 재시도 3회 유지 |
| ⑥ | worktree | UI/DB만 — 무관 |
| ⑦ | SSOT 분리 | 옵션·필터 SSOT = 로컬 SQLite. 외부 사이트 원본 SSOT 유지 |

### 소스 카테고리 (D-Expand에서 도입)
```rust
pub enum NewsCategory {
    KoreanTech,   // 한국 기술블로그
    EnglishTech,  // HN/Lobsters/Reddit/dev.to
    AiResearch,   // arXiv
}
```

### D-Expand 신규 소스 (10개)

| id | label | category | endpoint | UA / 비고 |
|---|---|---|---|---|
| reddit_programming | r/programming | EnglishTech | `https://www.reddit.com/r/programming/.rss` | **Reddit UA 필수**: `"work-radar bot/1.0 (+https://github.com/...)"` per-source 헤더 |
| devto | dev.to | EnglishTech | `https://dev.to/feed` | |
| naver_d2 | NAVER D2 | KoreanTech | `https://d2.naver.com/d2.atom` | Atom |
| kakao_tech | 카카오 기술블로그 | KoreanTech | `https://tech.kakao.com/feed/` | |
| woowahan_tech | 우아한형제들 기술블로그 | KoreanTech | `https://techblog.woowahan.com/feed/` | |
| toss_tech | 토스 tech | KoreanTech | `https://toss.tech/rss.xml` | |
| line_engineering | LINE engineering | KoreanTech | `https://engineering.linecorp.com/ko/blog/rss/` | |
| yozm_it | 요즘IT | KoreanTech | `https://yozm.wishket.com/magazine/rss/` | |
| arxiv_cs_lg | arXiv cs.LG | AiResearch | `https://export.arxiv.org/rss/cs.LG` | **HTTPS** |
| arxiv_cs_ai | arXiv cs.AI | AiResearch | `https://export.arxiv.org/rss/cs.AI` | **HTTPS** |

모두 default OFF — `pref_store::list_available`가 행 없으면 ON으로 기본 처리하던 동작은 **변경하지 않음**(기존 hn/geeknews/lobsters는 그대로 ON 유지). 신규 10개는 마이그레이션에서 명시 `enabled=0` 시드 + **registry-pref 커버리지 assertion 테스트**로 누락 방지.

---

## §1 Pre-flight (모든 PR 공통)

- [ ] **dev 최신화**
```bash
cd /Users/davidpark/private_project/work-radar
export PATH="$HOME/.cargo/bin:$PATH"
rtk git fetch origin
rtk git checkout dev && rtk git pull --ff-only
rtk git status -sb         # clean
```

- [ ] **메모리 확인**: `news-ticker-feature-state`, `sqlx-sqlite`, `tauri-specta-ipc`, `work-radar-no-cargo-in-agent-shell`, `rtk-cargo-summary-unreliable`.

---

## §D-Safe — 키워드 필터 (안전판 먼저)

브랜치: `feat/news-d-safe-filter`

### Task S.1 — 마이그레이션 0018 + filter_store

**Files:**
- Create: `src-tauri/migrations/0018_news_keyword_filters.sql`
- Create: `src-tauri/src/news/filter_store.rs`

- [ ] **Step 1: 0018 작성**

```sql
-- 키워드 필터. include 행이 하나라도 있으면 그 중 적어도 하나가 제목에 들어가야 표시(OR).
-- exclude 행은 제목에 들어가면 숨김(AND). 비교는 NOCASE.

CREATE TABLE news_keyword_filters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('include','exclude')),
    UNIQUE (keyword, mode)
) STRICT;
```

- [ ] **Step 2: filter_store.rs 작성**

```rust
//! 키워드 필터 CRUD. include/exclude 모드별 행.
//! 빈 keyword는 validation error로 거부.

use serde::{Deserialize, Serialize};
use specta::Type;

use crate::db::Db;
use crate::error::AppError;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FilterMode {
    Include,
    Exclude,
}

impl FilterMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Include => "include",
            Self::Exclude => "exclude",
        }
    }
    fn parse(s: &str) -> Self {
        if s == "exclude" { Self::Exclude } else { Self::Include }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KeywordFilter {
    pub id: i64,
    pub keyword: String,
    pub mode: FilterMode,
}

pub async fn list(db: &Db) -> Result<Vec<KeywordFilter>, AppError> {
    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT id, keyword, mode FROM news_keyword_filters ORDER BY id",
    )
    .fetch_all(db)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, keyword, mode)| KeywordFilter {
            id,
            keyword,
            mode: FilterMode::parse(&mode),
        })
        .collect())
}

pub async fn add(db: &Db, keyword: &str, mode: FilterMode) -> Result<KeywordFilter, AppError> {
    let kw = keyword.trim();
    if kw.is_empty() {
        return Err(AppError::validation("news.filter.empty", "빈 키워드"));
    }
    // 중복(=같은 keyword/mode) 시도는 그냥 통과(idempotent).
    sqlx::query(
        "INSERT INTO news_keyword_filters(keyword, mode) VALUES (?, ?) \
         ON CONFLICT(keyword, mode) DO NOTHING",
    )
    .bind(kw)
    .bind(mode.as_str())
    .execute(db)
    .await?;
    let row: (i64,) = sqlx::query_as(
        "SELECT id FROM news_keyword_filters WHERE keyword = ? AND mode = ?",
    )
    .bind(kw)
    .bind(mode.as_str())
    .fetch_one(db)
    .await?;
    Ok(KeywordFilter {
        id: row.0,
        keyword: kw.to_string(),
        mode,
    })
}

pub async fn remove(db: &Db, id: i64) -> Result<(), AppError> {
    sqlx::query("DELETE FROM news_keyword_filters WHERE id = ?")
        .bind(id)
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
    async fn add_list_remove_roundtrip() {
        let p = pool().await;
        let a = add(&p, "AI", FilterMode::Include).await.unwrap();
        let b = add(&p, "crypto", FilterMode::Exclude).await.unwrap();
        let list = list(&p).await.unwrap();
        assert_eq!(list.len(), 2);
        remove(&p, a.id).await.unwrap();
        let list = list(&p).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, b.id);
    }

    #[tokio::test]
    async fn add_dedup_returns_existing_row() {
        let p = pool().await;
        let a = add(&p, "AI", FilterMode::Include).await.unwrap();
        let b = add(&p, "AI", FilterMode::Include).await.unwrap();
        assert_eq!(a.id, b.id, "같은 (keyword, mode)는 같은 row");
        assert_eq!(list(&p).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn add_empty_keyword_validation_err() {
        let p = pool().await;
        assert!(add(&p, "   ", FilterMode::Include).await.is_err());
    }

    #[tokio::test]
    async fn add_trims_whitespace() {
        let p = pool().await;
        let a = add(&p, "  AI  ", FilterMode::Include).await.unwrap();
        assert_eq!(a.keyword, "AI");
    }
}
```

`src-tauri/src/news/mod.rs`에 등록:
```rust
pub mod filter_store;
```

### Task S.2 — `store::list_recent`에 필터 인자 추가

**Files:**
- Modify: `src-tauri/src/news/store.rs`

⚠️ D-Safe 시점에는 옵션 시스템이 없으므로 시그니처는 `list_recent(db, limit, filters)` — D-Tune에서 다시 `(db, opts, filters)`로 한 번 더 변경.

- [ ] **Step 1: SQL 절 빌더 (`&'static str` 상수 + bind만 사용)**

```rust
use super::filter_store::{FilterMode, KeywordFilter};

/// 비-2xx 위험 절은 항상 `&'static str` 상수(injection surface 0). 값은 `?`+bind만.
const INCLUDE_FRAGMENT: &str = "n.title LIKE ? COLLATE NOCASE";
const EXCLUDE_FRAGMENT: &str = "n.title NOT LIKE ? COLLATE NOCASE";

pub async fn list_recent(
    db: &Db,
    limit: u32,
    filters: &[KeywordFilter],
) -> Result<Vec<NewsItem>, AppError> {
    let includes: Vec<&KeywordFilter> = filters.iter().filter(|f| f.mode == FilterMode::Include).collect();
    let excludes: Vec<&KeywordFilter> = filters.iter().filter(|f| f.mode == FilterMode::Exclude).collect();

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

    // SAFETY: SortMode 절(D-Tune)·필터 fragment는 모두 closed-set `&'static str`. 동적 값은 ?로만.
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
        q = q.bind(format!("%{}%", kw.keyword));
    }
    for kw in &excludes {
        q = q.bind(format!("%{}%", kw.keyword));
    }
    q = q.bind(limit as i64);

    let rows = q.fetch_all(db).await?;
    Ok(rows.into_iter().map(Into::into).collect())
}
```

- [ ] **Step 2: 기존 테스트 시그니처 + 신규 필터 테스트 (정수 케이스 포함)**

`item` helper를 `(source, id, title)` 3-arg로 변경:
```rust
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
```

기존 `upsert_dedup_keeps_latest_title` / `list_recent_excludes_disabled_sources` / `purge_removes_old`는 호출만 `list_recent(&p, 10, &[])`로 수정.

신규 테스트:
```rust
#[tokio::test]
async fn include_filter_keeps_only_matching() {
    let p = pool().await;
    upsert_many(&p, &[
        item("hn", "1", "AI breakthrough"),
        item("hn", "2", "Crypto crashes"),
        item("hn", "3", "Tauri 2 released"),
    ]).await.unwrap();
    let filters = vec![KeywordFilter { id: 1, keyword: "AI".into(), mode: FilterMode::Include }];
    let rows = list_recent(&p, 10, &filters).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].external_id, "1");
}

#[tokio::test]
async fn exclude_filter_removes_matching() {
    let p = pool().await;
    upsert_many(&p, &[
        item("hn", "1", "AI breakthrough"),
        item("hn", "2", "Crypto crashes"),
        item("hn", "3", "Tauri 2 released"),
    ]).await.unwrap();
    let filters = vec![KeywordFilter { id: 1, keyword: "crypto".into(), mode: FilterMode::Exclude }];
    let rows = list_recent(&p, 10, &filters).await.unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
    assert_eq!(ids.len(), 2);
    assert!(!ids.contains(&"2"));
}

#[tokio::test]
async fn include_or_logic_multiple_keywords() {
    let p = pool().await;
    upsert_many(&p, &[
        item("hn", "1", "AI news"),
        item("hn", "2", "Rust 1.90"),
        item("hn", "3", "Web design"),
    ]).await.unwrap();
    let filters = vec![
        KeywordFilter { id: 1, keyword: "AI".into(), mode: FilterMode::Include },
        KeywordFilter { id: 2, keyword: "Rust".into(), mode: FilterMode::Include },
    ];
    let rows = list_recent(&p, 10, &filters).await.unwrap();
    assert_eq!(rows.len(), 2);
    let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
    assert!(ids.contains(&"1") && ids.contains(&"2"));
}

#[tokio::test]
async fn include_and_exclude_combined() {
    let p = pool().await;
    upsert_many(&p, &[
        item("hn", "1", "AI breakthrough"),
        item("hn", "2", "AI crypto coin"),
        item("hn", "3", "Crypto crashes"),
    ]).await.unwrap();
    let filters = vec![
        KeywordFilter { id: 1, keyword: "AI".into(), mode: FilterMode::Include },
        KeywordFilter { id: 2, keyword: "crypto".into(), mode: FilterMode::Exclude },
    ];
    let rows = list_recent(&p, 10, &filters).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].external_id, "1", "include='AI' AND exclude='crypto' → '1'만");
}

#[tokio::test]
async fn case_insensitive_match() {
    let p = pool().await;
    upsert_many(&p, &[item("hn", "1", "Rust 1.90")]).await.unwrap();
    let filters = vec![KeywordFilter { id: 1, keyword: "RUST".into(), mode: FilterMode::Include }];
    let rows = list_recent(&p, 10, &filters).await.unwrap();
    assert_eq!(rows.len(), 1);
}
```

`pool()` 헬퍼는 기존 그대로 + 테스트 hn 시드도 그대로(기존 코드).

### Task S.3 — IPC + 프런트 chip 에디터

**Files:**
- Modify: `src-tauri/src/commands/news.rs`
- Modify: `src-tauri/src/lib.rs` (collect_commands)
- Modify: `src/lib/query/news.ts`
- Modify: `src/components/settings/NewsSourceSettings.tsx`
- Modify: `src/components/news/NewsTicker.tsx` (빈 필터 결과 안내)

- [ ] **Step 1: commands**

```rust
use crate::news::filter_store::{self, FilterMode, KeywordFilter};

#[tauri::command]
#[specta::specta]
pub async fn news_list_recent(
    db: State<'_, Db>,
    limit: u32,
) -> Result<Vec<NewsItem>, AppError> {
    let filters = filter_store::list(db.inner()).await?;
    store::list_recent(db.inner(), limit, &filters).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_list_filters(db: State<'_, Db>) -> Result<Vec<KeywordFilter>, AppError> {
    filter_store::list(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_add_filter(
    db: State<'_, Db>,
    keyword: String,
    mode: FilterMode,
) -> Result<KeywordFilter, AppError> {
    filter_store::add(db.inner(), &keyword, mode).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_remove_filter(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    filter_store::remove(db.inner(), id).await
}
```

`lib.rs` `collect_commands![...]`에 `news_list_filters`/`news_add_filter`/`news_remove_filter` 3개 추가.

- [ ] **Step 2: RQ 훅**

`src/lib/query/news.ts`에 추가:
```ts
import type { FilterMode, KeywordFilter } from "@/bindings";

export function useNewsFilters() {
  return useQuery({
    queryKey: ["newsFilters"],
    queryFn: () => unwrap(commands.newsListFilters()),
    retry: false,
  });
}

export function useAddNewsFilter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ keyword, mode }: { keyword: string; mode: FilterMode }) =>
      unwrap(commands.newsAddFilter(keyword, mode)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["newsFilters"] });
      void qc.invalidateQueries({ queryKey: ["newsList"] });
    },
  });
}

export function useRemoveNewsFilter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => unwrap(commands.newsRemoveFilter(id)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["newsFilters"] });
      void qc.invalidateQueries({ queryKey: ["newsList"] });
    },
  });
}
```

- [ ] **Step 3: `NewsTicker.tsx` 빈 상태 분기 보강**

```tsx
// 기존 빈 상태 다음에 분기 추가:
const filters = useNewsFilters();   // hook 추가
const hasFilters = (filters.data ?? []).length > 0;

if (items.length === 0) {
  return (
    <div className="news-ticker is-empty">
      {hasFilters
        ? "필터에 매치되는 뉴스가 없습니다 — 설정에서 키워드 조정"
        : "뉴스 소스가 꺼져 있거나 아직 수신된 항목이 없습니다 — 설정 → 뉴스에서 선택"}
    </div>
  );
}
```

- [ ] **Step 4: `NewsSourceSettings.tsx`에 `NewsFiltersForm` 섹션 추가**

기존 소스 토글 위/아래에 추가:
```tsx
import { X } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import {
  useNewsFilters, useAddNewsFilter, useRemoveNewsFilter,
} from "@/lib/query/news";
import type { FilterMode, KeywordFilter } from "@/bindings";

function NewsFiltersForm({ onToast }: { onToast: (msg: string) => void }) {
  const q = useNewsFilters();
  const add = useAddNewsFilter();
  const remove = useRemoveNewsFilter();
  const [kw, setKw] = useState("");
  const [mode, setMode] = useState<FilterMode>("include");

  const submit = () => {
    const trimmed = kw.trim();
    if (!trimmed) return;
    add.mutate(
      { keyword: trimmed, mode },
      {
        onSuccess: () => {
          setKw("");
          onToast(`${mode === "include" ? "포함" : "제외"} 키워드 추가: ${trimmed}`);
        },
      },
    );
  };

  const list = q.data ?? [];
  const includes = list.filter((f) => f.mode === "include");
  const excludes = list.filter((f) => f.mode === "exclude");

  return (
    <section className="rounded-xl border border-border p-4 flex flex-col gap-3">
      <SectionLabel>키워드 필터</SectionLabel>
      <div className="flex gap-2">
        <Input
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
          }}
          placeholder="예: AI, Rust, crypto"
          className="flex-1"
        />
        <Select value={mode} onValueChange={(v) => setMode(v as FilterMode)}>
          <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="include">포함</SelectItem>
            <SelectItem value="exclude">제외</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={submit} disabled={!kw.trim() || add.isPending}>추가</Button>
      </div>
      <p className="text-xs text-muted-foreground">
        포함: 적어도 하나의 키워드를 포함한 제목만 표시(OR). 제외: 이 키워드를 포함한 제목 숨김(AND).
        대소문자 무관, 부분 일치. 빈 리스트면 전체 표시.
      </p>
      {includes.length > 0 && (
        <div>
          <SectionLabel className="mb-1.5">포함</SectionLabel>
          <ChipList list={includes} onRemove={(id) => remove.mutate(id)} />
        </div>
      )}
      {excludes.length > 0 && (
        <div>
          <SectionLabel className="mb-1.5">제외</SectionLabel>
          <ChipList list={excludes} onRemove={(id) => remove.mutate(id)} />
        </div>
      )}
    </section>
  );
}

function ChipList({
  list, onRemove,
}: {
  list: KeywordFilter[];
  onRemove: (id: number) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((f) => (
        <span
          key={f.id}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs"
        >
          {f.keyword}
          <button
            type="button"
            onClick={() => onRemove(f.id)}
            aria-label={`${f.keyword} 제거`}
            className="rounded-full p-0.5 hover:bg-hover"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}
```

JSX에서 카테고리 토글 섹션 **위**에 `<NewsFiltersForm onToast={onToast} />`. (D-Expand가 카테고리 그룹화 도입할 때도 동일 위치 유지.)

### Task S.4 — 검증 + 부팅 스모크 + 커밋

- [ ] **Step 1: 풀세트**

```bash
cd /Users/davidpark/private_project/work-radar/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo test --lib news:: 2>&1 | tail -15
rtk proxy cargo clippy --lib --tests -- -D warnings 2>&1 | tail -5
rtk proxy cargo test --lib bindings_export 2>&1 | tail -5
cd .. && rtk tsc --noEmit 2>&1 | tail -3
pnpm lint 2>&1 | grep -E "ESLint:"
grep -q "KeywordFilter" src/bindings.ts && echo "bindings OK" || echo "bindings MISSING"
```
Expected: 모두 0 errors. `KeywordFilter`/`FilterMode` 노출.

- [ ] **Step 2: `pnpm tauri dev` 부팅 스모크 (AGENTS.md hard gate)**

```bash
pnpm tauri dev
```
수동 체크:
- 설정 → 뉴스 → 키워드 필터 섹션 보임
- "Rust" include 추가 → 티커가 Rust 포함 제목만 보임
- 빈 매치 시 "필터에 매치되는 뉴스가 없습니다" 안내
- 키워드 칩 X 클릭 → 제거 + 티커 갱신

- [ ] **Step 3: decisions.md 한 줄**

```
- **PR D-Safe — 뉴스 키워드 필터 머지(2026-05-25)**: `news_keyword_filters` rows(include/exclude×UNIQUE) + filter_store CRUD + IPC 3개(`newsListFilters`/`newsAddFilter`/`newsRemoveFilter`). `store::list_recent`에 `filters` 인자 추가 — include OR, exclude AND, `LIKE '%kw%' COLLATE NOCASE` + bind(injection 차단). 빈 매치 UX 카피 추가. INVARIANT #1 표시-only 유지(필터는 표시 필터일 뿐). 검증: cargo test news:: pass(필터 5건+기존)·clippy 0·typecheck 0·lint 49 baseline·`pnpm tauri dev` 부팅 스모크 통과. dev push.
```

- [ ] **Step 4: 커밋 + dev 머지 + push**

```bash
rtk git add -A && rtk git commit -m "feat(news): 키워드 필터 include/exclude (D-Safe)

news_keyword_filters + filter_store CRUD + IPC 3개. store::list_recent
이 filters 받아 SQL WHERE LIKE '%kw%' COLLATE NOCASE 적용(include OR,
exclude AND). 클로저는 closed-set 'static str fragment + bind(injection
차단). 빈 매치 UX 카피('필터에 매치되는 뉴스가 없습니다').

INVARIANT #1 표시-only 유지. 검증: cargo test news:: pass · clippy 0
· typecheck 0 · lint 49 baseline · pnpm tauri dev 부팅 스모크."
rtk git checkout dev && rtk git merge --ff-only feat/news-d-safe-filter && rtk git push origin dev
```

---

## §D-Expand — 소스 10개 확장 + 카테고리 + 설정 그룹화

브랜치: `feat/news-d-expand-sources-and-grouping`

### Task E.1 — `NewsCategory` enum + trait 메서드

**Files:**
- Modify: `src-tauri/src/news/mod.rs`

- [ ] **Step 1: 새 타입 + trait 시그니처 + meta 필드**

`mod.rs` 상단에 추가:
```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub enum NewsCategory {
    KoreanTech,
    EnglishTech,
    AiResearch,
}
```

`NewsSource` trait에 `fn category(&self) -> NewsCategory;` 추가.

`NewsSourceMeta`에 필드 추가:
```rust
pub struct NewsSourceMeta {
    pub id: String,
    pub label: String,
    pub category: NewsCategory,    // ← 추가
    pub enabled: bool,
}
```

- [ ] **Step 2: 기존 3개 impl + pref_store에 category 전달**

`hn.rs`: `fn category(&self) -> super::NewsCategory { super::NewsCategory::EnglishTech }`
`geeknews.rs`: `KoreanTech`
`lobsters.rs`: `EnglishTech`

`pref_store::list_available`:
```rust
out.push(NewsSourceMeta {
    label: src.label().to_string(),
    id: id.clone(),
    category: src.category(),   // ← 추가
    enabled,
});
```
`use super::NewsCategory;` import 필요한지 컴파일러 가이드 따름.

### Task E.2 — `GenericRssSource` 어댑터 (timestamp `?` + UA 헤더 + TAKE 캡)

**Files:**
- Create: `src-tauri/src/news/rss_generic.rs`

```rust
//! 일반 RSS/Atom 소스 어댑터. `feed-rs`로 통합 파싱. NewsCategory + 선택 헤더 지원.
//!
//! 정책(critic feedback 반영):
//! - `published`/`updated` 둘 다 없는 entry는 **drop**(Utc::now() 폴백 금지 — 영원히
//!   top 차지 회귀 방지).
//! - per-source `TAKE` 캡(default 30) — arXiv처럼 한 번에 100+ 보내는 소스가 DB와
//!   ticker를 독점하지 못하게.
//! - `headers`로 Reddit 같이 UA 강제하는 소스만 override(보안: build-time 상수만).

use async_trait::async_trait;
use feed_rs::parser;
use reqwest::{header::HeaderMap, header::HeaderName, header::HeaderValue, Client};

use super::{http_bytes, NewsCategory, NewsItem, NewsSource};
use crate::error::AppError;

const DEFAULT_TAKE: usize = 30;

pub struct GenericRssSource {
    pub id: &'static str,
    pub label: &'static str,
    pub url: &'static str,
    pub category: NewsCategory,
    /// Optional per-source HTTP headers (예: Reddit UA override). build-time 상수 only.
    pub headers: &'static [(&'static str, &'static str)],
    /// 한 페치당 take 최대. 0이면 DEFAULT_TAKE.
    pub take: usize,
}

#[async_trait]
impl NewsSource for GenericRssSource {
    fn id(&self) -> &'static str { self.id }
    fn label(&self) -> &'static str { self.label }
    fn category(&self) -> NewsCategory { self.category }

    async fn fetch(&self, client: &Client) -> Result<Vec<NewsItem>, AppError> {
        let take = if self.take == 0 { DEFAULT_TAKE } else { self.take };
        let mut req = client.get(self.url);
        if !self.headers.is_empty() {
            let mut map = HeaderMap::with_capacity(self.headers.len());
            for (k, v) in self.headers {
                // 정적 상수 → unwrap OK(컴파일 시 검증). 실패는 burnt-in 버그.
                let name = HeaderName::from_static(k);
                let value = HeaderValue::from_static(v);
                map.insert(name, value);
            }
            req = req.headers(map);
        }
        let resp = req.send().await?;
        let bytes = http_bytes(resp, &format!("rss.{}", self.id)).await?;
        let feed = parser::parse(&bytes[..])
            .map_err(|e| AppError::transient(format!("rss.{}.parse", self.id), e.to_string()))?;
        let id = self.id;
        Ok(feed.entries.into_iter().take(take).filter_map(|e| {
            let title = e.title.as_ref()?.content.clone();
            let url = e.links.first()?.href.clone();
            let external_id = e.id.clone();
            // critic Critical: 둘 다 없으면 drop. Utc::now() 폴백 절대 금지.
            let posted_at = e.published.or(e.updated)?;
            Some(NewsItem {
                source: id.to_string(),
                external_id,
                title,
                url,
                comments_url: None,
                comment_count: None,
                posted_at: posted_at.to_rfc3339(),
            })
        }).collect())
    }
}
```

`mod.rs`에 `pub mod rss_generic;` 등록.

### Task E.3 — registry 확장(10 소스) + 마이그레이션 0019 default OFF

**Files:**
- Modify: `src-tauri/src/news/mod.rs` (registry)
- Create: `src-tauri/migrations/0019_news_source_pref_default_off.sql`
- Modify: `src-tauri/src/news/store.rs` (index 추가 — 아래 Task E.4에서 처리)

- [ ] **Step 1: registry()**

```rust
pub fn registry() -> Vec<Box<dyn NewsSource>> {
    use rss_generic::GenericRssSource;
    use NewsCategory::*;
    const REDDIT_HEADERS: &[(&str, &str)] = &[
        ("user-agent", "work-radar/1.0 (https://github.com/work-radar)"),
    ];
    const NO_HEADERS: &[(&str, &str)] = &[];
    vec![
        Box::new(hn::HnSource),
        Box::new(geeknews::GeekNewsSource),
        Box::new(lobsters::LobstersSource),

        // 영문 추가(default OFF).
        Box::new(GenericRssSource {
            id: "reddit_programming", label: "r/programming", category: EnglishTech,
            url: "https://www.reddit.com/r/programming/.rss",
            headers: REDDIT_HEADERS, take: 0,
        }),
        Box::new(GenericRssSource {
            id: "devto", label: "dev.to", category: EnglishTech,
            url: "https://dev.to/feed",
            headers: NO_HEADERS, take: 0,
        }),

        // 한글(default OFF).
        Box::new(GenericRssSource {
            id: "naver_d2", label: "NAVER D2", category: KoreanTech,
            url: "https://d2.naver.com/d2.atom",
            headers: NO_HEADERS, take: 0,
        }),
        Box::new(GenericRssSource {
            id: "kakao_tech", label: "카카오 기술블로그", category: KoreanTech,
            url: "https://tech.kakao.com/feed/",
            headers: NO_HEADERS, take: 0,
        }),
        Box::new(GenericRssSource {
            id: "woowahan_tech", label: "우아한형제들 기술블로그", category: KoreanTech,
            url: "https://techblog.woowahan.com/feed/",
            headers: NO_HEADERS, take: 0,
        }),
        Box::new(GenericRssSource {
            id: "toss_tech", label: "토스 tech", category: KoreanTech,
            url: "https://toss.tech/rss.xml",
            headers: NO_HEADERS, take: 0,
        }),
        Box::new(GenericRssSource {
            id: "line_engineering", label: "LINE engineering", category: KoreanTech,
            url: "https://engineering.linecorp.com/ko/blog/rss/",
            headers: NO_HEADERS, take: 0,
        }),
        Box::new(GenericRssSource {
            id: "yozm_it", label: "요즘IT", category: KoreanTech,
            url: "https://yozm.wishket.com/magazine/rss/",
            headers: NO_HEADERS, take: 0,
        }),

        // AI/ML — HTTPS (critic 지적).
        Box::new(GenericRssSource {
            id: "arxiv_cs_lg", label: "arXiv cs.LG", category: AiResearch,
            url: "https://export.arxiv.org/rss/cs.LG",
            headers: NO_HEADERS, take: 0,
        }),
        Box::new(GenericRssSource {
            id: "arxiv_cs_ai", label: "arXiv cs.AI", category: AiResearch,
            url: "https://export.arxiv.org/rss/cs.AI",
            headers: NO_HEADERS, take: 0,
        }),
    ]
}
```

- [ ] **Step 2: 0019 작성**

```sql
-- 신규 소스(D-Expand)는 default OFF로 시드 — 사용자가 설정에서 켜야 노출.
-- 기존 hn/geeknews/lobsters는 건드리지 않음(이미 default ON 동작).
-- ON CONFLICT DO NOTHING → 사용자가 이미 켰다면 그 상태 보존(멱등 재실행 안전).

INSERT INTO news_source_pref(source, enabled) VALUES
    ('reddit_programming', 0),
    ('devto', 0),
    ('naver_d2', 0),
    ('kakao_tech', 0),
    ('woowahan_tech', 0),
    ('toss_tech', 0),
    ('line_engineering', 0),
    ('yozm_it', 0),
    ('arxiv_cs_lg', 0),
    ('arxiv_cs_ai', 0)
ON CONFLICT(source) DO NOTHING;
```

- [ ] **Step 3: registry 무결성 테스트 (mod.rs `#[cfg(test)] mod tests`에 추가)**

```rust
#[test]
fn registry_ids_are_unique() {
    let all: Vec<&str> = registry().iter().map(|s| s.id()).collect();
    let uniq: std::collections::HashSet<&str> = all.iter().copied().collect();
    assert_eq!(all.len(), uniq.len(), "registry 중복 id: {:?}", all);
}

#[test]
fn registry_covers_all_categories() {
    let cats: std::collections::HashSet<NewsCategory> =
        registry().iter().map(|s| s.category()).collect();
    assert!(cats.contains(&NewsCategory::KoreanTech));
    assert!(cats.contains(&NewsCategory::EnglishTech));
    assert!(cats.contains(&NewsCategory::AiResearch));
}

#[tokio::test]
async fn every_registry_id_has_resolved_pref() {
    // critic blocker: registry에 추가하고 마이그레이션 seed를 빠뜨리면 silent default-ON 회귀.
    //
    // NOTE(v3 minor): 이 등식이 성립하는 이유는 `pref_store::list_available`이 DB에 행이
    // 없으면 default ON으로 meta를 *합성*하기 때문(`saved.get(...).unwrap_or(true)`).
    // 향후 누군가 `list_available`을 "seeded rows만 반환"으로 바꾸면 기존 hn/geeknews/
    // lobsters 3개가 default-ON 동작을 잃으면서 이 테스트도 깨진다 — 그 회귀를 보호하는
    // 의도된 coupling.
    let p = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&p).await.unwrap();
    let avail = crate::news::pref_store::list_available(&p).await.unwrap();
    let pref_ids: std::collections::HashSet<&str> =
        avail.iter().map(|m| m.id.as_str()).collect();
    let reg_ids: std::collections::HashSet<&str> =
        registry().iter().map(|s| s.id()).collect();
    assert_eq!(pref_ids, reg_ids, "registry vs pref 불일치 → seed 누락 가능성");
}

#[tokio::test]
async fn new_sources_default_off_after_0019() {
    let p = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&p).await.unwrap();
    let avail = crate::news::pref_store::list_available(&p).await.unwrap();
    let by_id: std::collections::HashMap<String, bool> =
        avail.into_iter().map(|m| (m.id, m.enabled)).collect();
    assert_eq!(by_id.get("hn"), Some(&true));
    assert_eq!(by_id.get("geeknews"), Some(&true));
    assert_eq!(by_id.get("lobsters"), Some(&true));
    assert_eq!(by_id.get("reddit_programming"), Some(&false));
    assert_eq!(by_id.get("arxiv_cs_lg"), Some(&false));
}

#[tokio::test]
async fn migration_0019_idempotent_preserves_user_changes() {
    let p = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
    sqlx::migrate!("./migrations").run(&p).await.unwrap();
    // 사용자가 reddit_programming을 켰다고 가정.
    sqlx::query("UPDATE news_source_pref SET enabled=1 WHERE source='reddit_programming'")
        .execute(&p).await.unwrap();
    // 마이그레이션을 같은 풀에 한 번 더 시도 — sqlx::migrate!는 멱등.
    sqlx::migrate!("./migrations").run(&p).await.unwrap();
    let r: (i64,) = sqlx::query_as(
        "SELECT enabled FROM news_source_pref WHERE source='reddit_programming'"
    ).fetch_one(&p).await.unwrap();
    assert_eq!(r.0, 1, "사용자가 켠 상태가 마이그레이션에 의해 덮어쓰여지지 않음");
}
```

기존 `pref_store::tests::default_enabled_true_for_all` → `defaults_existing_three_on_new_off`로 갱신(D-Safe 머지 후 기준).

### Task E.4 — 인덱스 추가 (성능)

**Files:**
- Modify: `src-tauri/migrations/0019_news_source_pref_default_off.sql` (위 0019에 같은 파일 안에서 추가)

⚠️ 단일 마이그레이션에서 두 가지 변경 — DDL: `CREATE INDEX IF NOT EXISTS` + DML seed. 안전.

추가 SQL:
```sql
-- 성능: list_recent의 ORDER BY n.posted_at + 필터 JOIN.
-- 7일 TTL × 13 소스 × ~30/소스 = ~2700 rows 예상이지만 인덱스로 안전 마진.
CREATE INDEX IF NOT EXISTS idx_news_items_source_posted
    ON news_items(source, posted_at DESC);
```

### Task E.5 — 설정 화면 카테고리 그룹화

**Files:**
- Modify: `src/components/settings/NewsSourceSettings.tsx`

D-Safe에서 추가한 `<NewsFiltersForm />` 위에/아래에 카테고리 그룹 섹션 — 평면 리스트 → 카테고리별 섹션 + 접기/펴기 + "이 카테고리 전부 ON/OFF".

```tsx
import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { NewsCategory, NewsSourceMeta } from "@/bindings";

const CATEGORY_LABEL: Record<NewsCategory, string> = {
  koreanTech: "한글 기술블로그",
  englishTech: "영문 기술",
  aiResearch: "AI/ML 연구",
};
const CATEGORY_ORDER: NewsCategory[] = ["koreanTech", "englishTech", "aiResearch"];

// ... 기존 NewsSourceSettings 본체에서 평면 div.divide-y 부분을
//     아래 카테고리 그룹 로직으로 교체. NewsFiltersForm는 그대로 유지.
```

상세 JSX (D-Safe에서 만든 컴포넌트 안에 통합):
```tsx
export function NewsSourceSettings({ onToast }: { onToast: (msg: string) => void }) {
  const sources = useNewsSources();
  const setEnabled = useSetNewsSourceEnabled();
  const { pushError } = useToastStore();
  const [collapsed, setCollapsed] = useState<Set<NewsCategory>>(new Set());

  const grouped = useMemo(() => {
    const out: Record<NewsCategory, NewsSourceMeta[]> = {
      koreanTech: [], englishTech: [], aiResearch: [],
    };
    (sources.data ?? []).forEach((s) => out[s.category].push(s));
    return out;
  }, [sources.data]);

  const toggleCollapsed = (c: NewsCategory) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };

  const setCategoryAll = (cat: NewsCategory, enabled: boolean) => {
    grouped[cat].forEach((src) => {
      if (src.enabled !== enabled) {
        setEnabled.mutate(
          { source: src.id, enabled },
          { onError: () => pushError("news", `${src.label} 토글 실패`) },
        );
      }
    });
    onToast(`${CATEGORY_LABEL[cat]} ${enabled ? "전부 켰습니다" : "전부 껐습니다"}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <NewsFiltersForm onToast={onToast} />

      <SectionLabel>뉴스 소스</SectionLabel>
      {sources.isLoading && <div className="text-sm text-muted-foreground">불러오는 중…</div>}
      {sources.isError && (
        <div className="text-sm text-[color:var(--destructive)]">
          소스 목록 로드 실패: {String(sources.error)}
        </div>
      )}
      {sources.data && CATEGORY_ORDER.map((cat) => {
        const list = grouped[cat];
        if (list.length === 0) return null;
        const isCollapsed = collapsed.has(cat);
        const onCount = list.filter((s) => s.enabled).length;
        return (
          <section key={cat} className="rounded-xl border border-border">
            <header className="flex items-center justify-between gap-3 px-4 py-2.5">
              <button
                type="button"
                onClick={() => toggleCollapsed(cat)}
                className="flex items-center gap-2 text-[13px] font-medium text-foreground"
              >
                {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                {CATEGORY_LABEL[cat]}
                <span className="text-xs text-muted-foreground">{onCount}/{list.length}</span>
              </button>
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setCategoryAll(cat, true)}>전부 ON</Button>
                <Button variant="ghost" size="sm" onClick={() => setCategoryAll(cat, false)}>전부 OFF</Button>
              </div>
            </header>
            {!isCollapsed && (
              <div className="flex flex-col divide-y divide-border border-t border-border">
                {list.map((src) => (
                  <label key={src.id} htmlFor={`news-src-${src.id}`}
                         className="flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5">
                    <span className="text-[13px] text-foreground">{src.label}</span>
                    <Switch
                      id={`news-src-${src.id}`}
                      checked={src.enabled}
                      disabled={setEnabled.isPending}
                      onCheckedChange={(checked) =>
                        setEnabled.mutate(
                          { source: src.id, enabled: checked },
                          {
                            onSuccess: () => onToast(`${src.label} ${checked ? "켰습니다" : "껐습니다"}`),
                            onError: () => pushError("news", `${src.label} 토글 실패`),
                          },
                        )
                      }
                    />
                  </label>
                ))}
              </div>
            )}
          </section>
        );
      })}
      <p className="text-xs text-muted-foreground">
        15분마다 백그라운드에서 갱신 — 토글/필터 변경은 다음 페치부터 반영.
      </p>
    </div>
  );
}
```

### Task E.6 — 검증 + 부팅 스모크 + 커밋

- [ ] **Step 1: 풀세트**

```bash
cd /Users/davidpark/private_project/work-radar/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo test --lib news:: 2>&1 | tail -20
rtk proxy cargo clippy --lib --tests -- -D warnings 2>&1 | tail -5
rtk proxy cargo test --lib bindings_export 2>&1 | tail -5
cd .. && rtk tsc --noEmit 2>&1 | tail -3
pnpm lint 2>&1 | grep -E "ESLint:"
grep -q "NewsCategory" src/bindings.ts && echo "category OK" || echo "MISSING"
```
Expected: 모든 news:: 테스트 pass(D-Safe 5 + 기존 8 classify + pref_store + store + registry 4건 ≈ 20+). clippy 0. typecheck 0. lint 49 baseline.

- [ ] **Step 2: `pnpm tauri dev` 부팅 스모크**

수동 체크:
- 설정 → 뉴스: 3개 카테고리 섹션 보임. 기본 ON은 기존 3개만. 신규 10개 OFF.
- 카테고리 펴기/접기 동작.
- "전부 ON" → 그 카테고리만 켜짐.
- 새 소스 하나 켜고 15분 기다리거나 수동 트리거(devtools `await __TAURI__.invoke("news_list_recent", { limit: 30 })`)로 그 소스 아이템 도착.

- [ ] **Step 3: decisions.md 한 줄**

```
- **PR D-Expand — 뉴스 소스 10개 + 카테고리 + 그룹 UI 머지(2026-05-25)**: `GenericRssSource { id, label, url, category, headers, take }` 어댑터로 NAVER D2/카카오/우아한형제들/토스/LINE/요즘IT/r/programming/dev.to/arXiv cs.LG/cs.AI 등록(모두 default OFF, 0019 마이그). `NewsCategory(KoreanTech/EnglishTech/AiResearch)` enum + trait + Meta. arXiv는 HTTPS, Reddit은 per-source UA 헤더. published/updated 없는 entry는 drop(Utc::now 폴백 금지 — 영원히 top 차지 버그 방지). 한 페치당 TAKE=30 캡(arXiv 100건 독점 방지). 설정 화면을 카테고리별 접기/펴기 + 전부 ON/OFF로 그룹화. `news_items(source, posted_at DESC)` 인덱스 추가. INVARIANT 무관(표시 추가만). 검증: cargo test news:: pass(registry 무결성 4건 + idempotency 1건 신규)·clippy 0·typecheck 0·lint 49 baseline·`pnpm tauri dev` 스모크.
```

- [ ] **Step 4: 커밋 + dev 머지 + push**

```bash
rtk git add -A && rtk git commit -m "feat(news): 소스 10개 확장 + 카테고리 그룹화 (D-Expand)

GenericRssSource 어댑터 + NewsCategory(KoreanTech/EnglishTech/
AiResearch). 신규 10개 소스(default OFF, 0019 mig 명시 seed):
한글 6 + 영문 2 + AI 2. arXiv HTTPS, Reddit per-source UA 헤더.

품질 가드:
- published/updated 모두 없는 entry는 drop(Utc::now 폴백 금지)
- 페치당 TAKE=30 캡(arXiv 100건 독점 차단)
- registry vs pref seed 커버리지 assertion
- 0019 마이그레이션 멱등(사용자 변경 보존)

UI: 카테고리별 접기/펴기 + 전부 ON/OFF.
인덱스: news_items(source, posted_at DESC).

INVARIANT #1 표시-only 유지. 검증: cargo test news:: pass · clippy 0
· typecheck 0 · lint 49 baseline · pnpm tauri dev 스모크."
rtk git checkout dev && rtk git merge --ff-only feat/news-d-expand-sources-and-grouping && rtk git push origin dev
```

---

## §D-Tune — 글로벌 옵션 (한도/정렬/주기) + Notify-instant-apply

브랜치: `feat/news-d-tune-options`

### Task T.1 — 마이그레이션 0020 + options_store (멱등 re-seed)

**Files:**
- Create: `src-tauri/migrations/0020_news_options.sql`
- Create: `src-tauri/src/news/options_store.rs`

- [ ] **Step 1: 0020**

```sql
CREATE TABLE news_options (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    total_limit INTEGER NOT NULL DEFAULT 30,
    per_source_limit INTEGER NOT NULL DEFAULT 10,
    sort_mode TEXT NOT NULL DEFAULT 'recent'
        CHECK (sort_mode IN ('recent','comments','mixed')),
    fetch_interval_minutes INTEGER NOT NULL DEFAULT 15
        CHECK (fetch_interval_minutes IN (0, 5, 10, 15, 30, 60))
) STRICT;

INSERT INTO news_options(id) VALUES (1) ON CONFLICT DO NOTHING;
```

- [ ] **Step 2: options_store.rs (멱등 re-seed + Default impl)**

```rust
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
}

impl Default for NewsOptions {
    fn default() -> Self {
        Self {
            total_limit: 30,
            per_source_limit: 10,
            sort_mode: SortMode::Recent,
            fetch_interval_minutes: 15,
        }
    }
}

/// 멱등 re-seed → SELECT. 누군가가 row를 지워도 다음 호출에서 자동 복구.
pub async fn get(db: &Db) -> Result<NewsOptions, AppError> {
    sqlx::query("INSERT INTO news_options(id) VALUES (1) ON CONFLICT DO NOTHING")
        .execute(db)
        .await?;
    let row: (i64, i64, String, i64) = sqlx::query_as(
        "SELECT total_limit, per_source_limit, sort_mode, fetch_interval_minutes \
         FROM news_options WHERE id = 1",
    )
    .fetch_one(db)
    .await?;
    Ok(NewsOptions {
        total_limit: row.0 as u32,
        per_source_limit: row.1 as u32,
        sort_mode: SortMode::parse(&row.2),
        fetch_interval_minutes: row.3 as u32,
    })
}

pub async fn set(db: &Db, o: &NewsOptions) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE news_options SET \
             total_limit = ?, per_source_limit = ?, sort_mode = ?, fetch_interval_minutes = ? \
         WHERE id = 1",
    )
    .bind(o.total_limit as i64)
    .bind(o.per_source_limit as i64)
    .bind(o.sort_mode.as_str())
    .bind(o.fetch_interval_minutes as i64)
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
        set(&p, &NewsOptions {
            total_limit: 50, per_source_limit: 0,
            sort_mode: SortMode::Mixed, fetch_interval_minutes: 30,
        }).await.unwrap();
        let o = get(&p).await.unwrap();
        assert_eq!(o.total_limit, 50);
        assert_eq!(o.per_source_limit, 0);
        assert_eq!(o.sort_mode, SortMode::Mixed);
        assert_eq!(o.fetch_interval_minutes, 30);
    }

    #[tokio::test]
    async fn get_reseeds_after_row_delete() {
        let p = pool().await;
        sqlx::query("DELETE FROM news_options WHERE id = 1").execute(&p).await.unwrap();
        // get은 INSERT-then-SELECT 멱등 → row 다시 생기고 default 반환.
        let o = get(&p).await.unwrap();
        assert_eq!(o, NewsOptions::default());
    }
}
```

`mod.rs`에 `pub mod options_store;` 등록.

### Task T.2 — `store::list_recent` 옵션 + 필터 통합

**Files:**
- Modify: `src-tauri/src/news/store.rs`

⚠️ D-Safe에서 만든 `list_recent(db, limit, filters)`를 `list_recent(db, opts, filters)`로 다시 변경.

- [ ] **Step 1: 시그니처 + 윈도우 함수 per-source 캡 + 정렬 분기**

```rust
use super::filter_store::{FilterMode, KeywordFilter};
use super::options_store::{NewsOptions, SortMode};

const INCLUDE_FRAGMENT: &str = "n.title LIKE ? COLLATE NOCASE";
const EXCLUDE_FRAGMENT: &str = "n.title NOT LIKE ? COLLATE NOCASE";

/// SortMode → 외부 SELECT의 ORDER BY 고정 절. closed-set → `&'static str` only.
/// 모든 모드 마지막에 `n.external_id DESC` tiebreak를 둬서 같은 timestamp(arXiv 배치
/// 등에서 흔함) 시에도 결정적 순서를 보장(v3 minor).
fn order_clause(mode: SortMode) -> &'static str {
    match mode {
        SortMode::Recent => "ORDER BY n.posted_at DESC, n.external_id DESC",
        SortMode::Comments => "ORDER BY COALESCE(n.comment_count, 0) DESC, n.posted_at DESC, n.external_id DESC",
        // mixed: rn ASC로 라운드 우선, 같은 rn 내에서 source ASC tiebreak로 deterministic,
        // 그 다음 최신순(critic T3 반영) + external_id tiebreak(v3 minor).
        SortMode::Mixed => "ORDER BY n.rn ASC, n.source ASC, n.posted_at DESC, n.external_id DESC",
    }
}

pub async fn list_recent(
    db: &Db,
    opts: &NewsOptions,
    filters: &[KeywordFilter],
) -> Result<Vec<NewsItem>, AppError> {
    let includes: Vec<&KeywordFilter> = filters.iter().filter(|f| f.mode == FilterMode::Include).collect();
    let excludes: Vec<&KeywordFilter> = filters.iter().filter(|f| f.mode == FilterMode::Exclude).collect();

    let include_clause = if includes.is_empty() {
        String::new()
    } else {
        let parts: Vec<&'static str> = (0..includes.len()).map(|_| INCLUDE_FRAGMENT).collect();
        format!(" AND ({})", parts.join(" OR "))
    };
    let exclude_clause = if excludes.is_empty() {
        String::new()
    } else {
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
    for kw in &includes { q = q.bind(format!("%{}%", kw.keyword)); }
    for kw in &excludes { q = q.bind(format!("%{}%", kw.keyword)); }
    q = q.bind(per_source_limit).bind(opts.total_limit as i64);

    let rows = q.fetch_all(db).await?;
    Ok(rows.into_iter().map(Into::into).collect())
}
```

- [ ] **Step 2: 기존/D-Safe 테스트 시그니처 일괄 갱신 + 신규 옵션 테스트**

helper:
```rust
fn test_opts() -> NewsOptions {
    NewsOptions { total_limit: 10, per_source_limit: 0,
        sort_mode: SortMode::Recent, fetch_interval_minutes: 15 }
}
```

기존/D-Safe 테스트의 `list_recent(&p, 10, &filters)` → `list_recent(&p, &test_opts(), &filters)` 일괄 변경.

신규:
```rust
#[tokio::test]
async fn per_source_limit_caps_per_source() {
    let p = pool().await;
    sqlx::query("INSERT INTO news_source_pref(source, enabled) VALUES ('geeknews', 1) \
                 ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled")
        .execute(&p).await.unwrap();
    for i in 0..5 {
        upsert_many(&p, &[item("hn", &format!("h{i}"), &format!("hn-{i}"))]).await.unwrap();
        upsert_many(&p, &[item("geeknews", &format!("g{i}"), &format!("gn-{i}"))]).await.unwrap();
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
    let mut a = item("hn", "1", "a"); a.comment_count = Some(10);
    let mut b = item("hn", "2", "b"); b.comment_count = Some(50);
    let mut c = item("hn", "3", "c"); c.comment_count = Some(20);
    upsert_many(&p, &[a, b, c]).await.unwrap();
    let mut opts = test_opts(); opts.sort_mode = SortMode::Comments;
    let rows = list_recent(&p, &opts, &[]).await.unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r.external_id.as_str()).collect();
    assert_eq!(ids, vec!["2", "3", "1"]);
}

#[tokio::test]
async fn sort_mode_mixed_round_robin_deterministic() {
    let p = pool().await;
    sqlx::query("INSERT INTO news_source_pref(source, enabled) VALUES ('geeknews', 1), ('lobsters', 1) \
                 ON CONFLICT(source) DO UPDATE SET enabled = excluded.enabled")
        .execute(&p).await.unwrap();
    // 각 소스 2개씩.
    upsert_many(&p, &[
        item("hn", "h1", "hn-1"), item("hn", "h2", "hn-2"),
        item("geeknews", "g1", "gn-1"), item("geeknews", "g2", "gn-2"),
        item("lobsters", "l1", "lb-1"), item("lobsters", "l2", "lb-2"),
    ]).await.unwrap();
    let mut opts = test_opts(); opts.sort_mode = SortMode::Mixed; opts.total_limit = 6;
    let rows = list_recent(&p, &opts, &[]).await.unwrap();
    // rn=1 라운드 3건(source ASC: geeknews, hn, lobsters), 그 다음 rn=2 라운드.
    let sources: Vec<&str> = rows.iter().map(|r| r.source.as_str()).collect();
    assert_eq!(&sources[..3], &["geeknews", "hn", "lobsters"], "라운드 1 source ASC");
    assert_eq!(&sources[3..], &["geeknews", "hn", "lobsters"], "라운드 2 source ASC");
}
```

### Task T.3 — `fetcher`: `interval` 유지 + `Notify` 즉시 적용

**Files:**
- Modify: `src-tauri/src/news/fetcher.rs`
- Modify: `src-tauri/src/lib.rs` (Notify를 managed state로 보관)

⚠️ **Architect T1 blocker**: `tokio::time::interval` **유지**(drift 보정 + MissedTickBehavior 보존). 옵션 변경은 `tokio::sync::Notify`로 즉시 깨움. `fetch_interval=0`은 `Notify`만 대기(busy-poll 아님).

- [ ] **Step 1: Notify 핸들 + spawn_loop 리팩터**

```rust
use std::sync::Arc;
use std::time::Duration;

use rand::RngExt;
use reqwest::Client;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use tokio::time::{Interval, MissedTickBehavior};

use super::{options_store, pref_store, registry, store, NewsItem, NewsSource};
use crate::db::Db;
use crate::error::AppError;

const REQ_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_ATTEMPTS: u32 = 3;
const INITIAL_DELAY_MS: u64 = 500;
const MAX_DELAY_MS: u64 = 10_000;
const JITTER_MAX_MS: u64 = 200;
const PARK_TIMEOUT: Duration = Duration::from_secs(3600); // 0=수동일 때 wakeup 안 와도 1h 후 polling 안전망

#[derive(Serialize, Type, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewsFetchFailed {
    pub source: String,
    pub error: String,
}

/// 옵션 변경 신호 — `news_set_options` 커맨드가 `notify_one()` 호출.
/// AppHandle managed state로 공유.
///
/// `Notify::notify_one()`은 wake-up 허가(permit)를 **하나** 버퍼한다. set_options가
/// fetcher의 `select!` 진입 전에 호출돼도 다음 `notified()` future가 즉시 resolve →
/// 즉시-적용 보장. (Tokio 문서 보장.)
pub type OptionsNotify = Arc<Notify>;

/// select!의 깨움 이유. R7 — 변수명 의도 정확화(park 안전망 polling도 Reconfig).
enum WakeReason {
    Tick,
    Reconfig,
}

/// fetcher 메인 loop의 select! 분기를 추출한 helper.
/// `spawn_loop`와 `notify_wakes_loop_immediately` 통합 테스트가 같은 코드 경로를 호출 →
/// 테스트가 production 동작을 진짜로 검증(R6).
///
/// - `ticker == Some` (interval 모드): Tick vs Reconfig 중 먼저 resolve된 것.
/// - `ticker == None` (park 모드, fetch_interval=0): Reconfig 또는 `PARK_TIMEOUT` 안전망.
async fn select_next_wake(
    ticker: Option<&mut Interval>,
    notify: &Notify,
) -> WakeReason {
    match ticker {
        Some(t) => {
            tokio::select! {
                _ = t.tick() => WakeReason::Tick,
                _ = notify.notified() => WakeReason::Reconfig,
            }
        }
        None => {
            tokio::select! {
                _ = notify.notified() => WakeReason::Reconfig,
                _ = tokio::time::sleep(PARK_TIMEOUT) => WakeReason::Reconfig,
            }
        }
    }
}

/// 옵션의 `fetch_interval_minutes`에 맞춰 새 `Interval`을 만들고 첫(즉시) tick을 소비한다.
/// R1: `MissedTickBehavior::Delay` 명시 — Tokio 기본 `Burst`는 옵션 churn 후
/// back-to-back tick을 일으켜 INVARIANT #5(bounded retry)를 위반할 수 있음.
async fn build_ticker(minutes: u32) -> Option<Interval> {
    if minutes == 0 {
        return None;
    }
    let mut t = tokio::time::interval(Duration::from_secs(minutes as u64 * 60));
    t.set_missed_tick_behavior(MissedTickBehavior::Delay);
    // 첫 tick은 interval 생성 직후 즉시 resolve → 우리는 이미 직전에 한 번 fetch한 상태이므로
    // 여기서 소비해 다음 진짜 주기부터 카운팅.
    t.tick().await;
    Some(t)
}

pub fn spawn_loop(db: Db, app: AppHandle, notify: OptionsNotify) {
    tauri::async_runtime::spawn(async move {
        let client = match Client::builder()
            .timeout(REQ_TIMEOUT)
            .user_agent("work-radar/news-fetcher")
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                tracing::error!(error = %e, "news fetcher client build failed; aborting");
                return;
            }
        };

        // 첫 tick 즉시 실행.
        if let Err(e) = tick(&db, &app, &client).await {
            tracing::warn!(error = %e, "news fetcher initial tick failed");
        }

        let mut current_minutes: u32 = 0;
        let mut ticker_opt: Option<Interval> = None;

        loop {
            // 옵션 읽고 interval을 그에 맞춰 재구성(변경된 경우만).
            let opts = options_store::get(&db).await.unwrap_or_default();
            if opts.fetch_interval_minutes != current_minutes {
                current_minutes = opts.fetch_interval_minutes;
                ticker_opt = build_ticker(current_minutes).await;
            }

            // 다음 트리거: helper로 분기(R6 — 같은 함수를 통합 테스트가 호출).
            let reason = select_next_wake(ticker_opt.as_mut(), &notify).await;

            // R7: woke_for_reconfig — park 안전망(PARK_TIMEOUT)도 Reconfig로 분기되므로 의도 정확.
            let woke_for_reconfig = matches!(reason, WakeReason::Reconfig);
            if woke_for_reconfig {
                // 옵션이 바뀌었을 수 있으니 loop 머리에서 재평가 + interval 재구성.
                continue;
            }

            // 정상 tick — fetch 실행.
            if let Err(e) = tick(&db, &app, &client).await {
                tracing::warn!(error = %e, "news fetcher tick failed");
            }
        }
    });
}

async fn tick(db: &Db, app: &AppHandle, client: &Client) -> Result<(), AppError> {
    let _ = store::purge_expired(db).await;
    let enabled = pref_store::enabled_ids(db).await?;
    if enabled.is_empty() {
        return Ok(());
    }

    let mut any_success = false;
    let mut summary: Vec<(String, Result<usize, String>)> = Vec::new();
    for source in registry() {
        if !enabled.iter().any(|id| id == source.id()) { continue; }
        let id = source.id().to_string();
        match fetch_with_retry(&*source, client).await {
            Ok(items) => {
                let n = items.len();
                match store::upsert_many(db, &items).await {
                    Ok(()) => { any_success = true; summary.push((id, Ok(n))); }
                    Err(e) => {
                        summary.push((id.clone(), Err(format!("upsert: {e}"))));
                        let _ = app.emit("news_fetch_failed", NewsFetchFailed {
                            source: id, error: format!("upsert: {e}"),
                        });
                    }
                }
            }
            Err(e) => {
                summary.push((id.clone(), Err(e.to_string())));
                let _ = app.emit("news_fetch_failed", NewsFetchFailed {
                    source: id, error: e.to_string(),
                });
            }
        }
    }
    if any_success {
        let _ = app.emit("news_items_updated", ());
    }
    if !summary.is_empty() {
        let parts: Vec<String> = summary.into_iter()
            .map(|(id, r)| match r { Ok(n) => format!("{id}={n}"), Err(_) => format!("{id}=ERR") })
            .collect();
        tracing::info!(summary = %parts.join(" "), "news tick");
    }
    Ok(())
}

async fn fetch_with_retry(
    source: &dyn NewsSource,
    client: &Client,
) -> Result<Vec<NewsItem>, AppError> {
    let mut delay_ms = INITIAL_DELAY_MS;
    let mut last_err: Option<AppError> = None;
    for attempt in 1..=MAX_ATTEMPTS {
        match source.fetch(client).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                tracing::debug!(source = source.id(), attempt, error = %e, "news fetch retry");
                last_err = Some(e);
                if attempt == MAX_ATTEMPTS { break; }
                let jitter = rand::rng().random_range(0..JITTER_MAX_MS);
                tokio::time::sleep(Duration::from_millis(delay_ms + jitter)).await;
                delay_ms = (delay_ms * 2).min(MAX_DELAY_MS);
            }
        }
    }
    Err(last_err.expect("retry loop sets last_err"))
}
```

- [ ] **Step 2: `lib.rs` setup hook — Notify managed state + spawn_loop 호출 변경**

setup 안에서:
```rust
let notify: news::fetcher::OptionsNotify = std::sync::Arc::new(tokio::sync::Notify::new());
app.manage(notify.clone());

// 외부 뉴스 페처(PR B): bounded retry, 옵션 변경은 Notify로 즉시 적용.
let news_db: db::Db = app.state::<db::Db>().inner().clone();
news::fetcher::spawn_loop(news_db, app.handle().clone(), notify);
```

- [ ] **Step 3: 통합 테스트 — production helper 직접 호출(R6)**

`fetcher.rs` 하단 `#[cfg(test)] mod tests`. **`select_next_wake` helper를 직접 호출**해 production 코드 경로를 검증한다(이전 v2의 hand-rolled select는 tokio만 테스트했음 — 회귀).

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::Notify;

    /// R6: production helper `select_next_wake`를 직접 호출.
    /// Notify 트리거가 interval보다 먼저 resolve → WakeReason::Reconfig 반환.
    #[tokio::test(start_paused = true)]
    async fn notify_wakes_select_next_wake_immediately() {
        let notify = Arc::new(Notify::new());
        let mut ticker = build_ticker(15).await.expect("15min ticker");

        // Notify를 미리 트리거 — Notify는 permit 1개를 buffer하므로 다음 select에서 즉시 resolve.
        notify.notify_one();
        let reason = select_next_wake(Some(&mut ticker), &notify).await;
        assert!(matches!(reason, WakeReason::Reconfig), "Notify가 interval보다 먼저 깨워야 함");
    }

    /// interval만 도달했을 때 → WakeReason::Tick.
    #[tokio::test(start_paused = true)]
    async fn ticker_fires_when_due() {
        let notify = Arc::new(Notify::new());
        let mut ticker = build_ticker(5).await.expect("5min ticker"); // 첫 tick은 build에서 이미 소비.
        // 5분 진행 → 다음 tick 도달.
        tokio::time::advance(Duration::from_secs(5 * 60)).await;
        let reason = select_next_wake(Some(&mut ticker), &notify).await;
        assert!(matches!(reason, WakeReason::Tick));
    }

    /// park 모드(ticker=None)에서도 Notify가 즉시 깨움.
    #[tokio::test(start_paused = true)]
    async fn park_mode_wakes_on_notify() {
        let notify = Arc::new(Notify::new());
        notify.notify_one();
        let reason = select_next_wake(None, &notify).await;
        assert!(matches!(reason, WakeReason::Reconfig));
    }

    /// build_ticker(0)은 None 반환 — park 모드 진입 가드.
    #[tokio::test(start_paused = true)]
    async fn build_ticker_zero_returns_none() {
        assert!(build_ticker(0).await.is_none());
    }

    /// MissedTickBehavior::Delay가 실제 적용됐는지 — 두 tick 간격이 절반 이하로 줄어들지 않음.
    /// (Burst였다면 advance(2 * period) 뒤 즉시 두 번 연속 fire.)
    #[tokio::test(start_paused = true)]
    async fn missed_tick_behavior_is_delay_not_burst() {
        let notify = Arc::new(Notify::new());
        let mut ticker = build_ticker(5).await.unwrap();
        // 10분 진행 — Burst면 두 번 즉시 fire, Delay면 1번 fire 후 다음은 다시 5분 후.
        tokio::time::advance(Duration::from_secs(10 * 60)).await;
        let r1 = select_next_wake(Some(&mut ticker), &notify).await;
        assert!(matches!(r1, WakeReason::Tick));
        // 두 번째는 즉시가 아니라 5분 뒤 — 1초만 지나서는 안 옴(Notify로 단언).
        tokio::time::advance(Duration::from_secs(1)).await;
        notify.notify_one();
        let r2 = select_next_wake(Some(&mut ticker), &notify).await;
        assert!(matches!(r2, WakeReason::Reconfig), "Delay 모드: 두번째 tick은 즉시 fire 안 함");
    }
}
```

### Task T.4 — IPC + 프런트 옵션 폼 + Notify 트리거

**Files:**
- Modify: `src-tauri/src/commands/news.rs`
- Modify: `src-tauri/src/lib.rs` (collect_commands)
- Modify: `src/lib/query/news.ts`
- Modify: `src/components/settings/NewsSourceSettings.tsx`

- [ ] **Step 1: commands — breaking IPC + Notify 트리거**

```rust
use crate::news::options_store::{self, NewsOptions};
use crate::news::fetcher::OptionsNotify;

#[tauri::command]
#[specta::specta]
pub async fn news_list_recent(db: State<'_, Db>) -> Result<Vec<NewsItem>, AppError> {
    // limit 인자 제거 — opts에서 가져옴(breaking IPC).
    let opts = options_store::get(db.inner()).await?;
    let filters = filter_store::list(db.inner()).await?;
    store::list_recent(db.inner(), &opts, &filters).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_get_options(db: State<'_, Db>) -> Result<NewsOptions, AppError> {
    options_store::get(db.inner()).await
}

#[tauri::command]
#[specta::specta]
pub async fn news_set_options(
    db: State<'_, Db>,
    notify: State<'_, OptionsNotify>,
    options: NewsOptions,
) -> Result<(), AppError> {
    options_store::set(db.inner(), &options).await?;
    notify.notify_one();   // fetcher 즉시 깨움 → 옵션 재읽기 → interval 재구성.
    Ok(())
}
```

`lib.rs` `collect_commands![...]`에 `news_get_options`, `news_set_options` 추가. `news_list_recent`는 이미 등록되어 있고 시그니처 변경뿐.

- [ ] **Step 2: RQ 훅**

```ts
const NEWS_POLL_MS = 5 * 60 * 1000;

export function useNewsList() {
  return useQuery({
    queryKey: ["newsList"],
    queryFn: () => unwrap(commands.newsListRecent()),   // 인자 제거.
    refetchInterval: NEWS_POLL_MS,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

export function useNewsOptions() {
  return useQuery({
    queryKey: ["newsOptions"],
    queryFn: () => unwrap(commands.newsGetOptions()),
    retry: false,
  });
}

export function useSetNewsOptions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (opts: NewsOptions) => unwrap(commands.newsSetOptions(opts)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["newsOptions"] });
      void qc.invalidateQueries({ queryKey: ["newsList"] });
    },
  });
}
```

- [ ] **Step 3: 옵션 폼 컴포넌트 (`NewsSourceSettings.tsx` 상단)**

`Field`와 `SectionLabel`은 기존 settings kit (`src/components/settings/kit.tsx`)에서 가져온다.
다른 settings 화면들(NavigationSettings 등)과 같은 패턴.

```tsx
import { Field, SectionLabel } from "./kit";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useNewsOptions, useSetNewsOptions } from "@/lib/query/news";
import type { NewsOptions, SortMode } from "@/bindings";

function NewsOptionsForm({ onToast }: { onToast: (msg: string) => void }) {
  const q = useNewsOptions();
  const m = useSetNewsOptions();
  const o = q.data;
  if (!o) return null;
  const update = (patch: Partial<NewsOptions>) =>
    m.mutate({ ...o, ...patch }, { onSuccess: () => onToast("옵션 저장됨 — 다음 페치부터 적용") });

  return (
    <section className="rounded-xl border border-border p-4 flex flex-col gap-3">
      <SectionLabel>표시 옵션</SectionLabel>
      <Field label="총 표시 개수" hint="티커가 동시에 보여줄 최대(5~100)">
        <Input type="number" min={5} max={100}
          value={o.totalLimit}
          onChange={(e) => update({ totalLimit: Math.max(5, Math.min(100, Number(e.target.value))) })}
        />
      </Field>
      <Field label="소스당 최대 개수" hint="0이면 무제한(한 소스가 티커를 독점할 수 있음)">
        <Input type="number" min={0} max={50}
          value={o.perSourceLimit}
          onChange={(e) => update({ perSourceLimit: Math.max(0, Math.min(50, Number(e.target.value))) })}
        />
      </Field>
      <Field label="정렬">
        <Select value={o.sortMode} onValueChange={(v) => update({ sortMode: v as SortMode })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">최신순</SelectItem>
            <SelectItem value="comments">댓글 많은 순</SelectItem>
            <SelectItem value="mixed">소스 라운드로빈</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="갱신 주기" hint="0=자동 갱신 끔(설정 변경 시 즉시 깨움)">
        <Select value={String(o.fetchIntervalMinutes)}
                onValueChange={(v) => update({ fetchIntervalMinutes: Number(v) })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="0">자동 갱신 끔</SelectItem>
            <SelectItem value="5">5분</SelectItem>
            <SelectItem value="10">10분</SelectItem>
            <SelectItem value="15">15분(기본)</SelectItem>
            <SelectItem value="30">30분</SelectItem>
            <SelectItem value="60">60분</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </section>
  );
}
```

JSX 안 D-Safe `<NewsFiltersForm />` 위에 마운트.

### Task T.5 — 검증 + 부팅 스모크 + 커밋

- [ ] **Step 1: 풀세트**

```bash
cd /Users/davidpark/private_project/work-radar/src-tauri
export PATH="$HOME/.cargo/bin:$PATH"
rtk proxy cargo test --lib news:: 2>&1 | tail -25
rtk proxy cargo clippy --lib --tests -- -D warnings 2>&1 | tail -5
rtk proxy cargo test --lib bindings_export 2>&1 | tail -5
cd .. && rtk tsc --noEmit 2>&1 | tail -3
pnpm lint 2>&1 | grep -E "ESLint:"
grep -E "newsGetOptions|newsSetOptions|SortMode" src/bindings.ts | head -3
# 잔존 호출처 확인 — newsListRecent 어디에서 인자로 호출하는지.
rg "newsListRecent\(" src/
```
Expected: 모두 0 errors. `newsListRecent`에 인자 없는 호출만 존재(grep 결과 = `src/lib/query/news.ts:.. unwrap(commands.newsListRecent()),`).

- [ ] **Step 2: `pnpm tauri dev` 부팅 스모크 + 동작**

수동 체크:
- 설정 → 뉴스 → 표시 옵션 섹션 보임.
- 갱신 주기 5분으로 변경 → devtools 로그/네트워크에서 5분 후 fetcher tick 발생.
- 갱신 주기 0("자동 갱신 끔") → 다음 tick 안 옴. 다시 15분으로 바꾸면 즉시 fetcher 깨움 → tick 즉시 실행되어야(Notify 동작).
- 소스당 한도 1로 변경 → 티커가 소스당 1개씩만.
- 정렬 "라운드로빈" → 같은 라운드 안에서 source ASC 순.

- [ ] **Step 3: decisions.md 한 줄**

```
- **PR D-Tune — 뉴스 글로벌 옵션 + 즉시 적용 머지(2026-05-25)**: `news_options` 단일 row(total_limit/per_source_limit/sort_mode/fetch_interval) + `options_store` 멱등 re-seed get + `NewsOptions::default()`. `store::list_recent`이 `(db, opts, filters)` — ROW_NUMBER 윈도우로 per-source 캡, sort_mode (recent/comments/mixed) closed-set `&'static str` 절, mixed는 `rn ASC, source ASC, posted_at DESC`로 결정적. fetcher는 `tokio::time::interval` 유지(drift 보정 + MissedTickBehavior 보존) + `tokio::sync::Notify`로 옵션 변경 즉시 깨움 — `fetch_interval=0`은 진짜 park(Notify만 대기 + 1h 안전망 폴). breaking IPC: `news_list_recent()` (limit 인자 제거 — opts에서). 통합 테스트: `tokio::time::pause` + `advance`로 Notify가 interval 분기를 즉시 깨우는지 검증. INVARIANT #5 bounded retry 유지(주기 floor 5분, 0=park). #1 표시-only. 검증: cargo test news:: pass · clippy 0 · typecheck 0 · lint 49 baseline · pnpm tauri dev 스모크. bindings drift 0.
```

- [ ] **Step 4: 커밋 + dev 머지 + push**

```bash
rtk git add -A && rtk git commit -m "feat(news): 글로벌 옵션 + Notify 즉시 적용 (D-Tune)

news_options 단일 row + IPC news_get/set_options.
options_store는 INSERT-then-SELECT 멱등 get + NewsOptions::default.
store::list_recent이 opts + filters 통합 — per-source ROW_NUMBER
윈도우, sort_mode (recent/comments/mixed) closed-set 'static str
fragment, mixed는 (rn ASC, source ASC, posted_at DESC)로 결정적.

fetcher (Architect T1 blocker 해결):
- tokio::time::interval 유지 → drift 보정 + MissedTickBehavior 보존
- tokio::sync::Notify로 옵션 변경 즉시 적용
- fetch_interval=0은 진짜 park(Notify만 대기 + 1h 안전망 폴)
- 통합 테스트: tokio::time::pause + advance + Notify 검증

Breaking IPC: news_list_recent() (limit 인자 제거). 동일 PR에서
frontend 동시 수정 → bindings drift 0.

INVARIANT #5 유지(주기 5분 floor 또는 park, busy-poll 아님).
#1 표시-only.

검증: cargo test news:: pass(옵션 + 필터 통합) · clippy 0
· typecheck 0 · lint 49 baseline · pnpm tauri dev 스모크."
rtk git checkout dev && rtk git merge --ff-only feat/news-d-tune-options && rtk git push origin dev
```

---

## §X — 전체 phase 종료 후

- [ ] 메모리 `news-ticker-feature-state` 갱신 — D 시리즈 3-PR 모두 완료 + 잔존 follow-up.

---

## §9 Self-Review (v2)

**1. Spec coverage:**

| 사용자 요청 | task |
|---|---|
| 키워드 필터 include/exclude | D-Safe |
| 소스 개수 증가 + 카테고리 + 영문/한글 | D-Expand |
| 소스별 표시 개수 | D-Tune (per_source_limit) |
| 표시 정렬 기준 | D-Tune (recent/comments/mixed) |
| 갱신 주기 사용자 설정 | D-Tune (0/5/10/15/30/60 + 즉시 적용) |
| INVARIANTS ①/③/⑤/⑦ | 모든 task |

**2. Placeholder scan:** 없음. 모든 step에 실제 코드/명령.

**3. Architect blockers 적용 ✅**
- T1: `tokio::time::interval` + `Notify` 유지(spawn_loop 코드에 직접 반영).
- Antithesis: PR 재순서(D-Safe 먼저).
- options_store 멱등: INSERT-then-SELECT 코드에 반영.

**4. Critic must-fix 적용 ✅**
- GenericRssSource timestamp `?`(drop) — 반영.
- D3.3 SQL alias 일관성(`n.*` everywhere) — 반영.
- D-Tune 통합 테스트(`tokio::time::pause`) — Task T.3 Step 3.
- `pnpm tauri dev` 부팅 스모크 — 각 PR Step 2.
- `fetch_interval=0` semantics — 진짜 park(Notify only).
- 각 PR decisions.md 라인 — 각 PR Step 3.
- arXiv HTTPS, Reddit UA — Task E.2/E.3.
- registry-pref 커버리지 assertion — Task E.3 Step 3.
- 인덱스 — Task E.4.

**5. 의존성 가드:** 새 crate 0 (tokio::sync::Notify는 기존 tokio "full" feature에 포함). 새 npm 0 (lucide `X`/`ChevronDown`/`ChevronRight`만 추가 사용).

**6. 위험·트레이드오프:**
- D-Expand RSS endpoint 변동: 신규 default OFF + per-source TAKE 캡 + `published.or(updated)?` drop으로 mitigation 강화.
- D-Tune breaking IPC: 같은 PR에서 frontend 동시 수정 + grep 검증 명시. bindings drift 0.
- D-Tune `Notify` 미수신 환경(매우 드뭄, 시스템 종료 직전 등): 1h 안전망 폴로 graceful.

**7. 후속 follow-up(이 plan 후):**
- Reddit 403 응답 시 다른 UA 시도(현재는 default OFF + Per-source 헤더 override).
- arXiv RSS 첫 tick 후 사용자가 켜서 동작 확인.
- 사용자 정의 RSS URL 입력(out-of-scope, 사용자 요구 시).

---

## §10 ADR (Architecture Decision Record)

**Status**: pending approval (ralplan iteration 3/5 — Architect: Sound · Critic: APPROVE).

**Decision**: 사용자가 뉴스 티커의 ① 소스(13개), ② 카테고리 그룹, ③ 키워드 필터(include/exclude), ④ 글로벌 옵션(총·소스당 한도, 정렬, 갱신 주기 + 즉시 적용)을 제어할 수 있게 한다. 백엔드는 단일 `NewsSource` trait + `GenericRssSource` RSS 어댑터 + `news_options` 단일 row + `news_keyword_filters` rows + `tokio::sync::Notify` 기반 즉시 적용. 프런트는 기존 shadcn Switch/Select/Input/Button 컴포넌트만 사용(새 의존성 0).

**Decision Drivers**:
1. **확장성** — 새 RSS 소스 추가가 단일 `GenericRssSource { id, label, url, category, headers, take }` literal 한 블록으로 끝.
2. **사용자 안전** — 신규 10개 소스 모두 default OFF + arXiv flood 방지(per-source TAKE=30, per-source limit 옵션, 키워드 필터를 D-Safe로 먼저 출하).
3. **회귀 0** — 기존 hn/geeknews/lobsters 동작 + PR B/C/cleanup의 INVARIANT 보존.

**Alternatives considered**:
- (A) **단일 통합 PR** — 큰 diff, atomicity 위험, 회귀 bisect 어려움. ❌ 무효.
- (B) **plan 4개로 분할** — phase 내 의존성(D-Expand의 category가 D-Tune SQL에 영향 없음·D-Tune이 D-Safe의 filter API 확장) 때문에 동기화 비용만 증가. ❌ 무효.
- (C) **4-PR 분할(D1→D2→D3→D4)** — 초안. arXiv flood가 D4 이전에 노출되는 안전 갭. Architect/Critic ITERATE.
- (D) **3-PR 재순서: D-Safe → D-Expand → D-Tune** — 필터(안전판)가 소스 확장 전. ✅ **선택**.

**Why chosen**:
- Architect Antithesis(D-Safe first) 반영 — arXiv/Reddit 같이 잠재적 noise 소스가 들어오기 전 사용자가 키워드 차단 도구를 보유.
- `tokio::time::interval` 유지(drift 보정) + `Notify`로 즉시 적용 — `MissedTickBehavior::Delay` 명시(test로 강제), INVARIANT #5 준수.
- 사용자 요청 5항(소스 확장 + 카테고리 + 표시 한도 + 정렬 + 주기 + 필터) 모두 testable acceptance에 매핑.

**Consequences**:
- **Breaking IPC** (`news_list_recent` limit 인자 제거) — 같은 PR(D-Tune)에서 frontend 동시 수정 + `rg "newsListRecent\("` 잔존 호출처 검증으로 bindings drift 0.
- **새 마이그레이션 3개**(0018 필터, 0019 신규 소스 default OFF + 인덱스, 0020 옵션 + idempotent seed).
- **fetcher 코드 복잡도 ↑** — `select_next_wake`/`build_ticker` 헬퍼로 테스트 가능 단위로 격리(5 단위 테스트).
- **default OFF 10 소스** — 사용자가 명시적으로 켜야 노출 → 신선도/검증 사용자 액션으로 자연 보장.

**Follow-ups** (이 plan 후, 비차단):
- N1: D-Tune reconfig path 즉시 fetch UX (현재는 다음 interval tick 대기) — 도그푸드 후 결정.
- N5: `select_next_wake`의 wake reason `tracing::debug!` 추가 — 관측성 향상.
- N6: `PARK_TIMEOUT` 안전망 경로 통합 테스트 — 회귀 방지(현재는 manual scenario).
- N7: `OptionsNotify` newtype 래퍼(Tauri managed state 충돌 회피) — YAGNI 경계, 두 번째 Notify 도입 시.
- Reddit 403 시 fallback UA 시도(현재는 단일 UA + default OFF).
- arXiv 첫 tick 후 사용자 콘솔/DB 검증.
- 사용자 정의 RSS URL 입력(out-of-scope, 사용자 요구 시 신규 spec).

---

## Plan complete — **pending approval**

ralplan iteration 3/5 합의 도달 (Architect: Sound · Critic: APPROVE).
`--interactive` 미사용 — 본 plan을 자동 실행하지 않음. 사용자가 실행 옵션 선택 후 진행.

**실행 옵션**:
1. **Subagent-Driven** — task별 fresh subagent + critic 최종 리뷰 (`/oh-my-claudecode:team` 또는 superpowers:subagent-driven-development)
2. **Inline Execution** — 본 세션이 직접 D-Safe → D-Expand → D-Tune 순서로 실행(각 PR 끝 critic ACCEPT + commit + dev push)
3. **Skip for now** — 다른 작업 진행 후 나중에 본 plan으로 복귀
