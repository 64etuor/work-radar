# Generalization Track — 범용 프로그램화 (2026-07-10)

목표: work-radar를 **원저자 환경(한국/KST/KRW, mirrorless, cmux/hermes/boule 스택) 밖의
사용자도 그대로 설치·설정·사용할 수 있는 범용 데스크톱 앱**으로 개조한다.
전제(4-way 감사 결과): 자격증명(키체인)·DB 경로·타임존 감지·빈 DB 부팅은 이미 일반적.
남은 결함을 단계별로 제거한다.

## 감사 요약 (2026-07-10, 4 병렬 스캔)

| 등급     | 발견                                                                                | 위치                                                                                                                |
| -------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| BLOCKER  | `.mmbak` 임포트가 `Asia/Seoul` 무조건 변환 → 타 TZ 사용자 날짜/월 버킷 오염         | `moneymanager.rs:464-478`                                                                                           |
| BLOCKER  | 기본통화 KRW 하드코딩 (설정 불가)                                                   | `commands/bookkeeping/common.rs:9`, `mcp/tools/bookkeeping.rs:493`, `moneymanager.rs:19`, FE `bookkeepingFormat.ts` |
| BLOCKER  | FE 통화 포맷이 `ko-KR` 로케일 강제 + 요일/날짜 한국어 하드코딩 6곳 중복             | `bookkeepingFormat.ts`, `ui/calendar.tsx:17` 외                                                                     |
| NOISE    | Boule 티커 스케줄러: CLI 부재 머신에서 30초마다 warn + heartbeat (due row 0개여도)  | `governance/ticker_scheduler.rs:213-231`                                                                            |
| NOISE    | 뉴스 기본값: geeknews(한국) 포함 전 소스 default-ON                                 | `news/pref_store.rs:21`                                                                                             |
| IDENTITY | 번들 ID/키체인 서비스 문자열이 2곳에 독립 선언 (drift 위험)                         | `lib.rs:709`, `keychain.rs:11`                                                                                      |
| DOCS     | LICENSE 없음, README=한국어 개발노트, 설치/설정 가이드 없음, 리브랜딩 절차 미문서화 | 루트                                                                                                                |
| DEFER    | 전면 i18n(~340파일/2.5–3.5k 문자열), 커스텀 RSS UI, 업데이터/서명 파이프라인        | —                                                                                                                   |

한국어 은행/카드 파서(`bookkeeping.rs:180-540`)는 매칭 실패 시 `needs_review`로
우아하게 강등되므로 **결함 아님** — 확장 포인트로만 문서화.

## Phases

### P1 — 아이덴티티 단일화 (identity single-source)

- `keychain.rs`의 SERVICE가 `lib.rs::APP_BUNDLE_IDENTIFIER`를 참조 (문자열 값 불변 —
  기존 설치의 키체인 토큰/앱데이터 경로 보존).
- 리브랜딩 체크리스트를 docs에 기록 (tauri.conf.json identifier와 동기 필수 지점 전부).

### P2 — 신선한 머신 소음 제거

- Boule 티커: runner resolve를 **`tick_enabled` 행 존재 게이트 뒤로** 이동(as-built —
  계획 초안의 "warn 1회만" 대신 게이트를 택했다: 미사용 머신은 resolve 자체를 안 하므로
  로그도 `runner_ok=false` 거짓 표시도 사라진다). 저자 환경(Boule 존재) 동작 불변.
- 뉴스 소스 기본값: `NewsSource::default_enabled()`(trait 기본 false) + 마이그레이션 0072가
  뉴스가 실제 흘렀던 기존 설치에만 explicit enabled row를 심어 현 동작 보존 → 신규 설치는
  `hn`/`lobsters`만 ON(`geeknews` 포함 나머지 OFF).

### P3 — 부기(bookkeeping) 비한국 사용자 정확성

- mmbak TZ: `seoul_local/seoul_month` → tz 파라미터 주입, 커맨드 레이어가 시스템 TZ 감지
  SSOT를 넘긴다 (KST 머신에서는 결과 동일 = 저자 무영향). _후속 트랙에서 이 SSOT는
  crate 레벨 `src/timezone.rs`로 승격됐다._
- 기본통화 설정: `app_config` 키 `bookkeeping.default_currency` (미설정 = "KRW" = 행동 보존)
  — Rust 통화 진입점 전부(생성/ingest/고정비/예산/정산) + MCP + 설정 UI 카드 + FE 드래프트.

### P4 — FE 로케일 포맷 중앙화 (refactor)

- `src/lib/localeFormat.ts` 신설: `APP_LOCALE`(**ko-KR 고정** — UI 문안이 한국어인 동안
  머신 로케일을 따르면 혼종 UI가 된다) + Intl 파생 요일 라벨 + 월-일 포맷.
- 하드코딩 수렴: `ui/calendar.tsx`, `board/CalendarView`, `CalendarDrawer`,
  `today/HistoryRail`, `today/TimelineCanvas`, `lib/sprint.ts`, `bookkeepingFormat.ts`,
  `agentUsage.ts`, `reconciliation.ts`.
- 출력 동일(월/화/… , N월 D일) = 저자 무영향. 향후 i18n의 단일 노브.

### P5 — 배포 문서/레포 위생

- README 개편(제품 소개 + 빠른 시작 + 필수 외부 설정 안내), `docs/SETUP.md`
  (Google OAuth client 생성, Notion/GitHub 토큰, 선택 도구: codex/cmux/hermes/boule),
  리브랜딩 가이드. LICENSE는 법적 결정이므로 **사용자에게 위임** (gap으로 명시).
- 개인 아티팩트(`poc.html`, `progress.txt`, `mockups/`)는 삭제하지 않고 README에서
  개발 노트로 구분만 명시 (파괴적 정리는 사용자 결정).

### P6 — 검증 + 별도 critic 패스

- `cargo fmt --check` / `clippy -D warnings` / `cargo test` → `pnpm lint` / `pnpm build`
  → `pnpm typecheck` **마지막 재실행** (cargo test가 bindings.ts 재생성하므로).
- INVARIANT 7개 위반 여부는 별도 reviewer 패스 (self-approve 금지).

## Non-goals (명시적 defer)

- 전면 i18n (P4가 구조적 선행 작업 — 포맷 단일 노브까지만).
- 커스텀 RSS 소스 UI (빌드타임 상수 정책 변경은 news-feature.md 개정 필요).
- 자동 업데이터·코드사이닝·릴리스 CI (배포 인프라 결정 필요).
- `governance/` 분리 (저자의 활성 하네스 — 별도 레포 후보로만 기록).
- 번들 ID 실제 변경 (기존 설치 파괴 — 체크리스트만 제공).
