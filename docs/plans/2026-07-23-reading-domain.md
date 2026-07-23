# Reading domain (독서 기록) — 설계 정본

- 날짜: 2026-07-23
- 상태: 구현과 동시 착지 (사용자 전권 위임 — "서지 API + MCP + 완독 트래킹 + 창의 기능 알아서")
- 레퍼런스: 사용자 옵시디언 볼트 `200_Books/독서 대시보드.md` (Dataview 대시보드 — 기능 패리티 원본)

## 목표

읽은 책/읽을 책을 등록하고 완독을 트래킹하는 로컬 독서 기록 도메인. 서지 정보는
외부 카탈로그 API에서 가져오되(수기 입력 폴백), 사용자의 기존 옵시디언 독서
대시보드가 제공하던 표면(통계·연간 목표 페이스·서가·명예의 전당·히트맵)을 앱
네이티브로 재현·개선한다.

## 옵시디언 패리티 맵

| 옵시디언 대시보드                                                             | work-radar                                      |
| ----------------------------------------------------------------------------- | ----------------------------------------------- |
| Summary(전체/완료/진행/계획/평균 별점/총 페이지)                              | 통계 헤더 KPI (`reading_stats`)                 |
| 올해 독서 목표(링 + 페이스 + 월별 차트, GOAL=52 하드코딩)                     | `reading_goals` 테이블(연도별) + 링/페이스/차트 |
| 읽고 있는 책 / 읽을 책 / 읽은 책 카드                                         | 서가 3단(reading/to_read/finished) + 진행바     |
| 명예의 전당(별점 0–10 → S/A/B/C/D 티어)                                       | 동일 티어 규칙 재현(rating 0–10 유지)           |
| 독서 히트맵(start~finish 구간 보간)                                           | **개선**: `reading_sessions` 실측 기록 기반     |
| frontmatter(title/author/total_page/cover_url/my_rate/start·finish_read_date) | `books` 컬럼 1:1 대응                           |

## 서지 API 선택

- **Google Books Volumes API** (기본): 키 불요, ISBN·제목 검색, 한국어 서적 커버리지 실용적.
  `GET https://www.googleapis.com/books/v1/volumes?q=…` (고정 엔드포인트, HTTPS).
- **Open Library Search API** (폴백): 키 불요. Google 결과 0건/실패 시.
  `GET https://openlibrary.org/search.json?q=…` + `covers.openlibrary.org` 표지.
- 알라딘 TTB / 네이버 책(국내 최적이나 **API 키 필요**)은 deferred — keychain 인프라는
  있으나 설정 UI 스코프가 커서 후속(ADR-0013 참조).
- 규율: 호출은 Rust만(ipc-conventions), caller가 URL/host를 못 정함(쿼리 텍스트만),
  bounded retry(5xx/네트워크=transient, 4xx=terminal), timeout 10s, 응답 크기 상한 2MB,
  로그는 상태코드+크기만.

## 스키마 (migration 0074_reading_foundation.sql)

- `books` — 서지(제목/저자 JSON/출판사/출간일/ISBN/쪽수/표지/설명/카테고리 JSON/언어/출처),
  상태(`to_read|reading|finished|abandoned`), `rating REAL 0..10`(옵시디언 my_rate 호환),
  `review`, `started_on`/`finished_on`, `current_page`. `isbn13` unique partial index =
  dedup upsert 대상(INVARIANT #3 정신 — 같은 책 재등록 시 기존 행 반환).
- `reading_sessions` — 날짜별 독서 사실 로그(`end_page`(세션 후 위치)/`minutes`/`note`).
  진행률·히트맵·스트릭의 SSOT. 세션 기록 시 `books.current_page`를 전진시킨다(후퇴는
  book patch로만 — 세션은 사실 기록).
- `book_quotes` — 발췌(quote/page/`thought`(내 생각)/favorite).
- `reading_goals` — `year` PK + `target_books`. 페이스 계산은 프런트(오늘 날짜 주입 규율).

상태 전이는 `set_book_status`가 소유: `reading` 진입 시 `started_on` 자동 스탬프(없으면),
`finished` 진입 시 `finished_on` 스탬프 + `current_page=page_count`(있으면). 되돌리기 허용
(finished→reading 시 finished_on 클리어).

## 커맨드 표면 (commands/reading/)

- `catalog.rs` — `search_book_catalog(query, limit)` (외부 GET; ISBN 감지 시 isbn: 쿼리).
- `books.rs` — `add_book`(dedup-by-isbn13, `{book, created}` 반환) / `list_books(status?,
query?)` / `get_book_detail(id)`(book+sessions+quotes) / `update_book`(patch) /
  `set_book_status` / `delete_book`(하드 삭제 — 앱 UI 전용, confirm 후).
- `sessions.rs` — `log_reading_session` / `delete_reading_session`.
- `quotes.rs` — `add_book_quote` / `delete_book_quote`.
- `stats.rs` — `reading_stats(year)`(KPI+월별 완독+히트맵+스트릭+목표) / `set_reading_goal`.

계산 순수 로직(ISBN 정규화, 카탈로그 응답 파싱, 스트릭)은 `src-tauri/src/reading.rs` 커널.

## MCP (mcp/tools/reading.rs)

**사용자 위임 결정(2026-07-23, 이 트랙 발주 대화):** "읽은 책과 읽을 책 등을 등록하고
완독했는지 트래킹 + MCP에도" — 독서 도메인 로컬 write를 에이전트에 위임한다(diet/
bookkeeping 선례). 전 write가 로컬 SQLite(외부 mutate 0), 사람 게이트는 호스트 승인
UI(ADR-0012). `delete`는 표면에 없다(등록·기록·트래킹만).

툴: `wr_reading_search_catalog`(고정 provider 아웃바운드 — ADR-0013) / `wr_reading_add_book`
/ `wr_reading_list_books` / `wr_reading_get_book` / `wr_reading_set_status` /
`wr_reading_log_session` / `wr_reading_add_quote` / `wr_reading_stats` / `wr_reading_set_goal`.

## 프런트 (src/components/reading/)

`ReadingView`(셸+KPI+서가 구성) + `ReadingGoalCard`(목표 링/페이스/월별 차트) +
`ReadingHeatmap` + `BookShelf`(카드/별점/티어표) + `BookSearchDialog`(카탈로그 검색/수기
등록) + `BookDetailSheet`(상태/평점/리뷰/세션/인용/삭제). 쿼리 레이어
`src/lib/query/reading.ts`(diet 패턴 — 도메인 전체 invalidate). nav: view `reading`,
group `review`, icon `BookOpen`. 뷰 루트 `.rd { height:100% }` + `viewRootHeight.test.ts` 등록.

## 검증

`docs/reference/commands.md` 인덱스: cargo test(커널+커맨드+mcp 표면/스키마 스냅샷) +
clippy `-D warnings` + fmt + bindings drift + pnpm typecheck/lint/vitest. 실 카탈로그
API 라이브 스모크는 사용자(헤드리스 테스트는 파싱 픽스처로 네트워크 0).

## Deferred

- 알라딘 TTB/네이버 책 키 기반 provider(+ 설정 UI) — 국내 서지 품질 최적화.
- 옵시디언 볼트 기존 19권 임포트(frontmatter → books) — 별도 요청 시.
- 표지 이미지 로컬 캐시.
