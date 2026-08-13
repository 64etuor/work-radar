# News Feature

뉴스 티커는 6-PR 피처(2026-05-25), **전부 dev 머지 완료**. 이 문서는 이 도메인의
구조·결정·잔존 follow-up을 모아둔다.

## 상태 요약

- **PR A** `35094c2` — BrainDump 원형 토글 + 펄스/펼침 (frontend).
- **PR B** `1da6060` — Rust 뉴스 페처 백엔드.
- **PR C** `bda20a2` — 뉴스 티커 UI + 설정.
- **cleanup** `86a54ce` — HTTP classify helper, per-tick info, keepPreviousData.
- **tests** `f0add7a` — `classify_http_status` 8 unit tests.
- **D-Safe** `a6b662a` — 키워드 필터 include/exclude.
- **D-Expand** `b105c0d` — 소스 10개 확장 + `GenericRssSource` 어댑터 + `NewsCategory` 메타.
- **D-Tune** `e37062b` — 글로벌 옵션(한도/정렬/주기) + `tokio::sync::Notify` 즉시 적용 + fetcher refactor.

## 데이터 / 마이그레이션

- `0016_news_items.sql` — 코어 테이블
- `0017_news_source_pref.sql` — 소스 선호
- `0018_news_keyword_filters.sql` — include/exclude 키워드
- `0019_news_source_pref_default_off.sql` — 확장 소스 seed `enabled=0` + index
- `0020_news_options.sql` — 단일 row global options
- `0021_news_marquee_seconds.sql`
- `0022_news_hot_only.sql`

`news_options`는 **단일 row** + `options_store::get/set` UPSERT(멱등). 새 옵션은
add column + 동일 row UPDATE.

## 키워드 필터 안전 가드

`LIKE ... ESCAPE '\'` + `like_escape()` (% / \_ / \ 안전). critic MAJOR fix. SQL
injection-by-pattern 방어. 9 store tests.

## 소스 어댑터

- `GenericRssSource` 어댑터 + `NewsCategory` 메타로 소스별 코드 중복 제거.
- 현재 10개: NAVER D2, 카카오, 우아한형제들, 토스, LINE, 요즘IT, r/programming, dev.to,
  arXiv cs.LG, cs.AI.
- arXiv는 HTTPS 강제.
- Reddit는 per-source UA.
- 시간 정보 없는 항목은 timestamp drop (no `Utc::now` fallback — 결정론).

## Fetcher 구조 (D-Tune)

- `tokio::sync::Notify` — 옵션 변경 시 즉시 적용(다음 tick 안 기다림).
- `build_ticker` + `select_next_wake` + `WakeReason` production helpers.
- `MissedTickBehavior::Delay` explicit (park 모드 1h safety net).
- `store::list_recent(opts, filters)` — ROW_NUMBER per-source 캡, `&'static str` order_clause,
  `external_id DESC` tiebreak.
- IPC: `news_list_recent()` (breaking change 의도적).

## 프런트 (`src/components/news/NewsTicker.tsx`, `src/lib/newsTicker*.ts`)

- `NewsOptionsForm` — NaN/decimal guard.
- `keepPreviousData` (TanStack Query) — refresh 시 깜빡임 방지.
- 카테고리 그룹화 표시 — 설정 패널.
- `src/lib/newsTickerPlacement.test.ts` + `newsTickerRefresh.test.ts` 보유.

## INVARIANT 충족

- **#1 결정 레일 침범 없음** — 뉴스는 자기 뷰만, 매트릭스 escalate 0.
- **#3 dedup** — `external_id` (per-source) 기반 upsert.
- **#5 bounded** — fetcher가 단일 tokio task, bounded retry + interval.
- **응답 예산** — 성공 본문은 압축 해제 후 2 MiB 상한을 스트리밍 중 강제하고, 비-2xx 본문은
  로그/에러에 복사하지 않는다. RSS 파싱은 blocking pool로 격리하며 `feed-rs 2.4` 계열을 사용한다.

## 잔존 follow-up (비차단)

D-Tune review 후속:

- **MAJOR-1 (N1) reconfig fetch UX**: interval 변경 시 새 주기 시작점 reset. 옵션 변경 시
  `tick()` 즉시 호출 검토 — 도그푸드 후 결정.
- **MINOR-5 (N6) PARK_TIMEOUT 통합 테스트**: park-mode 1h safety net wake 직접 검증.

D-Tune NIT (deferred):

- `WakeReason` `pub(crate)` → newtype 래퍼로 정리(가시성).
- `OptionsNotify` newtype 래퍼(Tauri managed state 충돌 회피).
- `select_next_wake` borrow checker 가이드 doc comment.

기존:

- arXiv RSS 첫 tick 후 사용자 콘솔/DB 검증.
- Reddit 403 시 대체 UA 시도.
- 사용자 정의 RSS URL 입력 (out-of-scope).
- PR A: cmux 브라우저 스모크 (Esc → 토글만 닫힘 + `window.hide` 미호출 + 트리거 포커스 복원).
- D-\* PR: `pnpm tauri dev` 부팅 스모크 (controller가 implementer에 skip 지시).

## 정본 / 참조

- `docs/plans/2026-05-25-news-customization.md` — 전체 D-시리즈 플랜
- `docs/plans/2026-05-25-news-fetcher-pr-b.md` — PR B handoff
- `src-tauri/src/news/` — 어댑터 + fetcher + store
- `src-tauri/src/commands/news.rs` — IPC 표면
- `~/.claude/projects/-Users-davidpark-private-project-work-radar/memory/news-ticker-feature-state.md`
