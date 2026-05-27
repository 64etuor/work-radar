# Brain Dump 중앙 토글 + 뉴스 티커 — Design

> 2026-05-25 작성. 3개 PR(A·B·C) 가이드 spec. 구현 plan은 별도 문서.

## 1. 동기

캡처 보드 하단 풀폭 CapturePanel은:

- 자주 쓰지 않는 동안 큰 화면 면적을 차지(뇌덤프 입력은 발산적·간헐적 행위)
- 매트릭스 자체에 시각적 무게 중심이 없음(중앙 사분면 교차점이 빔)

해결: 매트릭스 **중앙에 작은 토글 아이콘** → 클릭 시 인라인 확장으로 입력. 비울 공간(하단)은 **뉴스 티커**(HN/GeekNews/Lobsters 외부 정보 채널)로 전환해 보드를 능동적인 정보 서피스로 격상.

## 2. 범위와 비범위

### In scope

- A: 매트릭스 중앙 BrainDump 토글 + 인라인 펼침(기존 `CapturePanel` 재배치)
- B: Rust 뉴스 페처 백엔드 (3소스 + trait 기반 확장 슬롯)
- C: 좌측 스크롤 뉴스 티커 UI + 설정 다이얼로그 소스 토글

### Out of scope (다음 phase)

- 클릭당 다른 동작(in-app webview, 즐겨찾기, 읽음 처리, 키워드 필터)
- 푸시 알림(에이전트 알림 채널과 분리 유지)
- 사용자 정의 소스 추가(custom RSS URL 입력)
- 갱신 주기 사용자 설정 (MVP는 hard-coded 15분)

## 3. INVARIANTS 적용

| #   | 불변식                        | 본 spec 영향                                                           |
| --- | ----------------------------- | ---------------------------------------------------------------------- |
| ①   | 결정 레일 자동화 금지         | 뉴스는 **표시만**, 큐/매트릭스에 자동 주입 절대 금지                   |
| ②   | 외부 mutation Acceptance gate | 뉴스 페치는 read-only — gate 무관                                      |
| ③   | 신호 dedup upsert             | 뉴스 아이템은 `(source, external_id)` UNIQUE upsert                    |
| ⑤   | bounded retry                 | 페치 실패 최대 3회 지수 백오프, terminal 실패는 IPC event              |
| ⑦   | SSOT 분리                     | 뉴스 원본 SSOT=외부 사이트, SQLite=캐시(TTL/만료 정책으로 신선도 보장) |

## 4. PR A — 중앙 BrainDump 토글

### UX

- 매트릭스 캔버스 중앙(사분면 교차점) 위에 `position: absolute` pill
- 기본 collapsed 상태: lucide `Sparkles` 아이콘 + `BRAIN` mono caps 라벨
- 클릭/포커스 → 가로로 확장되어 기존 `CapturePanel` 인라인 표시 (개인/업무 토글 + input + 붙이기 버튼)
- ESC 또는 외부 클릭 → collapse (입력 비어있을 때만 자동 collapse, 내용 있으면 confirm 없이 유지)
- Enter로 submit 후에는 collapse 상태로 복귀(입력 비워짐 → 자연스러움)

### 마크업·CSS

```tsx
<MatrixCanvas>
  ... 사분면 카드 ...
  <BrainDumpToggle expanded={open} onToggle={...} onSubmit={...} />
</MatrixCanvas>
```

- z-index: 카드(< 10) < toggle(20) < cmdk overlay(90)
- 위치: 매트릭스 컨테이너 기준 `top: 50%; left: 50%; transform: translate(-50%, -50%)`
- collapsed: padding 6 14, border 1px wr-border-light, bg wr-bg, soft shadow
- expanded: width grow → input 자리 보장, 동일 컨테이너 안에서 라벨/세그먼트/input/버튼 인라인 배치
- transition: width 200ms ease + opacity 페이드 인 라벨/필드

### 영향 받는 파일

- `src/components/board/CapturePanel.tsx` — 컴포넌트 자체는 유지(재사용), 위치만 이동
- `src/components/board/MatrixCanvas.tsx` — 중앙 toggle 마운트
- `src/components/CaptureBoard.tsx` — 하단 `<CapturePanel />` 인스턴스 **제거**, 그 자리에 `<NewsTickerSlot />`(PR C에서 채움. PR A에서는 placeholder div만 둠)
- `src/styles.css` — `.brain-dump-toggle`, `.brain-dump-toggle.is-open` 추가; `.cb .capture` 위치/마진 기존 룰 정리

### Done-criteria

- 아이콘 클릭 → 가로 확장 → input 자동 포커스 → Enter로 submit 정상 동작
- ESC로 닫히고 트리거에 포커스 복원(radix `DialogTrigger asChild` 또는 manual focus restore — 사용 패턴은 SprintTimer와 통일)
- cmux 브라우저 스모크 통과: Esc → 닫힘 + window.hide 미호출 + 트리거 포커스 복원

### Rollout

- PR A는 PR C 의존성 없음 — 하단은 placeholder("뉴스 티커 자리 — PR C에서 활성화")로 dev 머지 가능
- PR A 머지 후 사용자가 매트릭스 화면을 바로 새로운 UX로 체감

## 5. PR B — 뉴스 페처 백엔드

### 모듈 구조

```
src-tauri/src/news/
  mod.rs            // NewsSource trait, registry, NewsItem 타입
  hn.rs             // Hacker News (Firebase JSON)
  geeknews.rs       // GeekNews RSS
  lobsters.rs       // Lobsters JSON
  store.rs          // SQLite news_items upsert + 최근 N개 조회
  fetch_loop.rs     // 15분 주기 background task (tokio)
  pref_store.rs     // source on/off 설정
```

### NewsSource trait

```rust
#[async_trait]
pub trait NewsSource: Send + Sync {
    fn id(&self) -> &'static str;          // "hn" | "geeknews" | "lobsters"
    fn label(&self) -> &'static str;        // 표시명
    async fn fetch(&self, client: &Client) -> AppResult<Vec<NewsItem>>;
}

pub struct NewsItem {
    pub source: String,           // trait.id()
    pub external_id: String,      // 소스별 안정적 id (HN: story id, RSS: guid, etc.)
    pub title: String,
    pub url: String,              // 원본 기사
    pub comments_url: Option<String>,
    pub comment_count: Option<u32>,
    pub posted_at: DateTime<Utc>,
}

pub fn registry() -> Vec<Box<dyn NewsSource>> {
    vec![Box::new(HnSource), Box::new(GeekNewsSource), Box::new(LobstersSource)]
}
```

확장: 새 소스 추가 = `impl NewsSource` 한 파일 + registry 한 줄.

### 소스별 페치

| 소스     | 엔드포인트                                                                                           | 댓글 수                                     |
| -------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| HN       | `https://hacker-news.firebaseio.com/v0/topstories.json` → 30건 → 각 `/item/{id}.json` (병렬 batched) | `kids.len()` 또는 `descendants`             |
| GeekNews | `https://news.hada.io/rss` (RSS)                                                                     | 댓글 수는 RSS에 없음 — `None` (제목·링크만) |
| Lobsters | `https://lobste.rs/hottest.json`                                                                     | `comment_count` 필드                        |

각 페치는 10s timeout, 실패 시 지수 백오프 최대 3회 → 그 주기는 skip, 다음 15분 주기에 재시도. terminal failure는 `news_fetch_failed` IPC event로 표면.

### Storage (sqlx-sqlite 마이그레이션)

```sql
CREATE TABLE news_items (
    source TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    comments_url TEXT,
    comment_count INTEGER,
    posted_at TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (source, external_id)
);
CREATE INDEX news_items_fetched_at ON news_items(fetched_at DESC);

CREATE TABLE news_source_pref (
    source TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 1
);
```

- Upsert: `INSERT ... ON CONFLICT(source, external_id) DO UPDATE SET title=..., comment_count=..., fetched_at=...`
- 정리: `fetched_at < now() - 7days` 행은 nightly purge (별도 backend task 없이 fetch_loop tick 시작 시 cleanup 호출)

### IPC (tauri-specta)

```rust
#[tauri::command]
#[specta::specta]
pub async fn news_list_recent(state: AppState, limit: u32) -> AppResult<Vec<NewsItem>>;

#[tauri::command]
#[specta::specta]
pub async fn news_sources_available(state: AppState) -> AppResult<Vec<NewsSourceMeta>>;
// NewsSourceMeta { id, label, enabled }

#[tauri::command]
#[specta::specta]
pub async fn news_sources_set_enabled(state: AppState, source: String, enabled: bool) -> AppResult<()>;
```

이벤트: `news_items_updated` (fetch 성공 시 frontend invalidate trigger), `news_fetch_failed { source, error }`

### Done-criteria

- `cargo test --lib commands::news::` 통과
- `news_list_recent` 호출 → 활성 소스 합본 정렬(`posted_at DESC`) 반환
- 한 소스 OFF → 다음 페치부터 그 소스 fetch skip + 기존 캐시 행은 조회에서 제외
- 모든 소스 페치 실패해도 앱은 정상 동작(빈 배열 반환)

## 6. PR C — 티커 UI + 설정

### 컴포넌트

```
src/components/news/
  NewsTicker.tsx        // 하단 풀폭 마퀴
  NewsSourceSettings.tsx // 설정 다이얼로그 신규 섹션
  useNewsList.ts         // RQ hook (news_list_recent)
  useNewsSources.ts      // RQ hook (available + set_enabled)
```

### 마퀴 구현

- 단일 track: `div.ticker-track`이 같은 콘텐츠 두 번 렌더 → `animation: ticker-scroll 30s linear infinite` `transform: translateX(0) → translateX(-50%)` 로 seamless
- hover: `:hover { animation-play-state: paused }`
- 아이템 마크업:
  ```tsx
  <button className="ticker-item" onClick={() => openUrl(item.url)}>
    <span className="src-badge src-{item.source}">{label}</span>
    <span className="title">{item.title}</span>
    {item.commentCount != null && <span className="cmt">💬 {item.commentCount}</span>}
  </button>
  ```
- 클릭: `@tauri-apps/plugin-shell` `openUrl(item.url)` (현재 사용 패턴 확인 후 통일)
- 빈 상태: 활성 소스 0개 → "뉴스 소스가 꺼져 있습니다 — 설정에서 선택" subtle 텍스트(중앙 정렬, no animation)

### 시각

- 높이: 40px
- 배경: `wr-bg`, 상단 보더 1px `wr-border-light`
- 아이템 간 separator: `·` (15px wr-border)
- 소스 배지: 10px caps mono, color-on-source: HN=오렌지(#ff6600 wash), GeekNews=Cohere 그린(`wr-green`), Lobsters=레드(#ac130d wash)
- 제목: 13px sans, `wr-fg`, hover에서 `wr-accent`
- 댓글 수: 11px mono, `wr-subtle`

### 설정 다이얼로그

- 기존 Settings(`SettingsModal.tsx` 또는 동등) 내 신규 섹션 "뉴스 소스"
- 체크박스 리스트(소스명 + 활성 토글) — `news_sources_available()` 결과로 렌더
- 토글 즉시 `news_sources_set_enabled` 호출, 성공 시 `useNewsList` invalidate

### Done-criteria

- 티커가 30s 주기로 부드럽게 좌측 스크롤, hover 일시정지
- 클릭 → OS 기본 브라우저로 URL 열림(cmux 환경 변수 노출 없음)
- 설정에서 소스 토글 → 즉시 티커 콘텐츠 갱신(소스 OFF 시 해당 출처 제거)
- 빈 상태 메시지 표시 확인

## 7. 비결정 사항(나중에 결정)

- 갱신 주기 사용자 설정 노출 시점
- 키워드 필터(예: "AI", "Tauri" 만)
- 즐겨찾기/읽음 표시
- 시간대(KST 외)
- 사용자 추가 소스(custom RSS)

## 8. 위험·트레이드오프

- **마퀴 접근성**: 스크린 리더 사용자에게 무한 애니메이션은 노이즈. → `prefers-reduced-motion: reduce` 시 정적 리스트(처음 5개)로 폴백, 6초마다 다음 set으로 fade.
- **외부 API 변동**: HN Firebase 미보장 SLA, RSS 파싱 fragile. → `news_fetch_failed` event를 디버그 토스트로 surface (사용자 신뢰 유지).
- **새 백그라운드 태스크**: 앱 전체 lifecycle에 영향. → fetch_loop은 tokio task로 띄우고 `AppHandle` drop 시 cleanup. 단위 테스트로 한 사이클 검증.
- **설정 다이얼로그 비대화**: 신규 섹션 추가 — 기존 NavigationSettings 패턴 검토 후 합류 결정(스펙 C 작업 첫 단계).

## 9. 결정 로그(`docs/decisions.md`에 1줄)

> 2026-05-25: 매트릭스 중앙 BrainDump 토글 + 하단 뉴스 티커(HN/GeekNews/Lobsters, 15분 주기, 글로벌 설정). spec: `docs/specs/2026-05-25-brain-dump-toggle-and-news-ticker-design.md`. 3개 PR(A·B·C) 순차.
