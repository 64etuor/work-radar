# Today 타임라인 연속화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Today 타임라인을 자정 경계 없는 연속 스크롤(절대 분 축 + per-day lazy fetch)로 전환하고, 자정 걸침 블록 슬리버 버그를 근본 해결한다.

**Architecture:** 좌표계를 "앵커 날짜 00:00 기준 절대 분"으로 바꾸는 순수 모듈(`timeAxis`/`timelineCoords`)을 신설하고, 레이아웃·DnD·캔버스가 이를 공유한다. fetch는 기존 per-day 캐시 버킷(`["calendarEvents", date]` 등)을 유지하고 프런트에서 병합/dedup만 한다. Rust 변경 0.

**Tech Stack:** React 19 + TanStack Query(useQueries) + dnd-kit + vitest. 스펙: `docs/superpowers/specs/2026-06-11-continuous-timeline-design.md`

**검증 정본:** `docs/reference/commands.md` (`pnpm typecheck` / `pnpm lint` / `pnpm vitest run`)

---

## File Structure

| 파일                                                  | 역할                                                                                                                        |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Create `src/lib/timeAxis.ts`                          | 순수 날짜/분 축 헬퍼 (dayDiff, addDays, localDateOf, absMin, tzOffsetForDate, isoFromAbsMin)                                |
| Create `src/lib/timeAxis.test.ts`                     | 위 단위 테스트                                                                                                              |
| Create `src/lib/timelineCoords.ts`                    | DnD 픽셀↔ISO 순수 변환 (pixelToLocalIso, shiftIsoByPx, resizeIsoByPx, clampIsoToDate) — useTimelineDnd에서 추출+날짜 인지화 |
| Create `src/lib/timelineCoords.test.ts`               | 위 단위 테스트                                                                                                              |
| Modify `src/lib/timelineLayout.ts`                    | `computeLayout(blocks, anchorDate?)` — toMin → absMin                                                                       |
| Modify `src/lib/timelineLayout.test.ts`               | anchor + 자정 걸침 케이스                                                                                                   |
| Modify `src/lib/todayBlocks.ts`                       | 루틴 블록 id에 날짜 포함 + `buildTimelineBlocks`(멀티데이 병합/dedup)                                                       |
| Modify `src/lib/todayBlocks.test.ts`                  | dedup/루틴 id 케이스                                                                                                        |
| Modify `src/components/today/useTimelineDnd.ts`       | 좌표 함수를 timelineCoords로 위임, anchorDate/days opts, 루틴 occurrence 클램프, 캐시 패치 predicate화                      |
| Modify `src/components/today/TimelineBlock.tsx`       | DragData에 `blockId` 추가                                                                                                   |
| Modify `src/components/today/timelinePreview.ts`      | blockId 매칭 + anchor 전달                                                                                                  |
| Modify `src/components/today/timelinePreview.test.ts` | 갱신                                                                                                                        |
| Modify `src/components/today/TimelineCanvas.tsx`      | 멀티데이 그리드(dates[]), 날짜 separator, 절대 now 라인                                                                     |
| Modify `src/components/TodayView.tsx`                 | visibleDates state, useQueries 병합, 스크롤 관리(센터/prepend 보정/lazy extend)                                             |
| Modify `src/lib/query/calendar.ts`                    | `useCalendarEventsForDates(dates)`                                                                                          |
| Modify `src/lib/query/routines.ts`                    | `useTodayRoutinesForDates(dates)`                                                                                           |
| Modify `src/lib/query/timelineNotes.ts`               | `useTimelineNotesForDates(dates)`                                                                                           |
| Modify `src/components/TodayView.css`                 | 날짜 separator 스타일                                                                                                       |
| Modify `docs/decisions.md`                            | breadcrumb 한 줄                                                                                                            |

설계 결정(스펙 보완):

- **DOM 윈도잉 대신 로드 일수 캡(21일)** — 날짜당 블록 수가 작아(수십) 전체 렌더가 충분히 싸다. 캡 초과 시 viewport 반대편 끝 날짜를 드롭(스크롤 보정 동반). 스펙 §3의 "±1일 윈도잉" 의도(=DOM 상한)를 더 단순한 기제로 충족.
- **초기 로드 = [어제, 오늘, 내일] 3일** — 열자마자 위/아래 컨텍스트 확보, 즉시 prepend 트리거 방지.
- **앵커보다 이른 시작 블록(미로드 날짜에서 넘어온 이벤트)은 음수 topPx 허용** — 그리드 overflow가 자연 클리핑(캘린더 앱 표준 동작). 클램프 분기 불필요.
- **timelinePreview의 event 블록 id 매칭 버그(기존: `event:${eventId}`로 복합키와 불일치) 동반 수정** — DragData에 `blockId`를 실어 재구성 제거.

---

### Task 1: `src/lib/timeAxis.ts` — 순수 날짜/분 축

**Files:**

- Create: `src/lib/timeAxis.ts`
- Create: `src/lib/timeAxis.test.ts`

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/lib/timeAxis.test.ts
import { describe, expect, it } from "vitest";

import { absMin, addDays, dayDiff, isoFromAbsMin, localDateOf, tzOffsetForDate } from "./timeAxis";

describe("timeAxis", () => {
  it("dayDiff: 같은 날 0, 다음 날 1, 이전 날 -1, 월 경계", () => {
    expect(dayDiff("2026-06-11", "2026-06-11")).toBe(0);
    expect(dayDiff("2026-06-12", "2026-06-11")).toBe(1);
    expect(dayDiff("2026-06-10", "2026-06-11")).toBe(-1);
    expect(dayDiff("2026-07-01", "2026-06-30")).toBe(1);
  });

  it("addDays: 월/연 경계 통과", () => {
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-06-11", 0)).toBe("2026-06-11");
  });

  it("localDateOf: 로컬 ISO 앞 10자", () => {
    expect(localDateOf("2026-06-11T23:30:00+09:00")).toBe("2026-06-11");
    expect(localDateOf("2026-06-12T01:30:00")).toBe("2026-06-12");
  });

  it("absMin: 앵커 기준 절대 분 (자정 걸침이 양수 duration이 되는 근거)", () => {
    expect(absMin("2026-06-11T23:00:00", "2026-06-11")).toBe(23 * 60);
    expect(absMin("2026-06-12T01:30:00", "2026-06-11")).toBe(1440 + 90);
    expect(absMin("2026-06-10T23:00:00", "2026-06-11")).toBe(-60); // 앵커 이전 → 음수 허용
  });

  it("tzOffsetForDate: 해당 날짜 정오 기준 오프셋 문자열", () => {
    // KST 환경에서 +09:00. CI/로컬 모두 통과하도록 형식만 검증 + 자기일관성.
    expect(tzOffsetForDate("2026-06-11")).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(tzOffsetForDate("2026-06-11")).toBe(tzOffsetForDate("2026-06-12"));
  });

  it("isoFromAbsMin: 절대 분 → 날짜 넘김 포함 로컬 ISO(+offset)", () => {
    const off = tzOffsetForDate("2026-06-12");
    expect(isoFromAbsMin("2026-06-11", 1440 + 90)).toBe(`2026-06-12T01:30:00${off}`);
    expect(isoFromAbsMin("2026-06-11", 23 * 60)).toBe(
      `2026-06-11T23:00:00${tzOffsetForDate("2026-06-11")}`,
    );
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run src/lib/timeAxis.test.ts` / Expected: FAIL (module not found)

- [ ] **Step 3: 구현**

```ts
// src/lib/timeAxis.ts
/**
 * 연속 타임라인 절대 분(minute) 축 — 순수 날짜/시간 헬퍼.
 *
 * 본 코드베이스의 scheduledAt/이벤트 start는 전부 로컬-오프셋 ISO("YYYY-MM-DDTHH:MM:SS[+09:00]")로
 * 기록된다 — 날짜/시:분은 문자열 slice로 읽는다(`new Date(iso)` 재파싱은 UTC 변환 자정 off-by-one
 * 위험, todayBlocks.localDateOf와 동일 근거). 날짜 산술만 Date.UTC(타임존 무관 정수 산술)로 한다.
 */

/** 로컬-ISO에서 로컬 날짜(YYYY-MM-DD)만 추출. */
export function localDateOf(iso: string): string {
  return iso.slice(0, 10);
}

function utcMidnight(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** date − anchorDate (일 단위 정수). */
export function dayDiff(date: string, anchorDate: string): number {
  return Math.round((utcMidnight(date) - utcMidnight(anchorDate)) / 86_400_000);
}

/** date + n일 (YYYY-MM-DD). */
export function addDays(date: string, n: number): string {
  const d = new Date(utcMidnight(date) + n * 86_400_000);
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/** 로컬 ISO → 앵커 날짜 00:00 기준 절대 분. 앵커 이전 시작은 음수(렌더는 overflow 클리핑). */
export function absMin(iso: string, anchorDate: string): number {
  const h = Number(iso.slice(11, 13));
  const m = Number(iso.slice(14, 16));
  return dayDiff(localDateOf(iso), anchorDate) * 1440 + h * 60 + m;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 해당 날짜의 로컬 UTC 오프셋("+09:00"). 정오 기준 파싱 — DST 경계 off-by-one 회피
 * (기존 weekdayForDate와 동일 근거). KST는 상수지만 DST 지역 정합성 확보.
 */
export function tzOffsetForDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const min = -new Date(y, m - 1, d, 12).getTimezoneOffset();
  const sign = min >= 0 ? "+" : "-";
  const abs = Math.abs(min);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 앵커 + 절대 분 → RFC3339 로컬 ISO(해당 날짜의 오프셋). 백엔드 parse_from_rfc3339 호환. */
export function isoFromAbsMin(anchorDate: string, min: number): string {
  const dayIdx = Math.floor(min / 1440);
  const within = min - dayIdx * 1440;
  const date = addDays(anchorDate, dayIdx);
  const h = Math.floor(within / 60);
  const m = within % 60;
  return `${date}T${pad(h)}:${pad(m)}:00${tzOffsetForDate(date)}`;
}
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run src/lib/timeAxis.test.ts` / Expected: PASS
- [ ] **Step 5: Commit** — `git add src/lib/timeAxis.ts src/lib/timeAxis.test.ts && git commit -m "feat(today): timeAxis 절대 분 축 순수 헬퍼"`

---

### Task 2: `timelineLayout` — 날짜 인지 absMin + anchor

**Files:**

- Modify: `src/lib/timelineLayout.ts` (toMin → timeAxis.absMin, `computeLayout(blocks, anchorDate?)`)
- Modify: `src/lib/timelineLayout.test.ts`

- [ ] **Step 1: 실패하는 테스트 추가** (기존 케이스는 무인자 호출 유지 — 하위호환 확인)

```ts
// src/lib/timelineLayout.test.ts에 추가
describe("computeLayout — continuous axis (anchor)", () => {
  it("자정 걸침 블록: 단일 연속 박스, 양수 height (기존 20px 슬리버 버그 회귀 방지)", () => {
    const out = computeLayout(
      [make("x", "2026-06-11T23:00:00", "2026-06-12T01:30:00")],
      "2026-06-11",
    );
    expect(out[0].topPx).toBe(23 * 60);
    expect(out[0].heightPx).toBe(150); // 음수 duration → max(20, …) 슬리버가 아니라 실제 150분
  });

  it("anchor 이후 날짜 블록은 1440px 오프셋", () => {
    const out = computeLayout(
      [make("y", "2026-06-12T09:00:00", "2026-06-12T10:00:00")],
      "2026-06-11",
    );
    expect(out[0].topPx).toBe(1440 + 540);
  });

  it("자정을 가로지르는 겹침도 한 클러스터로 50/50 분할", () => {
    const out = computeLayout(
      [
        make("a", "2026-06-11T23:00:00", "2026-06-12T01:00:00"),
        make("b", "2026-06-11T23:30:00", "2026-06-12T00:30:00"),
      ],
      "2026-06-11",
    );
    expect(out.find((x) => x.id === "a")!.widthPct).toBe(50);
    expect(out.find((x) => x.id === "b")!.widthPct).toBe(50);
  });

  it("anchor 이전 시작 블록은 음수 topPx (그리드가 클리핑)", () => {
    const out = computeLayout(
      [make("z", "2026-06-10T23:00:00", "2026-06-11T01:00:00")],
      "2026-06-11",
    );
    expect(out[0].topPx).toBe(-60);
    expect(out[0].heightPx).toBe(120);
  });

  it("anchor 생략 시 가장 이른 블록 날짜가 anchor (기존 단일일 호출 하위호환)", () => {
    const out = computeLayout([make("a", "2026-05-28T09:00:00", "2026-05-28T10:00:00")]);
    expect(out[0].topPx).toBe(540);
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run src/lib/timelineLayout.test.ts` / Expected: 신규 케이스 FAIL
- [ ] **Step 3: 구현** — `timelineLayout.ts` 변경:

```ts
// 상단 import 추가
import { absMin, localDateOf } from "./timeAxis";

// 기존 toMin(iso) 함수 삭제하고, computeLayout 시그니처/내부를 다음으로 교체:

/**
 * @param anchorDate 절대 분 축의 0점(YYYY-MM-DD, 로드된 가장 이른 날). 생략 시 블록 중
 * 가장 이른 startISO의 날짜 — 단일일 호출 하위호환(기존 테스트/단일일 사용처).
 */
export function computeLayout(blocks: TimedBlock[], anchorDate?: string): LayoutBox[] {
  if (blocks.length === 0) return [];
  const anchor =
    anchorDate ??
    blocks.reduce(
      (min, b) => (localDateOf(b.startISO) < min ? localDateOf(b.startISO) : min),
      localDateOf(blocks[0].startISO),
    );
  const toMin = (iso: string) => absMin(iso, anchor);
  // …이하 기존 본문 그대로(정렬/클러스터링/그리디 컬럼/out push) — toMin이 클로저로 대체됨.
}
```

본문 알고리즘(정렬·클러스터·컬럼 할당·`topPx = startMin * (HOUR_PX / 60)`)은 무변경. 파일 헤더 주석의 "멀티데이 블록은 범위 밖(스펙)·0..1440" 문구를 "절대 분 축(앵커 기준, 자정 걸침 지원)"으로 갱신.

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run src/lib/timelineLayout.test.ts` / Expected: 전체 PASS (기존 케이스 포함)
- [ ] **Step 5: Commit** — `git commit -m "feat(today): computeLayout 절대 분 축 — 자정 걸침 블록 연속 렌더"`

---

### Task 3: `todayBlocks` — 루틴 id 날짜 포함 + 멀티데이 병합/dedup

**Files:**

- Modify: `src/lib/todayBlocks.ts`
- Modify: `src/lib/todayBlocks.test.ts`

- [ ] **Step 1: 실패하는 테스트 추가**

```ts
// src/lib/todayBlocks.test.ts에 추가 (기존 헬퍼/픽스처 재사용, 없는 것은 인라인 생성)
import { buildTimelineBlocks } from "./todayBlocks";

describe("buildTimelineBlocks (멀티데이 병합)", () => {
  const event = (id: string, start: string, end: string) => ({
    id,
    calendarId: "cal1",
    calendarSummary: "Cal 1",
    title: id,
    start,
    end,
    allDay: false,
    recurringEventId: null,
    projectColor: null,
  });

  it("자정 걸침 이벤트가 인접 두 날짜 버킷에 중복으로 와도 1개 블록", () => {
    const e = event("ev1", "2026-06-11T23:00:00+09:00", "2026-06-12T01:30:00+09:00");
    const out = buildTimelineBlocks({
      signals: [],
      eventsByDate: { "2026-06-11": [e], "2026-06-12": [e] },
      routinesByDate: {},
      dates: ["2026-06-11", "2026-06-12"],
    });
    expect(out.filter((b) => b.id === "event:cal1:ev1")).toHaveLength(1);
    expect(out[0].endISO).toBe("2026-06-12T01:30:00+09:00"); // full span 유지
  });

  it("같은 루틴의 가상 인스턴스는 날짜별로 별개 블록(id에 날짜 포함)", () => {
    const routine = {
      id: "r1",
      title: "운동",
      timeOfDay: "07:00",
      timeOverride: null,
      durationMin: null,
      done: false,
      kind: "personal",
      linkedCalendarId: null,
      linkedEventId: null,
      googleCalendarId: null,
      googleEventId: null,
    };
    const out = buildTimelineBlocks({
      signals: [],
      eventsByDate: {},
      routinesByDate: { "2026-06-11": [routine], "2026-06-12": [routine] },
      dates: ["2026-06-11", "2026-06-12"],
    });
    const ids = out.map((b) => b.id).sort();
    expect(ids).toEqual(["routine:r1:2026-06-11", "routine:r1:2026-06-12"]);
    expect(out.every((b) => b.routineId === "r1")).toBe(true);
  });

  it("signal은 자기 scheduledAt 날짜에만 1회 렌더", () => {
    const signal = {
      id: "s1",
      title: "작업",
      scheduledAt: "2026-06-12T02:00:00+09:00",
      scheduledDuration: 60,
      linkedCalendarId: null,
      linkedEventId: null,
      todayDoneAt: null,
    };
    const out = buildTimelineBlocks({
      signals: [signal],
      eventsByDate: {},
      routinesByDate: {},
      dates: ["2026-06-11", "2026-06-12"],
    });
    expect(out.filter((b) => b.id === "signal:s1")).toHaveLength(1);
    expect(out[0].startISO).toBe("2026-06-12T02:00:00+09:00");
  });
});
```

(픽스처 객체는 기존 테스트 파일의 타입 헬퍼가 있으면 그것을 사용 — 위는 형태 기준. `as` 캐스트로 bindings 타입 충족.)

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run src/lib/todayBlocks.test.ts` / Expected: FAIL
- [ ] **Step 3: 구현**

`buildTodayBlocks` 내 루틴 가상 인스턴스 push(파일 말미 `id: \`routine:${r.id}\``)를 날짜 포함으로 변경:

```ts
      id: `routine:${r.id}:${date}`,
```

파일 끝에 추가:

```ts
/**
 * 멀티데이 타임라인 블록 합성(연속 타임라인 스펙 §3).
 *
 * 날짜별로 buildTodayBlocks를 실행해 병합하고 블록 id로 dedup한다.
 * - 자정 걸침 Google 이벤트는 overlap 시맨틱상 인접 두 날짜 버킷에 모두 내려온다 →
 *   `event:${calendarId}:${id}` 복합키 dedup으로 full-span 1개만 남긴다.
 * - signal은 scheduledAt의 로컬 날짜에서만 생성되므로(buildTodayBlocks의 날짜 필터)
 *   병합 후에도 1회만 나타난다.
 * - 루틴 가상 인스턴스는 id에 날짜가 포함되어 날짜별 별개 블록.
 */
export function buildTimelineBlocks({
  signals,
  eventsByDate,
  routinesByDate,
  dates,
}: {
  signals: WorkSignal[];
  eventsByDate: Record<string, CalendarEvent[] | undefined>;
  routinesByDate: Record<string, RoutineToday[] | undefined>;
  dates: string[];
}): TimedBlock[] {
  const seen = new Set<string>();
  const out: TimedBlock[] = [];
  for (const date of dates) {
    const blocks = buildTodayBlocks({
      signals,
      events: eventsByDate[date] ?? [],
      routines: routinesByDate[date] ?? [],
      date,
    });
    for (const b of blocks) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
    }
  }
  return out;
}
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run src/lib/todayBlocks.test.ts` / Expected: PASS (기존 케이스 중 `routine:` id를 단언하는 곳이 있으면 `:${date}` 포함으로 갱신)
- [ ] **Step 5: Commit** — `git commit -m "feat(today): buildTimelineBlocks 멀티데이 병합/dedup + 루틴 블록 id 날짜 포함"`

---

### Task 4: `timelineCoords` — DnD 픽셀↔ISO 순수 변환 (날짜 인지)

**Files:**

- Create: `src/lib/timelineCoords.ts`
- Create: `src/lib/timelineCoords.test.ts`
- Modify: `src/components/today/useTimelineDnd.ts` (함수 이전·위임)

- [ ] **Step 1: 실패하는 테스트 작성**

```ts
// src/lib/timelineCoords.test.ts
import { describe, expect, it } from "vitest";

import { clampIsoToDate, pixelToLocalIso, resizeIsoByPx, shiftIsoByPx } from "./timelineCoords";
import { tzOffsetForDate } from "./timeAxis";

const off = (d: string) => tzOffsetForDate(d);

describe("timelineCoords (anchor=2026-06-11, days=3)", () => {
  const A = "2026-06-11";

  it("pixelToLocalIso: 둘째 날 영역 픽셀 → 다음 날짜 ISO", () => {
    // 1440px(=둘째 날 00:00) + 90px → 2026-06-12T01:30
    expect(pixelToLocalIso(A, 3, 1440 + 90)).toBe(`2026-06-12T01:30:00${off("2026-06-12")}`);
  });

  it("pixelToLocalIso: 음수/상한 클램프는 로드 범위 기준", () => {
    expect(pixelToLocalIso(A, 3, -10)).toBe(`2026-06-11T00:00:00${off(A)}`);
    expect(pixelToLocalIso(A, 3, 3 * 1440 + 999)).toBe(`2026-06-13T23:45:00${off("2026-06-13")}`);
  });

  it("shiftIsoByPx: 자정 넘는 드래그가 날짜를 증가시킨다", () => {
    // 23:00 시작 + 120px(2h) → 다음 날 01:00
    expect(shiftIsoByPx(A, 3, `2026-06-11T23:00:00${off(A)}`, 120)).toBe(
      `2026-06-12T01:00:00${off("2026-06-12")}`,
    );
  });

  it("shiftIsoByPx: 위로 드래그해 전날로 이동", () => {
    expect(shiftIsoByPx(A, 3, `2026-06-12T00:30:00${off("2026-06-12")}`, -60)).toBe(
      `2026-06-11T23:30:00${off(A)}`,
    );
  });

  it("resizeIsoByPx bottom: 자정 너머로 늘리기 — duration이 일 경계 클램프 없이 증가", () => {
    const r = resizeIsoByPx({
      anchorDate: A,
      days: 3,
      startISO: `2026-06-11T23:00:00${off(A)}`,
      durationMin: 60,
      edge: "bottom",
      deltaPx: 90,
    });
    expect(r.durationMin).toBe(150);
    expect(r.at).toBe(`2026-06-11T23:00:00${off(A)}`);
  });

  it("resizeIsoByPx top: 시작을 전날로 끌어올리기", () => {
    const r = resizeIsoByPx({
      anchorDate: A,
      days: 3,
      startISO: `2026-06-12T00:30:00${off("2026-06-12")}`,
      durationMin: 60,
      edge: "top",
      deltaPx: -60,
    });
    expect(r.at).toBe(`2026-06-11T23:30:00${off(A)}`);
    expect(r.durationMin).toBe(120);
  });

  it("clampIsoToDate: 다른 날짜로 흘러간 ISO를 해당 날짜 안으로 (루틴 occurrence 클램프)", () => {
    expect(clampIsoToDate(`2026-06-12T01:00:00${off("2026-06-12")}`, "2026-06-11")).toBe(
      `2026-06-11T23:45:00${off(A)}`,
    );
    expect(clampIsoToDate(`2026-06-10T23:00:00${off("2026-06-10")}`, "2026-06-11")).toBe(
      `2026-06-11T00:00:00${off(A)}`,
    );
    // 이미 그 날짜면 무변경(스냅만)
    expect(clampIsoToDate(`2026-06-11T10:15:00${off(A)}`, "2026-06-11")).toBe(
      `2026-06-11T10:15:00${off(A)}`,
    );
  });
});
```

- [ ] **Step 2: 실패 확인** — Run: `pnpm vitest run src/lib/timelineCoords.test.ts` / Expected: FAIL
- [ ] **Step 3: 구현**

```ts
// src/lib/timelineCoords.ts
/**
 * 타임라인 픽셀 ↔ 로컬 ISO 변환(연속 절대 분 축) — useTimelineDnd에서 추출한 순수 함수.
 * 60px/h, 15분 스냅. 클램프는 하루(0..1425)가 아니라 로드된 범위 [0, days*1440-15].
 * RFC3339 로컬 오프셋 필수(백엔드 parse_from_rfc3339) — 오프셋은 대상 "날짜"의 것.
 */
import { absMin, dayDiff, isoFromAbsMin } from "./timeAxis";

const HOUR_PX = 60;
const SNAP_MIN = 15;

function snap(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

function clampAbs(min: number, days: number): number {
  return Math.max(0, Math.min(days * 1440 - SNAP_MIN, min));
}

/** 그리드 픽셀(절대 Y) → 로컬 ISO. 날짜는 Y에서 유도(자정 넘는 배치 가능). */
export function pixelToLocalIso(anchorDate: string, days: number, gridY: number): string {
  const abs = clampAbs(snap((gridY / HOUR_PX) * 60), days);
  return isoFromAbsMin(anchorDate, abs);
}

/** 기존 ISO + delta px → 새 ISO. 절대 분 기준이라 자정 통과 자동. */
export function shiftIsoByPx(
  anchorDate: string,
  days: number,
  startISO: string,
  deltaPx: number,
): string {
  const abs = clampAbs(snap(absMin(startISO, anchorDate) + (deltaPx / HOUR_PX) * 60), days);
  return isoFromAbsMin(anchorDate, abs);
}

/** 리사이즈: top=시작 이동(끝 고정), bottom=duration 변경. 자정 경계 클램프 없음(로드 범위만). */
export function resizeIsoByPx({
  anchorDate,
  days,
  startISO,
  durationMin,
  edge,
  deltaPx,
}: {
  anchorDate: string;
  days: number;
  startISO: string;
  durationMin: number;
  edge: "top" | "bottom";
  deltaPx: number;
}): { at: string; durationMin: number } {
  const startAbs = absMin(startISO, anchorDate);
  const endAbs = startAbs + durationMin;
  const deltaMin = (deltaPx / HOUR_PX) * 60;
  if (edge === "top") {
    const nextStart = Math.max(0, Math.min(endAbs - SNAP_MIN, snap(startAbs + deltaMin)));
    return { at: isoFromAbsMin(anchorDate, nextStart), durationMin: endAbs - nextStart };
  }
  const maxDuration = days * 1440 - startAbs;
  return {
    at: startISO,
    durationMin: Math.max(SNAP_MIN, Math.min(maxDuration, snap(durationMin + deltaMin))),
  };
}

/**
 * ISO를 주어진 날짜 안으로 클램프(루틴 occurrence 클램프 — routine_checks는
 * date+HH:MM 구조라 다음 날 새벽 표현 불가, 스펙 §5).
 */
export function clampIsoToDate(iso: string, date: string): string {
  const within = Math.max(0, Math.min(1440 - SNAP_MIN, absMin(iso, date)));
  return isoFromAbsMin(date, within);
}
```

- [ ] **Step 4: 통과 확인** — Run: `pnpm vitest run src/lib/timelineCoords.test.ts` / Expected: PASS
- [ ] **Step 5: Commit** — `git commit -m "feat(today): timelineCoords — 날짜 인지 픽셀↔ISO 변환 (자정 통과 DnD 기반)"`

---

### Task 5: `useTimelineDnd` — 좌표 위임 + 루틴 클램프 + 캐시 패치 predicate

**Files:**

- Modify: `src/components/today/useTimelineDnd.ts`
- Modify: `src/components/today/TimelineBlock.tsx` (DragData에 `blockId`)
- Modify: `src/components/today/timelinePreview.ts` / `timelinePreview.test.ts`

- [ ] **Step 1: useTimelineDnd 변경**

1. 로컬 `pixelToLocalIso`/`shiftIsoByPx`/`resizeIsoByPx`/`plusMinutesLocal`/`tzOffset`/`snap` 정의 삭제. import로 대체:

```ts
import { clampIsoToDate, pixelToLocalIso, resizeIsoByPx, shiftIsoByPx } from "@/lib/timelineCoords";
import { localDateOf } from "@/lib/timeAxis";
```

`plusMinutesLocal`은 timelinePreview/patchEventCache가 쓰므로 `src/lib/timelineCoords.ts`로 이동(export, 코드 그대로). re-export 금지 — 사용처 import 경로 갱신.

2. `Opts`에 추가 + 구조분해:

```ts
type Opts = {
  date: string; // Today 레일 캐시 키용(["today", date]) — 기존 유지
  anchorDate: string; // 로드된 첫 날짜(절대 축 0점)
  days: number; // 로드된 일수
  // …기존 필드 그대로
};
```

3. 호출부 치환 (모든 인터랙션 분기):
   - `pixelToLocalIso(date, y)` → `pixelToLocalIso(anchorDate, days, y)`
   - `shiftIsoByPx(date, a.startISO, ev.delta.y)` → `shiftIsoByPx(anchorDate, days, a.startISO, ev.delta.y)`
   - `resizeIsoByPx({date, …})` → `resizeIsoByPx({anchorDate, days, …})`
   - `resolveCanvasGridY`의 클램프 `24 * HOUR_PX` → `days * 24 * HOUR_PX`

4. **루틴 occurrence 클램프 + 날짜 파라미터**: routine 분기(resize/reschedule)에서

```ts
const occDate = localDateOf(a.startISO);
const clampedAt = clampIsoToDate(at, occDate);
// patchRoutineCache/stage 호출의 at → clampedAt, date → occDate 로 교체
```

routineSchedule(routine row → canvas drop)은 드롭 위치가 곧 occurrence: `const dropDate = localDateOf(at);` → `stage({ kind: "routineSchedule", routineId, date: dropDate, … })`.

5. **캐시 패치 predicate화**: `patchEventCache`/`removeEventFromCache`(TodayView)/`patchRoutineCache`를 단일 date 키에서 전 버킷으로:

```ts
const patchEventCache = (calendarId: string, eventId: string, patch: {...}) => {
  qc.setQueriesData<CalendarEvent[]>({ queryKey: ["calendarEvents"] }, (old) => {
    if (!old) return old;
    return old.map((event) => { /* 기존 본문 그대로 */ });
  });
};
const invalidateEventCaches = () => {
  void qc.invalidateQueries({ queryKey: ["calendarEvents"] });
};
const patchRoutineCache = (routineId: string, patch: {...}) => {
  qc.setQueriesData<RoutineToday[]>({ queryKey: ["routines"] }, (old) =>
    old?.map((r) => (r.id === routineId ? { ...r, ...patch } : r)),
  );
};
```

(`["calendarEvents", "range", …]` 드로어 버킷도 같은 patch가 적용된다 — 동일 이벤트의 동일 필드 갱신이라 정합적.)

6. signal 캐시 패치 `["today", date]`는 기존 유지(레일은 date state 소유).

- [ ] **Step 2: TimelineBlock — DragData에 blockId**

`DragData`의 canvas/canvas-resize 5개 variant에 `blockId: string;` 필드 추가. `dragDataForBox`/`resizeDataForBox`에서 `blockId: block.id` 채움. (timelinePreview의 재구성식 id 매칭 제거가 목적 — 기존 event 변형은 `event:${eventId}`로 복합키 `event:${cal}:${id}`와 불일치해 드래그 중 재레이아웃이 동작하지 않던 버그도 함께 해소.)

- [ ] **Step 3: timelinePreview — blockId 매칭 + anchor**

```ts
function blockIdForDrag(data: DragData): string | null {
  if (data.from !== "canvas" && data.from !== "canvas-resize") return null;
  return data.blockId;
}
```

`previewTimelineBoxes`/`dragGuideFromLayout` 시그니처의 `date: string` → `anchorDate: string; days: number`로 교체, 내부 `shiftIsoByPx`/`resizeIsoByPx` 호출을 새 시그니처로. `computeLayout(blocks)` → `computeLayout(blocks, anchorDate)`. 가이드 y 클램프 `24*60` → `days*1440`.

- [ ] **Step 4: 테스트 갱신 + 신규** — `timelinePreview.test.ts`: 기존 케이스에 `blockId`/`anchorDate`/`days` 반영. 신규: "canvas 드래그 delta로 자정을 넘기면 preview 블록 startISO 날짜가 증가".
- [ ] **Step 5: 게이트** — Run: `pnpm typecheck && pnpm vitest run src/components/today src/lib` / Expected: PASS (이 시점에 TodayView/TimelineCanvas 컴파일 에러가 나면 임시가 아니라 Task 6·7을 같은 커밋 전에 진행 — 커밋은 typecheck green에서만)
- [ ] **Step 6: Commit** — Task 6·7과 함께 또는 단독 green이면 `git commit -m "feat(today): DnD 좌표 날짜 인지화 + 루틴 occurrence 클램프 + 캐시 패치 predicate"`

---

### Task 6: `TimelineCanvas` — 멀티데이 그리드

**Files:**

- Modify: `src/components/today/TimelineCanvas.tsx`
- Modify: `src/components/TodayView.css`

- [ ] **Step 1: Props/렌더 변경**

```ts
type Props = {
  dates: string[]; // 로드된 날짜(연속, 오름차순). anchor = dates[0]
  today: string;
  // date 제거, 나머지 기존 유지
};
```

핵심 변경:

```tsx
const anchorDate = dates[0];
const days = dates.length;
const totalPx = days * 24 * HOUR_PX;

function nowOffsetPx(anchorDate: string): number {
  const d = new Date();
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return (dayDiff(date, anchorDate) * 24 + d.getHours() + d.getMinutes() / 60) * HOUR_PX;
}
```

- 그리드 높이 `style={{ height: `${totalPx}px` }}`.
- 시간 라벨/룰: `dates.flatMap((date, di) => HOURS.map((h) => top = (di*24+h)*HOUR_PX))` — key는 `${date}:${h}`.
- 업무시간 음영: 날짜별 `<div className="today-canvas-workhours" style={{ top: `${di*1440 + 9*60}px`, height: `${9\*60}px` }} />` (기존 CSS의 고정 top/height 선언은 제거하고 인라인 좌표로).
- 날짜 separator: `di > 0`인 날짜마다

```tsx
<div className="today-canvas-day-sep" style={{ top: `${di * 1440}px` }}>
  <span className="today-canvas-day-sep-label">{fmtDayLabel(date)}</span>
</div>
```

`fmtDayLabel(date)` = `"6월 12일 (금)"` 형식 — `weekdayForDate` 재사용 또는 로컬 포맷터(정오 파싱).

- now 라인: `showNow` 조건을 `dates.includes(today)`로, interval은 항상 등록, `top: nowPx` (절대).
- pointer 클램프 `24 * HOUR_PX` → `totalPx` (onPointerMove).
- 드롭 가이드 라벨: `snapMin` 클램프 상한 `days*1440`, 라벨은 `snapMin % 1440`으로 hh:mm (+`snapMin >= 1440 || snapMin < 0`이어도 modulo 후 표시; 날짜는 separator가 컨텍스트 제공).
- `data-date={dates[0]}` → `data-dates={`${dates[0]}..${dates[days-1]}`}` (스모크/디버그용).

- [ ] **Step 2: CSS 추가** (TodayView.css)

```css
.today-canvas-day-sep {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 2px solid var(--color-border);
  z-index: 2;
  pointer-events: none;
}
.today-canvas-day-sep-label {
  position: sticky;
  display: inline-block;
  margin-left: 8px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-muted-foreground);
  background: var(--color-background);
  border: 1px solid var(--color-border);
  border-radius: 999px;
  transform: translateY(-50%);
}
```

(토큰명은 기존 TodayView.css 사용 토큰과 동일 계열로 — 구현 시 인접 선언에서 확인. `pnpm check:design-tokens` 게이트 통과 필수.)

기존 `.today-canvas-workhours`의 고정 `top/height` 선언 제거(인라인 스타일로 이동).

- [ ] **Step 3: 게이트** — `pnpm typecheck` (TodayView 갱신 전이면 Task 7과 묶어 진행)
- [ ] **Step 4: Commit** — `git commit -m "feat(today): TimelineCanvas 멀티데이 그리드 + 날짜 separator + 절대 now 라인"`

---

### Task 7: `TodayView` — visibleDates·useQueries 병합·스크롤 관리

**Files:**

- Modify: `src/components/TodayView.tsx`
- Modify: `src/lib/query/calendar.ts`, `src/lib/query/routines.ts`, `src/lib/query/timelineNotes.ts`

- [ ] **Step 1: 멀티데이 쿼리 훅 추가**

```ts
// calendar.ts — 기존 fetchCalendarEvents 재사용, 키는 단일일 훅과 동일(["calendarEvents", date])
export function useCalendarEventsForDates(dates: string[]) {
  return useQueries({
    queries: dates.map((date) => ({
      queryKey: ["calendarEvents", date] as const,
      queryFn: () => fetchCalendarEvents(null, date, false),
      staleTime: 60_000,
      retry: 1,
    })),
    combine: (results) => ({
      byDate: Object.fromEntries(dates.map((d, i) => [d, results[i].data ?? []])),
      isLoading: results.some((r) => r.isLoading),
    }),
  });
}
```

```ts
// routines.ts
export function useTodayRoutinesForDates(dates: string[]) {
  return useQueries({
    queries: dates.map((date) => ({
      queryKey: ["routines", date] as const,
      queryFn: () => unwrap(commands.listTodayRoutines(date, weekdayForDate(date))),
    })),
    combine: (results) => ({
      byDate: Object.fromEntries(dates.map((d, i) => [d, results[i].data ?? []])),
    }),
  });
}
```

(`weekdayForDate`는 `./client`에서 import.)

```ts
// timelineNotes.ts
export function useTimelineNotesForDates(dates: string[]) {
  return useQueries({
    queries: dates.map((date) => ({
      queryKey: ["timelineNotesForDate", date] as const,
      queryFn: () => unwrap(commands.listTimelineNotesForDate(date)),
    })),
    combine: (results) => ({ all: results.flatMap((r) => r.data ?? []) }),
  });
}
```

- [ ] **Step 2: TodayView 상태/데이터 배선**

```ts
const MAX_LOADED_DAYS = 21;
const DAY_PX = 24 * 60; // 1440

const today = localToday();
const [date, setDate] = useState<string>(today); // 레일/트레이/KPI 스코프(기존)
const [visibleDates, setVisibleDates] = useState<string[]>(() => [
  addDays(today, -1),
  today,
  addDays(today, 1),
]);
const anchorDate = visibleDates[0];

const eventsQ = useCalendarEventsForDates(visibleDates);
const routinesQ = useTodayRoutinesForDates(visibleDates);
const notesQ = useTimelineNotesForDates(visibleDates);
const todayRail = useToday(date); // 기존 유지

const blocks = buildTimelineBlocks({
  signals: rail,
  eventsByDate: eventsQ.byDate,
  routinesByDate: routinesQ.byDate,
  dates: visibleDates,
});
const boxes = computeLayout(blocks, anchorDate);
```

- 트레이용 단일일 데이터: `allDay = (eventsQ.byDate[date] ?? []).filter((e) => e.allDay)`, `routineList = routinesQ.byDate[date] ?? []` (기존 `useCalendarEvents(date)`/`useTodayRoutines(date, weekday)` 단독 호출 제거 — 키가 같아 캐시는 동일).
- 메모 맵: `notesQ.all` 순회(기존 byTarget 로직 그대로).
- `noCalendarsConfigured` 등 기존 로직 유지.

- [ ] **Step 3: per-block 날짜 정합(완료/삭제/popover)**

표시된 블록의 occurrence 날짜 기준으로:

```ts
const blockDate = (block: TimedBlock) => localDateOf(block.startISO);
```

- `handleBlockToggleDone`: `toggleDone.mutate({ id, date: blockDate(block), done })` / `toggleRoutine.mutate({ routineId, date: blockDate(block), done })`
- `handleDeleteSchedule` routine 분기: `unscheduleRoutineToday(routineId, blockDate(block))`, `stage({kind: "routineUnschedule", routineId, date: blockDate(block)})`, restore도 동일.
- `removeEventFromCache`: `qc.setQueriesData<CalendarEvent[]>({ queryKey: ["calendarEvents"] }, …)` (전 버킷).
- `EventPopover date` prop: `popover ? localDateOf(popover.box.block.startISO) : date`.
- `useTimelineDnd` opts: `{ date, anchorDate, days: visibleDates.length, … }`.
- `TimelineCanvas` props: `dates={visibleDates}`.

- [ ] **Step 4: 스크롤 관리(센터·lazy extend·prepend 보정·캡)**

```ts
const wrapRef = useRef<HTMLDivElement | null>(null); // .today-canvas-wrap
const prevAnchorRef = useRef(anchorDate);
const didInitialScrollRef = useRef(false);
const extendingRef = useRef(false);

// 초기: 현재시각 센터(today가 visibleDates에 있을 때 1회).
useLayoutEffect(() => {
  const el = wrapRef.current;
  if (!el || didInitialScrollRef.current) return;
  const idx = visibleDates.indexOf(today);
  if (idx < 0) return;
  const now = new Date();
  const nowPx = idx * DAY_PX + now.getHours() * 60 + now.getMinutes();
  el.scrollTop = Math.max(0, nowPx - el.clientHeight / 2);
  didInitialScrollRef.current = true;
}, [visibleDates, today]);

// prepend/top-drop 시 scrollTop 보정 — anchor 변화량만큼.
useLayoutEffect(() => {
  const el = wrapRef.current;
  const prev = prevAnchorRef.current;
  prevAnchorRef.current = anchorDate;
  if (!el || prev === anchorDate) return;
  el.scrollTop += dayDiff(prev, anchorDate) * DAY_PX;
  extendingRef.current = false;
}, [anchorDate]);

const handleCanvasScroll = () => {
  const el = wrapRef.current;
  if (!el || extendingRef.current) return;
  const nearTop = el.scrollTop < DAY_PX / 2;
  const nearBottom = el.scrollTop + el.clientHeight > el.scrollHeight - DAY_PX / 2;
  if (!nearTop && !nearBottom) return;
  extendingRef.current = true;
  setVisibleDates((prev) => {
    let next = nearTop
      ? [addDays(prev[0], -1), ...prev]
      : [...prev, addDays(prev[prev.length - 1], 1)];
    if (next.length > MAX_LOADED_DAYS) next = nearTop ? next.slice(0, -1) : next.slice(1);
    return next;
  });
};
```

- `.today-canvas-wrap` div에 `ref={wrapRef} onScroll={handleCanvasScroll}` 부착.
- append/bottom-drop은 anchor 무변화 → 보정 불필요(prepend 시 effect가 `extendingRef` 해제, append 경로는 `setVisibleDates` 후 microtask에서 해제하도록 effect deps에 `visibleDates` 포함한 별도 reset: `useEffect(() => { extendingRef.current = false; }, [visibleDates])`).
- 날짜 네비(TodayHeader `onDateChange`):

```ts
const handleDateChange = (d: string) => {
  setDate(d);
  setVisibleDates((prev) => {
    let next = prev;
    while (d < next[0]) next = [addDays(next[0], -1), ...next];
    while (d > next[next.length - 1]) next = [...next, addDays(next[next.length - 1], 1)];
    return next.length > MAX_LOADED_DAYS ? next : next; // 캡 초과 네비는 드물어 그대로 허용
  });
  requestAnimationFrame(() => {
    const el = wrapRef.current;
    if (!el) return;
    // 해당 날짜 08:00로 스크롤(앵커는 setVisibleDates 반영 후 DOM 기준).
    const dateAttr = el.querySelector<HTMLElement>(".today-canvas-grid");
    void dateAttr; // anchor 재계산: 아래 식은 최신 visibleDates 기준이라 effect로 처리해도 무방
    el.scrollTop = dayDiffFromDom(); // 구현 시 단순화: useEffect([date])에서 dayDiff(date, anchorDate)*DAY_PX + 8*60 로 설정
  });
};
```

구현 단순화: 스크롤은 `useEffect(() => { … }, [date])`에서 `dayDiff(date, anchorDate) * DAY_PX + 8 * 60`으로 설정(같은 렌더 사이클에 anchor가 이미 갱신됨). 초기 마운트엔 skip(`didInitialScrollRef` 패턴 재사용 또는 prev date ref 비교).

- [ ] **Step 5: 게이트** — Run: `pnpm typecheck && pnpm lint && pnpm vitest run` / Expected: 전부 PASS
- [ ] **Step 6: Commit** — `git commit -m "feat(today): 타임라인 연속 스크롤 — visibleDates lazy load + 현재시각 센터 + prepend 앵커링"`

---

### Task 8: 문서 + 검증 일괄

**Files:**

- Modify: `docs/decisions.md` (한 줄 breadcrumb)
- Modify: `docs/superpowers/specs/2026-06-11-continuous-timeline-design.md` (구현 중 결정 편차 반영: 윈도잉→캡, blockId 등)

- [ ] **Step 1: decisions.md append**

```
- 2026-06-11 Today 타임라인 연속화: 절대 분 축(timeAxis/timelineCoords) + per-day 버킷 유지·프런트 병합. DOM 윈도잉 대신 로드 21일 캡. 루틴 자정 걸침은 occurrence 클램프(스키마 확장 deferred). 자정 걸침 이벤트 20px 슬리버 버그 해결.
```

- [ ] **Step 2: 전체 게이트 실행**

```
pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build
export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test   # bindings drift 0 확인(Rust 무변경 증명)
git status --short  # bindings.ts 무변경 확인
```

Expected: 전부 green, `src/bindings.ts` diff 없음.

- [ ] **Step 3: 라이브 부팅 스모크** — `pnpm tauri dev` 부팅 확인(렌더러 콘솔 에러 0). GUI 클릭/드래그 스모크는 사용자 몫으로 명시.
- [ ] **Step 4: Commit** — `git commit -m "docs(today): 연속 타임라인 결정 기록 + 스펙 편차 반영"`

---

### Task 9: Critic 리뷰 (별도 패스 — self-approve 금지)

- [ ] **Step 1:** 별도 critic 에이전트(opus)에 전체 diff + 스펙/플랜 경로를 주고 INVARIANT 7개 + 회귀(7개 DnD 인터랙션, 캐시 키, Esc/popover) 관점 리뷰.
- [ ] **Step 2:** MAJOR/blocker 수정 후 재리뷰 → ACCEPT까지 반복.
- [ ] **Step 3:** ACCEPT 후 최종 상태 보고(푸시는 사용자 명시 요청 시에만).

---

## Self-Review 결과

- **스펙 커버리지**: §2→Task1·2, §3→Task3·7, §4→Task6, §5→Task4·5, §6→Task8(검증으로 증명), §7 영향표 전 파일이 Task에 매핑, §8 테스트 6종→Task1~5 케이스 + prepend 보정은 Task7(수동/스모크, 순수 로직은 useLayoutEffect라 단위테스트 부적합 — dayDiff 보정식 자체는 Task1 테스트로 커버). §9 deferred 유지.
- **편차(스펙 대비, 의도적)**: ① DOM ±1일 윈도잉 → 로드 21일 캡(단순·동일 목적) ② DragData `blockId` 추가(기존 event preview 매칭 버그 동반 수정) ③ 초기 로드 3일. Task 8에서 스펙에 반영.
- **타입 일관성**: `pixelToLocalIso(anchorDate, days, y)` 시그니처가 Task4 정의·Task5 사용 일치. `buildTimelineBlocks` 입력 키(eventsByDate/routinesByDate/dates) Task3 정의·Task7 사용 일치.
