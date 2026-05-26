
# Frontend — Capture Board

캡처 보드는 앱의 THESIS 표면. **공간형 포스트잇 보드**로 INVARIANT #1(결정 레일은 사람)을
인터랙션으로 표현한다.

## 5영역 레이아웃

흐름: **캡처(하단) → 미분류(좌) → 결정 2×2(중앙) → 실행(우: Today 위 / Routines 아래)**.

- 좌 = INBOX(미분류) — 카스케이드/그리드
- 중앙 = 아이젠하워 2×2 — 결정 큐 (드래그 분류, 카드는 항상 unclassified 진입)
- 우 상 = Today's Todo 레일
- 우 하 = Routines 패널
- 하단 = brain-dump 캡처 패널

비중: 2×2가 가로의 60%+ (min 440px). INBOX·실행 컬럼은 슬림 고정(~178px, ~250px).
권장 최소 창폭 ~1040px.

## 반응형 (3단계)

- ≥1040px = 3컬럼 + 하단 캡처바
- 720–1040px = 우측 컬럼을 Today·Routines **세그먼트 탭**으로 합쳐 1패널
- <720px = 세로 스택 (미분류 트레이 → 2×2 → Today → Routines + 하단 캡처바)

## 결정 레일 (INVARIANT #1)

- 카드는 **항상 `unclassified`로 생성** — `create_signal`은 quadrant 인자 없음.
- 분류는 **드래그**(주) 또는 포커스 후 `1/2/3/4`(가속) — `classify_signal` 커맨드만.
- AI/Codex는 quadrant 자동 확정 0건. `suggestedQuadrant`/`suggestedArea`는 힌트.

## Today 멤버십

- 매트릭스 카드 → Today 레일 드래그 또는 카드 액션 "Today 추가" → `signal.today_for_date` 토글.
- Today 승격은 **로컬 액션** → Acceptance 게이트 불요(외부 변경 아님).
- 카드는 매트릭스에서 제거(이동), 원 `quadrant`는 Q1~Q4 배지로 유지.
- 완료(체크) + 미완료 다음날 rollover. 경과일 `+N = (오늘 − today_for_date) + 1` 프런트 계산.
- 되돌리기(`Cmd+Z` 또는 버튼) → 원 quadrant 복원(없으면 unclassified), 카운터 리셋.

## Routines

- 매일 / 매주 요일 / 격주 / 월간 스케줄. `RoutineCheck(routineId, date)`로 날짜별 완료.
- 다음날 새 date → 자동 리셋(재등장). WorkSignal과 별개 엔티티.
- 알림은 `notification_store` 경유(scheduler tick 발사).

## Esc 계약 (load-bearing)

App.tsx Esc 핸들러가 `getCurrentWindow().hide()`를 호출한다. 보드는 여러 layer를 가짐:

1. **`overlay-stack`**(`src/components/ui/overlay-stack.ts`) — 열린 radix Dialog/Dropdown/Select가
   등록되어 있으면 App.tsx가 hide를 양보. 신규 모달/메뉴는 PR 0 래퍼 사용.
2. **CardMenu** — 자체 anchor 메뉴(Wave 2.5 Option E: overlay-stack 계약만 채택, 싱글톤 keep).
   `.cb-card-menu` 체크 제거 후 overlay-stack으로만 보호.
3. **MatrixCanvas postit-edit** — 부모 `.postit` `overflow:hidden`이 textarea 링을 클립.
   capture-Esc로 키스트로크 캡처(Wave 5.20에서 무변환 결정). 외부 라이브러리 위 강제 변환 금지.
4. **CalendarDrawer** — 자체 capture-Esc + `stopPropagation`이 App bubble hide를 차단.
   Wave 5.23에서 트리거 포커스 복원 추가. radix Dialog로 변환 금지(반응형 사이드시트 구조 깸).

상세: `docs/areas/shadcn-migration.md` § "radix Dialog Esc 계약".

## 보호 대상 (변경 금지·신중 변경)

- **`MatrixCanvas.tsx`** — 3 프리미티브 전부 bespoke(Wave 5.20 무변환). 결정레일 핸들러 무변경.
- **`CalendarDrawer.tsx` 셸** — 자체 Esc 계약 정확. 내부 버튼만 shadcn으로 변환된 상태.
- **`BrainDumpToggle.tsx`** — 펄스/펼침 애니메이션, PR A 본체.

## CSS namespace

- `.cb-*`(capture board), `.postit*`, `.cb-card-menu`, `.today-*`, `.routines-*`, `.cal-*`.
- 토큰만 사용(`--color-wr-*`). 하드코딩 hex 0.
- 흰 캔버스 위 카드 분리용 **절제된 Media Lift 그림자** 한정 예외(`0 8px 22px rgba(15,20,40,.12)`).

## 카드 액션 메뉴

`⋯` / `Cmd+K` / 우클릭으로 카드에서 파생. 메뉴 항목:

- 백로그 등록 · 안건 승격 · 캘린더 등록 = `Promotion` draft만(Acceptance 대기)
- **Today 추가** = 로컬 즉시
- 미루기/완료/보관(`S`/`D`/`E`)

외부 승격(notion/calendar)은 외부를 직접 바꾸지 않는다 — Acceptance 대기.

## 보드 디자인 정본

- 컴포넌트·토큰: `DESIGN.md` § App Surface — Capture Board
- 인터랙션 레퍼런스(가짜 데스크톱 배경은 설명용 — 실제 셸은 불투명 단일 창):
  `docs/prototypes/capture-board.html`

## 정본 / 참조

- `DESIGN.md` § App Surface — Capture Board
- `docs/architecture.md` §4 (Today/Routines 데이터 모델)
- `PLAN.md` Phase 1
- `docs/decisions.md` "Phase 1 인터랙션 / 구현"
- `docs/areas/shadcn-migration.md` — bespoke-keep, Esc 계약
