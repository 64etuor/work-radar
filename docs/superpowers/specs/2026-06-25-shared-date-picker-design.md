# 공용 날짜 선택기(DatePicker) — Design

- 날짜: 2026-06-25
- 상태: 구현 완료 · 독립 Opus critic ACCEPT-WITH-RESERVATIONS(코드 blocker 0; Minor#1 open-focus 수정+테스트 완료) · 전 게이트 green · **미커밋** · 잔여 게이트=cmux Esc 스모크(사용자)
- 도메인: 프런트 UI 프리미티브 (`src/components/ui/**`) → area-map row 8 + `docs/areas/shadcn-migration.md`
- 관련 정본: `DESIGN.md` §calendar-drawer / §App Surface, `docs/areas/shadcn-migration.md`(Esc·overlay-stack)

## 1. 문제 / 목표

날짜 **입력**이 네이티브 `<input type="date">`로 돼 있어 OS 기본 모양이라 Cohere 화이트
에디토리얼 디자인과 어긋난다. 전역에서 재사용할 **디자인 일치 날짜 선택기**를 만들어 네이티브
date 입력을 통일한다.

현재 소비처(전부 단일 날짜 필드):

- 루틴 폼: `startDate`, `endDate` (2)
- 가계부: 리뷰 필터 `fromDate`/`toDate`, 지출일 `spentAt`(×2), 정산일 `statementDate` (5)

→ from/to "범위"도 독립된 단일 입력 2개라 **단일 날짜 피커 하나로 모든 소비처 커버**(범위=피커 2개).

## 2. 합의된 결정 (brainstorm)

1. **용도 = 날짜 선택기**(date picker), 이벤트 뷰 아님(그건 기존 `CalendarView`가 담당).
2. **자체 제작**(shadcn `Calendar`/react-day-picker 미설치). 근거:
   - 프로젝트는 **의도적으로 날짜 라이브러리 0**(date-fns/dayjs/react-day-picker 전무) — Date 객체
     패러다임 유입 회피.
   - 월-그리드 헬퍼가 **이미 검증돼 있음**: `src/lib/calendarRange.ts`(`monthGridDays`/`weekDays`/
     `addDays`/`addMonths`/`parseLocalISODate`/`toLocalISODate`)를 `CalendarView`가 이미 사용.
   - `ui/popover.tsx`(Radix Popover, Esc·overlay-stack 계약 내장) 이미 존재 → 그 위에 조립.
   - 디자인 완전 제어(Cohere 화이트), `CalendarView`와 시각 통일.

## 3. 컴포넌트 (2개, `src/components/ui/`)

작은 단위 2개로 분리: 순수 그리드(표시/선택) + 팝오버 래퍼(입력 대체). 각각 독립 테스트.

### 3a. `calendar.tsx` — 순수 월 그리드 (상태 최소)

"한 달"을 그려 날짜 1개 선택. **표시/선택만** — fetch/영속 없음.

```ts
type CalendarProps = {
  /** 선택된 날짜 'YYYY-MM-DD' | null. */
  selected: string | null;
  /** 날짜 클릭/Enter 선택. */
  onSelect: (date: string) => void;
  /** 보이는 달의 기준 'YYYY-MM-DD'. 비제어면 selected ?? today로 내부 초기화. */
  month?: string;
  onMonthChange?: (month: string) => void;
  /** 이 범위 밖 날짜는 비활성(클릭/포커스 불가). end≥start 같은 교차 제약에 사용. */
  min?: string;
  max?: string;
  /** 오늘 하이라이트 기준(테스트 주입용; 기본 = 로컬 오늘). */
  today?: string;
};
```

- 레이아웃: 헤더(`‹` 월 라벨 `›`) + 요일 행(월~일, `weekDays`) + 6×7 셀(`monthGridDays`).
  당월 외 날짜는 흐리게, `today` 표식, `selected` 강조. DESIGN.md calendar-drawer 시각 언어
  (Mono 라벨·hairline 보더·흰 캔버스·radius sm) 따름.
- 키보드: 화살표=포커스 일 이동(주 경계 넘어가면 `addDays`), Enter/Space=선택, PageUp/Down=
  `addMonths(±1)`, Home/End=주 시작/끝. roving tabindex.
- a11y: `role="grid"`, 셀은 `role="gridcell"` 버튼 + `aria-selected`, 비활성은 `aria-disabled`.
- 순수 — `month` 비제어 시 내부 state 1개(보이는 달)만. 선택/제약은 props.

### 3b. `date-picker.tsx` — `<input type="date">` 드롭인 대체

트리거 버튼 + `Popover`(`PopoverTrigger`/`PopoverContent`) 안에 `Calendar`.

```ts
type DatePickerProps = {
  value: string | null; // 'YYYY-MM-DD' | null
  onChange: (date: string | null) => void;
  placeholder?: string; // 빈 값 라벨(예: "날짜")
  min?: string;
  max?: string;
  disabled?: boolean;
  id?: string; // <label htmlFor> 연결
  ariaLabel?: string;
  /** 값 지우기 허용(기본 true) — 빈 날짜 = null. */
  clearable?: boolean;
};
```

- 트리거: 선택값을 `YYYY.MM.DD`(점 구분, 순수 문자열 변환 — 로캘 라이브러리 없음)로 표시, 없으면
  placeholder. `Input`과 같은 높이/토큰(`h-8 text-xs` 등 소비처 클래스 override 허용).
- 날짜 선택 시 `onChange` + 팝오버 닫힘. clearable면 "지우기"로 `onChange(null)`.
- Esc/바깥 클릭 닫힘·포커스 복원은 **Popover 프리미티브가 이미 보증**(overlay-stack 계약).
  shadcn-migration.md: Popover 추가이므로 **cmux Esc 스모크** 대상.

## 4. 와이어링 (네이티브 date 입력 → DatePicker)

한 관심사 = "네이티브 date 입력을 브랜드 피커로 통일".

- `RoutineForm.tsx`: 시작/종료 `Input type=date` → `DatePicker` 2개. `end` 피커에 `min={startDate}`,
  `start` 피커에 `max={endDate}`(기존 native min/max 미러) + 기존 제출 검증(end<start 차단) 유지.
- `BookkeepingView.tsx`: 필터 from/to, `spentAt`×2, `statementDate` 5곳 → `DatePicker`.
  (가계부는 area-map row 18 — 닿는 김에 ipc/data 규율 변화 없음, 순수 프런트 입력 교체.)

값 계약은 동일(`'YYYY-MM-DD'` 문자열) — onChange 시그니처만 `(string|null)`이라 빈 값 처리
명시적(기존 `e.target.value` === "" 와 동치).

## 5. 시각 / 디자인 토큰

- `DESIGN.md` §calendar-drawer 언어 재사용: Mono 라벨, `‹ 오늘 ›`류 네비, hairline 보더, 흰
  캔버스, radius sm 셀. `CalendarView`와 동일 톤(중복 시각 언어 방지).
- **design-token 게이트**(`scripts/check-design-tokens.mjs`, TSX 대상): raw hex/이모지 금지, Tailwind
  v4 `@theme` 토큰만. 신규 TSX 2개가 이 게이트를 통과해야 한다.

## 6. 테스트

- `calendar.test.tsx`(happy-dom): 월 렌더(셀 수/요일), prev/next 월 이동, `selected`/`today` 표식,
  `min`/`max` 밖 비활성(클릭 무반응), 키보드(화살표 이동·Enter 선택·PageUp 월 이동).
- `date-picker.dom.test.tsx`: 트리거 클릭→팝오버 열림→날짜 클릭→`onChange('YYYY-MM-DD')`+닫힘,
  clear→`onChange(null)`, 빈 값=placeholder 표시. (Esc 닫힘은 Popover 계약 — 스모크는 cmux.)
- 회귀: `RoutinesPanel.dom.test.tsx`의 기간 테스트 4개는 `input[type="date"]`를 쿼리하므로 네이티브
  입력 제거 시 **반드시** DatePicker 상호작용(트리거 클릭→그리드 날짜 클릭)으로 재작성해야 한다.
  end<start 제출 차단 + 편집 시드 검증의 의도는 유지하되 셀렉터/조작을 DatePicker에 맞춘다.
- 게이트: `pnpm typecheck`/`pnpm lint`/`pnpm vitest run` + design-token 검사 + **cmux Esc 스모크**.

## 7. 범위 밖 (YAGNI / deferred)

- **범위(range) 드래그 선택 UI** — 현재 모든 소비처가 2-필드라 불필요. `Calendar` 그리드는 나중에
  `mode="range"` 얹을 수 있게 설계하되 v1 미구현.
- 시간 선택(time) 통합 — 루틴 폼 시각은 별도 `type=time` 유지(이 작업 무관).
- 다국어/로캘 포맷 — 로컬 `YYYY-MM-DD` + 한글 표기 고정(프로젝트 관례).
- `CalendarView`(이벤트 뷰) 리팩터 — 별개. 단, 공유 그리드 추출은 추후 옵션으로 남김(지금은
  picker 전용 `calendar.tsx`, CalendarView 무손상).

## 8. 결정 레일 / INVARIANT 점검

- 순수 프런트 UI — IPC/스키마/네트워크/토큰 무관(#1/#5/#7 무관). 새 의존성 0.
- `bindings.ts` 변화 없음(새 커맨드 없음).
- shadcn-migration 계약: Popover 위 조립이므로 Esc·overlay-stack은 프리미티브가 보증, cmux 스모크 필요.
- self-approve 금지 — 구현 후 별도 reviewer 패스.
