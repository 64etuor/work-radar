# Weekly Review 재설계 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Weekly Review를 Life Wheel Radar + 통합 대시보드로 재구성하고, 회고/보관함을 한 페이지에 병합하며, 주차 네비게이터(페이저+스크러바)로 과거 주를 넘겨본다.

**Architecture:** 단일 내러티브 페이지(`WeeklyView.tsx`)가 `useWeekNav`(선택 주 상태) + 순수 헬퍼(`weekRange.ts`, `lifeWheelRadar.ts`)를 소비. 데이터는 기존 IPC만 재사용 — `weeklyReview(weekEnd)`(선택 주 KPI/PR/루틴/부채) + 12주치 `listCompleted` 1회(스크러바·레이더·회고 공용) + `listArchivedSnoozed`(보관함). 신규 백엔드 0개 → `bindings.ts` drift 0. `RetroView`/`retro` 라우트는 삭제(파괴적 통합).

**Tech Stack:** React + TypeScript, recharts 2.15.4(`RadarChart`), @tanstack/react-query, zustand, Tailwind v4 + 디자인 토큰, vitest.

---

## 배경 사실 (코드 검증 완료)

- `weeklyReview(endDate)` → `[endDate-6, endDate]` 7일 윈도우 반환. **주차 = 그 주 일요일을 endDate로** 넘기면 [월,일] 정렬됨.
- `listCompleted(start,end)` → `WorkSignal[]`, `todayDoneAt` DESC 정렬. `todayDoneAt`=완료일(YYYY-MM-DD).
- `WorkSignal`: `area: AreaTag|null`, `areaTags: string|null`(JSON 배열), `impactHigh/regret: boolean|null`, `status`, `snoozeUntil`, `todayDoneAt`.
- `LifeWheelTagConfig`: `{ id, label, color, builtIn, enabled }`. **enabled 태그가 가변** → 레이더 축 런타임 계산.
- 신호→태그 키 해석: `parseAreaTagKeys(areaTags, area)` (현재 `LifeWheelPalette.tsx` 비공개 — export 필요).
- `view`는 localStorage 영속 **아님**(기본 `"board"`). `"retro"` 제거 시 마이그레이션 가드 불필요 — tsc가 잔여 참조 표면.
- recharts 2.15.4가 `RadarChart`/`Radar`/`PolarGrid`/`PolarAngleAxis`/`PolarRadiusAxis` export 확인.
- worktree에 `node_modules` 없음 → Task 0에서 `pnpm install`.

## File Structure

- Create `src/lib/weekRange.ts` — 순수 주차 날짜 수학(월요일 기준, 미래 차단, ISO 주번호).
- Create `src/lib/weekRange.test.ts`
- Create `src/lib/lifeWheelRadar.ts` — 순수 레이더 집계(신호[]+태그[] → 축별 count, 모드 분기).
- Create `src/lib/lifeWheelRadar.test.ts`
- Create `src/lib/useWeekNav.ts` — 선택 주 상태 훅(offset, prev/next/goto/reset, start/end 파생).
- Create `src/components/weekly/LifeWheelRadar.tsx` — 레이더/바 폴백/빈 상태.
- Create `src/components/weekly/WeekNavigator.tsx` — 페이저 ‹ › + 이번 주로.
- Create `src/components/weekly/WeekScrubber.tsx` — 가로 주 타임라인.
- Create `src/components/weekly/ReflectionSection.tsx` — 회고 랭킹 + 타임라인(RetroTab 이전).
- Create `src/components/weekly/ArchiveAccordion.tsx` — 보관함(ArchiveTab 이전).
- Modify `src/components/WeeklyView.tsx` — 오케스트레이션.
- Modify `src/components/WeeklyView.css` — 신규 스타일(`.wk-*`).
- Modify `src/components/board/LifeWheelPalette.tsx` — `parseAreaTagKeys` export.
- Modify `src/lib/nav.ts` — `retro` NAV_ITEM 제거.
- Modify `src/store.ts` — `View`에서 `"retro"` 제거.
- Modify `src/App.tsx` — `RetroView` import + `retro` 분기 제거.
- Delete `src/components/RetroView.tsx`, `src/components/RetroView.css`.

---

### Task 0: 의존성 설치 + 베이스라인 그린

**Files:** (없음 — 환경)

- [ ] **Step 1: 의존성 설치**

Run: `cd /Users/davidpark/private_project/work-radar-wt/weekly-redesign && pnpm install`
Expected: lockfile 기준 설치 완료, recharts 포함.

- [ ] **Step 2: 베이스라인 게이트 확인**

Run: `pnpm typecheck && pnpm vitest run 2>&1 | tail -5`
Expected: typecheck 0 error, 기존 vitest 전부 PASS(베이스라인 숫자 기록).

---

### Task 1: 주차 날짜 수학 (`weekRange.ts`)

**Files:**

- Create: `src/lib/weekRange.ts`
- Test: `src/lib/weekRange.test.ts`

월요일 시작 주. `weekEnd`(일요일)를 `weeklyReview`에 넘긴다. 현재 주(offset 0)는 미래 일요일까지 포함해도 완료/캡처가 없어 0으로 집계되므로 안전. 미래 주(offset>0) 차단.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// src/lib/weekRange.test.ts
import { describe, expect, it } from "vitest";
import { mondayOf, weekRangeForOffset, isoWeekNumber, WEEKS_WINDOW } from "./weekRange";

describe("mondayOf", () => {
  it("returns Monday for a mid-week date", () => {
    expect(mondayOf("2026-06-10")).toBe("2026-06-08"); // Wed → Mon
  });
  it("returns same date when already Monday", () => {
    expect(mondayOf("2026-06-08")).toBe("2026-06-08");
  });
  it("handles Sunday (week's last day)", () => {
    expect(mondayOf("2026-06-14")).toBe("2026-06-08"); // Sun → that week's Mon
  });
});

describe("weekRangeForOffset", () => {
  const today = "2026-06-10"; // Wed, week Mon 6/8 – Sun 6/14
  it("offset 0 = current week Mon..Sun", () => {
    expect(weekRangeForOffset(today, 0)).toEqual({ start: "2026-06-08", end: "2026-06-14" });
  });
  it("offset -1 = previous week", () => {
    expect(weekRangeForOffset(today, -1)).toEqual({ start: "2026-06-01", end: "2026-06-07" });
  });
  it("offset -2 = two weeks back", () => {
    expect(weekRangeForOffset(today, -2)).toEqual({ start: "2026-05-25", end: "2026-05-31" });
  });
});

describe("isoWeekNumber", () => {
  it("computes ISO week of year", () => {
    expect(isoWeekNumber("2026-06-10")).toBe(24);
  });
});

describe("WEEKS_WINDOW", () => {
  it("is 12", () => {
    expect(WEEKS_WINDOW).toBe(12);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/lib/weekRange.test.ts`
Expected: FAIL — `weekRange` 모듈/함수 없음.

- [ ] **Step 3: 최소 구현**

```ts
// src/lib/weekRange.ts
/** 주차 네비게이션 날짜 수학(순수). 월요일 시작 주, 일요일이 주의 끝(weeklyReview endDate). */

/** 스크러바/페이저가 다루는 과거 주 윈도우 길이(주). 가장 오래된 주 = offset -(WEEKS_WINDOW-1). */
export const WEEKS_WINDOW = 12;

function toDate(yyyymmdd: string): Date {
  const [y, m, d] = yyyymmdd.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function fmt(dt: Date): string {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function addDays(yyyymmdd: string, days: number): string {
  const dt = toDate(yyyymmdd);
  dt.setDate(dt.getDate() + days);
  return fmt(dt);
}

/** 그 날짜가 속한 주의 월요일(YYYY-MM-DD). JS getDay(): 0=일..6=토. */
export function mondayOf(yyyymmdd: string): string {
  const dt = toDate(yyyymmdd);
  const dow = dt.getDay(); // 0=Sun
  const deltaToMonday = dow === 0 ? -6 : 1 - dow; // Sun→-6, Mon→0, Tue→-1 ...
  return addDays(yyyymmdd, deltaToMonday);
}

export interface WeekRange {
  start: string; // 월요일
  end: string; // 일요일 (weeklyReview endDate)
}

/** today 기준 offset주(0=이번 주, 음수=과거)의 [월,일] 범위. */
export function weekRangeForOffset(today: string, offset: number): WeekRange {
  const thisMonday = mondayOf(today);
  const start = addDays(thisMonday, offset * 7);
  const end = addDays(start, 6);
  return { start, end };
}

/** ISO-8601 주 번호(목요일 기준). */
export function isoWeekNumber(yyyymmdd: string): number {
  const dt = toDate(yyyymmdd);
  const target = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const dayNr = (target.getDay() + 6) % 7; // Mon=0..Sun=6
  target.setDate(target.getDate() - dayNr + 3); // 그 주의 목요일
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNr = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
  const diff = target.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run src/lib/weekRange.test.ts`
Expected: PASS (전 케이스).

- [ ] **Step 5: 커밋**

```bash
git add src/lib/weekRange.ts src/lib/weekRange.test.ts
git commit -m "feat(weekly): 주차 날짜 수학 헬퍼(월요일 기준, ISO 주번호, 12주 윈도우)"
```

---

### Task 2: `parseAreaTagKeys` export

**Files:**

- Modify: `src/components/board/LifeWheelPalette.tsx:308` (함수 선언에 `export` 추가)

레이더 집계가 신호→태그키 해석을 재사용. 동작 변경 없음(가시성만).

- [ ] **Step 1: export 추가**

`src/components/board/LifeWheelPalette.tsx` 의 `function parseAreaTagKeys(` 를 다음으로 변경:

```ts
/** 신호의 area 태그 키 배열 해석. areaTags(JSON 배열) 우선, 없으면 primary area 단일. 공용. */
export function parseAreaTagKeys(raw: string | null, primary: string | null): string[] {
```

(본문은 그대로 유지.)

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 error.

- [ ] **Step 3: 커밋**

```bash
git add src/components/board/LifeWheelPalette.tsx
git commit -m "refactor(board): parseAreaTagKeys export — 레이더 집계 재사용"
```

---

### Task 3: 레이더 집계 (`lifeWheelRadar.ts`)

**Files:**

- Create: `src/lib/lifeWheelRadar.ts`
- Test: `src/lib/lifeWheelRadar.test.ts`

신호[]를 enabled 태그 축별 count로 집계. 신호가 여러 area 태그를 가지면 각 축에 1씩(다중 노력 반영). 미설정/비활성 태그 제외. 렌더 모드(N개수)도 함께 결정.

- [ ] **Step 1: 실패 테스트 작성**

```ts
// src/lib/lifeWheelRadar.test.ts
import { describe, expect, it } from "vitest";
import type { LifeWheelTagConfig, WorkSignal } from "@/bindings";
import { computeRadarAxes, radarRenderMode, type RadarAxis } from "./lifeWheelRadar";

function tag(id: string, enabled = true): LifeWheelTagConfig {
  return { id, label: id.toUpperCase(), color: "#3f7d5e", builtIn: true, enabled };
}
function sig(id: string, area: string | null, areaTags?: string[]): WorkSignal {
  return {
    id,
    projectId: null,
    title: id,
    body: null,
    source: "manual" as never,
    type: "task" as never,
    quadrant: "q2" as never,
    suggestedQuadrant: null,
    kind: "work" as never,
    area: area as never,
    areaTags: areaTags ? JSON.stringify(areaTags) : null,
    suggestedArea: null,
    status: "active" as never,
    snoozeUntil: null,
    todayForDate: null,
    todayDoneAt: "2026-06-10",
    todayRank: null,
    impactHigh: null,
    regret: null,
    scheduledAt: null,
    scheduledDuration: null,
    linkedEventId: null,
    linkedCalendarId: null,
    createdAt: "2026-06-10T00:00:00Z",
    updatedAt: "2026-06-10T00:00:00Z",
  };
}

describe("computeRadarAxes", () => {
  const tags = [tag("health"), tag("family"), tag("career"), tag("hobby", false)];

  it("counts signals per enabled tag, stable-sorted by id", () => {
    const axes = computeRadarAxes(
      [sig("a", "health"), sig("b", "career"), sig("c", "health")],
      tags,
    );
    const byKey = Object.fromEntries(axes.map((x: RadarAxis) => [x.key, x.count]));
    expect(byKey).toEqual({ career: 1, family: 0, health: 2 });
    expect(axes.map((x) => x.key)).toEqual(["career", "family", "health"]); // id asc
  });

  it("counts a multi-tagged signal in each of its tags", () => {
    const axes = computeRadarAxes([sig("a", "health", ["health", "family"])], tags);
    const byKey = Object.fromEntries(axes.map((x) => [x.key, x.count]));
    expect(byKey).toEqual({ career: 0, family: 1, health: 1 });
  });

  it("excludes untagged signals and disabled tags", () => {
    const axes = computeRadarAxes([sig("a", null), sig("b", "hobby")], tags);
    expect(axes.find((x) => x.key === "hobby")).toBeUndefined(); // disabled
    expect(axes.every((x) => x.count === 0)).toBe(true); // null + only-disabled-tag → no counts
  });

  it("carries label and color from the tag config", () => {
    const axes = computeRadarAxes([], [tag("health")]);
    expect(axes[0]).toMatchObject({ key: "health", label: "HEALTH", color: "#3f7d5e" });
  });
});

describe("radarRenderMode", () => {
  it("empty when 0 enabled tags", () => {
    expect(radarRenderMode([])).toBe("empty");
  });
  it("bars when 1 or 2 axes", () => {
    expect(radarRenderMode([tag("a")])).toBe("bars");
    expect(radarRenderMode([tag("a"), tag("b")])).toBe("bars");
  });
  it("radar when 3+ axes", () => {
    expect(radarRenderMode([tag("a"), tag("b"), tag("c")])).toBe("radar");
  });
  it("ignores disabled tags in mode decision", () => {
    expect(radarRenderMode([tag("a"), tag("b"), tag("c", false)])).toBe("bars");
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/lib/lifeWheelRadar.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 최소 구현**

```ts
// src/lib/lifeWheelRadar.ts
import type { LifeWheelTagConfig, WorkSignal } from "@/bindings";
import { parseAreaTagKeys } from "@/components/board/LifeWheelPalette";

export interface RadarAxis {
  key: string;
  label: string;
  color: string;
  count: number;
}

/** enabled 태그만, id 오름차순. */
function enabledSorted(tags: LifeWheelTagConfig[]): LifeWheelTagConfig[] {
  return tags
    .filter((t) => t.enabled)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 신호[]를 enabled 태그 축별 완료 count로 집계(순수).
 * 신호가 여러 area 태그를 가지면 각 축에 1씩. 미설정 신호·비활성 태그는 제외.
 */
export function computeRadarAxes(signals: WorkSignal[], tags: LifeWheelTagConfig[]): RadarAxis[] {
  const axisTags = enabledSorted(tags);
  const enabledKeys = new Set(axisTags.map((t) => t.id));
  const counts = new Map<string, number>();
  for (const s of signals) {
    const keys = parseAreaTagKeys(s.areaTags, s.area);
    for (const k of keys) {
      if (enabledKeys.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return axisTags.map((t) => ({
    key: t.id,
    label: t.label,
    color: t.color,
    count: counts.get(t.id) ?? 0,
  }));
}

export type RadarMode = "empty" | "bars" | "radar";

/** enabled 태그 개수 → 렌더 모드. 0=안내, 1~2=수평 바, 3+=레이더. */
export function radarRenderMode(tags: LifeWheelTagConfig[]): RadarMode {
  const n = tags.filter((t) => t.enabled).length;
  if (n === 0) return "empty";
  if (n <= 2) return "bars";
  return "radar";
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run src/lib/lifeWheelRadar.test.ts`
Expected: PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/lifeWheelRadar.ts src/lib/lifeWheelRadar.test.ts
git commit -m "feat(weekly): Life Wheel 레이더 집계 헬퍼(가변 축·다중 태그·모드 분기)"
```

---

### Task 4: `useWeekNav` 상태 훅

**Files:**

- Create: `src/lib/useWeekNav.ts`
- Test: `src/lib/useWeekNav.test.ts`

선택 주 offset 상태 + 경계(미래 차단 offset≤0, 과거 하한 -(WEEKS_WINDOW-1)). 파생 `range`. `@testing-library/react` `renderHook` 사용(기존 테스트 셋업에 존재 가정 — 없으면 순수 reducer로 대체).

- [ ] **Step 1: 실패 테스트 작성**

```ts
// src/lib/useWeekNav.test.ts
import { describe, expect, it } from "vitest";
import { clampOffset } from "./useWeekNav";
import { WEEKS_WINDOW } from "./weekRange";

describe("clampOffset", () => {
  it("blocks the future (max 0)", () => {
    expect(clampOffset(3)).toBe(0);
  });
  it("clamps to oldest window week", () => {
    expect(clampOffset(-999)).toBe(-(WEEKS_WINDOW - 1));
  });
  it("passes valid past offsets", () => {
    expect(clampOffset(-4)).toBe(-4);
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm vitest run src/lib/useWeekNav.test.ts`
Expected: FAIL — 모듈 없음.

- [ ] **Step 3: 최소 구현**

```ts
// src/lib/useWeekNav.ts
import { useCallback, useState } from "react";
import { localToday } from "@/lib/query";
import { WEEKS_WINDOW, weekRangeForOffset, type WeekRange } from "./weekRange";

/** offset를 [-(WEEKS_WINDOW-1), 0] 범위로 clamp. 0=이번 주(미래 차단), 음수=과거. */
export function clampOffset(offset: number): number {
  if (offset > 0) return 0;
  const oldest = -(WEEKS_WINDOW - 1);
  return offset < oldest ? oldest : offset;
}

export interface WeekNav {
  offset: number; // 0=이번 주
  range: WeekRange; // {start 월, end 일}
  today: string;
  isCurrent: boolean; // offset === 0
  isOldest: boolean;
  prev: () => void;
  next: () => void;
  goto: (offset: number) => void;
  reset: () => void;
}

export function useWeekNav(): WeekNav {
  const today = localToday();
  const [offset, setOffset] = useState(0);
  const goto = useCallback((o: number) => setOffset(clampOffset(o)), []);
  const prev = useCallback(() => setOffset((o) => clampOffset(o - 1)), []);
  const next = useCallback(() => setOffset((o) => clampOffset(o + 1)), []);
  const reset = useCallback(() => setOffset(0), []);
  return {
    offset,
    range: weekRangeForOffset(today, offset),
    today,
    isCurrent: offset === 0,
    isOldest: offset === -(WEEKS_WINDOW - 1),
    prev,
    next,
    goto,
    reset,
  };
}
```

- [ ] **Step 4: 통과 확인**

Run: `pnpm vitest run src/lib/useWeekNav.test.ts && pnpm typecheck`
Expected: PASS + 0 error.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/useWeekNav.ts src/lib/useWeekNav.test.ts
git commit -m "feat(weekly): useWeekNav 선택 주 상태 훅(offset clamp·미래 차단)"
```

---

### Task 5: `LifeWheelRadar` 컴포넌트

**Files:**

- Create: `src/components/weekly/LifeWheelRadar.tsx`

선택 주 vs 직전 4주 평균. 모드별 렌더: radar(3+), bars(1~2), empty(0). 공통 max 스케일. 토큰 색.

- [ ] **Step 1: 컴포넌트 작성**

```tsx
// src/components/weekly/LifeWheelRadar.tsx
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
} from "recharts";

import type { LifeWheelTagConfig, WorkSignal } from "@/bindings";
import { computeRadarAxes, radarRenderMode } from "@/lib/lifeWheelRadar";

const SERIES_CURRENT = "var(--color-wr-green, #3f7d5e)";
const SERIES_AVG = "var(--color-wr-subtle, #c9c9c4)";

interface Props {
  weekSignals: WorkSignal[]; // 선택 주 완료 신호
  trailingWeeks: WorkSignal[][]; // 직전 4주(각 주 신호 배열)
  tags: LifeWheelTagConfig[];
  onOpenSettings: () => void; // N=0 딥링크
}

export function LifeWheelRadar({ weekSignals, trailingWeeks, tags, onOpenSettings }: Props) {
  const mode = radarRenderMode(tags);

  if (mode === "empty") {
    return (
      <div className="wk-radar-empty">
        Life Wheel 태그가 없습니다.{" "}
        <button type="button" className="wk-link" onClick={onOpenSettings}>
          설정에서 추가
        </button>
      </div>
    );
  }

  const cur = computeRadarAxes(weekSignals, tags);
  const avgRaw = trailingWeeks.map((wk) => computeRadarAxes(wk, tags));
  // 축 key 정렬은 computeRadarAxes가 동일 → index 정렬 일치
  const data = cur.map((axis, i) => {
    const avg =
      avgRaw.length === 0
        ? 0
        : avgRaw.reduce((sum, wk) => sum + (wk[i]?.count ?? 0), 0) / avgRaw.length;
    return { axis: axis.label, current: axis.count, average: Number(avg.toFixed(2)) };
  });
  const max = Math.max(1, ...data.map((d) => Math.max(d.current, d.average)));

  if (mode === "bars") {
    // N=1~2: 레이더 폴리곤 불가 → 수평 바
    return (
      <div className="wk-radar-bars">
        {data.map((d) => (
          <div key={d.axis} className="wk-bar-row">
            <span className="wk-bar-axis">{d.axis}</span>
            <div className="wk-bar-track">
              <i className="wk-bar-cur" style={{ width: `${(d.current / max) * 100}%` }} />
            </div>
            <span className="wk-bar-num">{d.current}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="wk-radar">
      <ResponsiveContainer width="100%" height={280}>
        <RadarChart data={data} outerRadius="72%">
          <PolarGrid stroke="var(--color-wr-border-light, #ececea)" />
          <PolarAngleAxis
            dataKey="axis"
            tick={{ fill: "var(--color-wr-subtle, #6b6b6b)", fontSize: 11 }}
          />
          <PolarRadiusAxis domain={[0, max]} tick={false} axisLine={false} />
          <Radar
            name="4주 평균"
            dataKey="average"
            stroke={SERIES_AVG}
            fill={SERIES_AVG}
            fillOpacity={0.12}
          />
          <Radar
            name="이번 주"
            dataKey="current"
            stroke={SERIES_CURRENT}
            fill={SERIES_CURRENT}
            fillOpacity={0.18}
          />
        </RadarChart>
      </ResponsiveContainer>
      <div className="wk-radar-legend">
        <span>
          <i className="wk-dot" style={{ background: SERIES_CURRENT }} />
          이번 주
        </span>
        <span>
          <i className="wk-dot" style={{ background: SERIES_AVG }} />
          4주 평균
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 error.

- [ ] **Step 3: 커밋**

```bash
git add src/components/weekly/LifeWheelRadar.tsx
git commit -m "feat(weekly): LifeWheelRadar 컴포넌트(레이더/바 폴백/빈 상태·선택주 vs 4주평균)"
```

---

### Task 6: `WeekNavigator` + `WeekScrubber`

**Files:**

- Create: `src/components/weekly/WeekNavigator.tsx`
- Create: `src/components/weekly/WeekScrubber.tsx`

- [ ] **Step 1: WeekNavigator 작성**

```tsx
// src/components/weekly/WeekNavigator.tsx
import { ChevronLeft, ChevronRight } from "lucide-react";

import { isoWeekNumber, type WeekRange } from "@/lib/weekRange";

function md(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

interface Props {
  range: WeekRange;
  isCurrent: boolean;
  isOldest: boolean;
  onPrev: () => void;
  onNext: () => void;
  onReset: () => void;
}

export function WeekNavigator({ range, isCurrent, isOldest, onPrev, onNext, onReset }: Props) {
  return (
    <div className="wk-nav">
      <div className="wk-pager">
        <button type="button" onClick={onPrev} disabled={isOldest} aria-label="이전 주">
          <ChevronLeft className="size-4" />
        </button>
        <span className="wk-cur">
          {isoWeekNumber(range.end)}주차
          <small>
            {md(range.start)} – {md(range.end)}
          </small>
        </span>
        <button type="button" onClick={onNext} disabled={isCurrent} aria-label="다음 주">
          <ChevronRight className="size-4" />
        </button>
      </div>
      {!isCurrent && (
        <button type="button" className="wk-today-btn" onClick={onReset}>
          이번 주로
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: WeekScrubber 작성**

```tsx
// src/components/weekly/WeekScrubber.tsx
import { useEffect, useRef } from "react";

import { cn } from "@/components/ui/cn";
import { isoWeekNumber, weekRangeForOffset, WEEKS_WINDOW } from "@/lib/weekRange";

interface Props {
  today: string;
  selectedOffset: number; // 0..-(WEEKS_WINDOW-1)
  countByOffset: Record<number, number>; // 주별 완료 수(스파크 높이)
  onSelect: (offset: number) => void;
}

export function WeekScrubber({ today, selectedOffset, countByOffset, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const offsets: number[] = [];
  for (let o = -(WEEKS_WINDOW - 1); o <= 0; o++) offsets.push(o);
  const max = Math.max(1, ...Object.values(countByOffset));

  // 최신(우측)으로 스크롤
  useEffect(() => {
    if (ref.current) ref.current.scrollLeft = ref.current.scrollWidth;
  }, []);

  return (
    <div className="wk-scrub" ref={ref}>
      {offsets.map((o) => {
        const r = weekRangeForOffset(today, o);
        const count = countByOffset[o] ?? 0;
        const h = 8 + Math.round((count / max) * 30);
        return (
          <button
            key={o}
            type="button"
            className={cn("wk-week", o === selectedOffset && "on")}
            onClick={() => onSelect(o)}
            title={`${isoWeekNumber(r.end)}주차 · 완료 ${count}`}
          >
            <span className="wk-spark">
              <i style={{ height: `${h}px` }} />
            </span>
            <span className="wk-week-lab">{isoWeekNumber(r.end)}</span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 0 error.

- [ ] **Step 4: 커밋**

```bash
git add src/components/weekly/WeekNavigator.tsx src/components/weekly/WeekScrubber.tsx
git commit -m "feat(weekly): WeekNavigator(페이저) + WeekScrubber(가로 주 타임라인)"
```

---

### Task 7: `ReflectionSection` (회고 이전)

**Files:**

- Create: `src/components/weekly/ReflectionSection.tsx`

`RetroView.tsx`의 `RetroTab` 본문 로직(랭킹·완료일 그룹·impact/regret 토글)을 선택 주 신호 props 기반으로 이전. 기간 피커 제거(상단 네비게이터가 대체).

- [ ] **Step 1: 컴포넌트 작성**

```tsx
// src/components/weekly/ReflectionSection.tsx
import { CheckCircle2, Sparkles, ThumbsDown } from "lucide-react";
import { useMemo } from "react";

import type { LifeWheelTagConfig, WorkSignal } from "@/bindings";
import { KindAreaChips } from "@/components/board/LifeWheelPalette";
import { cn } from "@/components/ui/cn";
import { useSetSignalImpact, useSetSignalRegret } from "@/lib/query";

function md(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

interface Props {
  items: WorkSignal[]; // 선택 주 완료 신호(todayDoneAt DESC)
  tags: LifeWheelTagConfig[];
}

export function ReflectionSection({ items, tags }: Props) {
  const setImpact = useSetSignalImpact();
  const setRegret = useSetSignalRegret();

  const impactful = useMemo(() => items.filter((s) => s.impactHigh), [items]);
  const wasteful = useMemo(() => items.filter((s) => s.regret), [items]);
  const groups = useMemo(() => {
    const map = new Map<string, WorkSignal[]>();
    for (const s of items) {
      const key = s.todayDoneAt ?? "—";
      const arr = map.get(key) ?? [];
      arr.push(s);
      map.set(key, arr);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <div className="wk-reflect">
      <div className="wk-rank">
        <RankCard
          icon={<Sparkles className="size-4" />}
          title="고임팩트"
          tone="impact"
          items={impactful}
        />
        <RankCard
          icon={<ThumbsDown className="size-4" />}
          title="하지말걸"
          tone="regret"
          items={wasteful}
        />
      </div>

      <section className="wk-sec">
        <div className="wk-sec-head">
          <CheckCircle2 className="text-wr-subtle size-4" />
          <span className="wk-sec-name">완료한 일</span>
          <span className="wk-sec-count">{items.length}</span>
        </div>
        {items.length === 0 ? (
          <div className="wk-hint">이 주에 완료한 항목이 없습니다.</div>
        ) : (
          groups.map(([date, rows]) => (
            <div key={date} className="wk-group">
              <div className="wk-group-date">{md(date)}</div>
              <div className="wk-group-items">
                {rows.map((s) => (
                  <div key={s.id} className="wk-item">
                    <div className="wk-item-body">
                      <div className="wk-item-ttl">{s.title}</div>
                      <KindAreaChips target={s} tags={tags} />
                    </div>
                    <div className="wk-item-tags">
                      <button
                        type="button"
                        className={cn("wk-tag-btn impact", s.impactHigh && "on")}
                        title="고임팩트 ⭐"
                        disabled={setImpact.isPending}
                        onClick={() => setImpact.mutate({ id: s.id, value: !s.impactHigh })}
                      >
                        <Sparkles className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className={cn("wk-tag-btn regret", s.regret && "on")}
                        title="하지말걸"
                        disabled={setRegret.isPending}
                        onClick={() => setRegret.mutate({ id: s.id, value: !s.regret })}
                      >
                        <ThumbsDown className="size-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function RankCard({
  icon,
  title,
  tone,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  tone: "impact" | "regret";
  items: WorkSignal[];
}) {
  return (
    <div className={`wk-rank-card ${tone}`}>
      <div className="wk-rank-head">
        {icon}
        <span className="wk-rank-title">{title}</span>
        <span className="wk-rank-count">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <div className="wk-rank-empty">아직 없음. 아래 목록에서 태깅하세요.</div>
      ) : (
        <ol className="wk-rank-list">
          {items.map((s) => (
            <li key={s.id} className="wk-rank-item">
              {s.title}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 error.

- [ ] **Step 3: 커밋**

```bash
git add src/components/weekly/ReflectionSection.tsx
git commit -m "feat(weekly): ReflectionSection — 회고 랭킹+타임라인(선택 주 연동, 기간피커 제거)"
```

---

### Task 8: `ArchiveAccordion` (보관함 이전)

**Files:**

- Create: `src/components/weekly/ArchiveAccordion.tsx`

`RetroView.tsx`의 `ArchiveTab`을 `<details>` 아코디언으로 이전. 데이터는 자체 훅(`useArchivedSnoozed`).

- [ ] **Step 1: 컴포넌트 작성**

```tsx
// src/components/weekly/ArchiveAccordion.tsx
import { Archive, RotateCcw } from "lucide-react";

import type { LifeWheelTagConfig } from "@/bindings";
import { KindAreaChips } from "@/components/board/LifeWheelPalette";
import { Button } from "@/components/ui/button";
import { useArchivedSnoozed, useRestoreSignal } from "@/lib/query";

function md(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

export function ArchiveAccordion({ tags }: { tags: LifeWheelTagConfig[] }) {
  const list = useArchivedSnoozed();
  const restore = useRestoreSignal();
  const items = list.data ?? [];

  return (
    <details className="wk-accordion">
      <summary className="wk-accordion-head">
        <span className="wk-accordion-title">
          <Archive className="size-4" /> 보관함
          <span className="wk-sec-count">{items.length}</span>
        </span>
        <span className="wk-accordion-hint">펼치기</span>
      </summary>
      <div className="wk-accordion-body">
        {list.isError && (
          <div className="wk-hint">목록을 불러오지 못했습니다: {(list.error as Error).message}</div>
        )}
        {items.length === 0 && !list.isError && (
          <div className="wk-hint">보관(archived)·미루기(snoozed)된 항목이 없습니다.</div>
        )}
        {items.map((s) => (
          <div key={s.id} className="wk-arc-item">
            <div className="wk-arc-body">
              <div className="wk-item-ttl">{s.title}</div>
              <div className="wk-arc-meta">
                <span className={`wk-arc-badge ${s.status}`}>
                  {s.status === "archived" ? "보관됨" : "미룸"}
                </span>
                {s.status === "snoozed" && s.snoozeUntil && (
                  <span className="wk-arc-sub">복귀 {md(s.snoozeUntil)}</span>
                )}
                <KindAreaChips target={s} tags={tags} />
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5 rounded-full"
              title="복원"
              disabled={restore.isPending}
              onClick={() => restore.mutate(s.id)}
            >
              <RotateCcw className="size-3.5" />
              복원
            </Button>
          </div>
        ))}
      </div>
    </details>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 error.

- [ ] **Step 3: 커밋**

```bash
git add src/components/weekly/ArchiveAccordion.tsx
git commit -m "feat(weekly): ArchiveAccordion — 보관함 접이식(복원 유지)"
```

---

### Task 9: `WeeklyView` 통합 오케스트레이션

**Files:**

- Modify: `src/components/WeeklyView.tsx` (전면 재작성)

선택 주 KPI/PR/루틴/부채는 `useWeeklyReview(range.end)`. 12주 완료 신호는 `useCompleted(windowStart, today)` 1회 → 주별 버킷팅(스크러바·선택주 레이더/회고·4주 평균). 보관함은 자식이 자체 패칭.

- [ ] **Step 1: 재작성**

```tsx
// src/components/WeeklyView.tsx
import "./WeeklyView.css";

import { CheckCircle2, GitPullRequest, Inbox, Repeat, Send, TrendingDown } from "lucide-react";
import { useEffect, useMemo } from "react";

import type { DebtPoint, WorkSignal } from "@/bindings";
import { ArchiveAccordion } from "@/components/weekly/ArchiveAccordion";
import { LifeWheelRadar } from "@/components/weekly/LifeWheelRadar";
import { ReflectionSection } from "@/components/weekly/ReflectionSection";
import { WeekNavigator } from "@/components/weekly/WeekNavigator";
import { WeekScrubber } from "@/components/weekly/WeekScrubber";
import { useCompleted, useLifeWheelTags, useWeeklyReview } from "@/lib/query";
import { useWeekNav } from "@/lib/useWeekNav";
import { WEEKS_WINDOW, weekRangeForOffset } from "@/lib/weekRange";
import { useUIStore } from "@/store";

function md(date: string): string {
  const [, m, d] = date.split("-");
  return `${Number(m)}/${Number(d)}`;
}

export function WeeklyView() {
  const nav = useWeekNav();
  const goTo = useUIStore((s) => s.goTo);

  // 선택 주 KPI/PR/루틴/부채
  const review = useWeeklyReview(nav.range.end);
  const data = review.data;

  // 12주 완료 신호 1회 — 스크러바·레이더·회고 공용
  const windowStart = weekRangeForOffset(nav.today, -(WEEKS_WINDOW - 1)).start;
  const completed = useCompleted(windowStart, nav.today);
  const allItems = useMemo(() => completed.data ?? [], [completed.data]);

  const tagsQ = useLifeWheelTags();
  const tags = tagsQ.data ?? [];

  // 주별 버킷: offset → 그 주에 완료된 신호[]
  const byOffset = useMemo(() => {
    const map = new Map<number, WorkSignal[]>();
    for (let o = -(WEEKS_WINDOW - 1); o <= 0; o++) map.set(o, []);
    for (const s of allItems) {
      const done = s.todayDoneAt;
      if (!done) continue;
      for (let o = -(WEEKS_WINDOW - 1); o <= 0; o++) {
        const r = weekRangeForOffset(nav.today, o);
        if (done >= r.start && done <= r.end) {
          map.get(o)!.push(s);
          break;
        }
      }
    }
    return map;
  }, [allItems, nav.today]);

  const countByOffset = useMemo(() => {
    const rec: Record<number, number> = {};
    byOffset.forEach((v, k) => (rec[k] = v.length));
    return rec;
  }, [byOffset]);

  const weekItems = byOffset.get(nav.offset) ?? [];
  const trailingWeeks = useMemo(
    () =>
      [nav.offset - 1, nav.offset - 2, nav.offset - 3, nav.offset - 4].map(
        (o) => byOffset.get(o) ?? [],
      ),
    [byOffset, nav.offset],
  );

  // 키보드 ←/→ (입력 포커스 시 무시)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (
        el &&
        (el.tagName === "INPUT" ||
          el.tagName === "TEXTAREA" ||
          (el as HTMLElement).isContentEditable)
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        nav.prev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nav.next();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  return (
    <div className="wk">
      <header className="wk-head" data-tauri-drag-region>
        <span className="wk-title">Weekly Review</span>
      </header>

      <WeekNavigator
        range={nav.range}
        isCurrent={nav.isCurrent}
        isOldest={nav.isOldest}
        onPrev={nav.prev}
        onNext={nav.next}
        onReset={nav.reset}
      />
      <WeekScrubber
        today={nav.today}
        selectedOffset={nav.offset}
        countByOffset={countByOffset}
        onSelect={nav.goto}
      />

      <div className="wk-scroll">
        {review.isError && (
          <div className="wk-hint">
            집계를 불러오지 못했습니다: {(review.error as Error).message}
          </div>
        )}

        {/* 히어로: 레이더 + 모멘텀 */}
        <div className="wk-hero">
          <div className="wk-card">
            <div className="wk-sec-head">
              <span className="wk-sec-name">Life Wheel · 이번 주 활동 분포</span>
            </div>
            <LifeWheelRadar
              weekSignals={weekItems}
              trailingWeeks={trailingWeeks}
              tags={tags}
              onOpenSettings={() => goTo("settings")}
            />
          </div>

          <div className="wk-momentum">
            <div className="wk-sec-head">
              <Send className="text-wr-subtle size-4" />
              <span className="wk-sec-name">처리량</span>
            </div>
            <div className="wk-stats">
              <StatTile
                icon={<Inbox className="size-4" />}
                label="캡처"
                value={data?.throughput.captured ?? 0}
              />
              <StatTile
                icon={<CheckCircle2 className="size-4" />}
                label="완료"
                value={data?.throughput.completed ?? 0}
              />
              <StatTile
                icon={<Send className="size-4" />}
                label="승격"
                value={data?.throughput.promoted ?? 0}
              />
            </div>
            <div className="wk-sec-head">
              <GitPullRequest className="text-wr-subtle size-4" />
              <span className="wk-sec-name">PR 활동</span>
            </div>
            <div className="wk-stats">
              <StatTile
                icon={<GitPullRequest className="size-4" />}
                label="새 attention"
                value={data?.prActivity.attentionNew ?? 0}
              />
              <StatTile
                icon={<CheckCircle2 className="size-4" />}
                label="정리됨"
                value={data?.prActivity.resolved ?? 0}
              />
            </div>
            <div className="wk-sec-head">
              <Repeat className="text-wr-subtle size-4" />
              <span className="wk-sec-name">루틴 이행률</span>
              {data && (
                <span className="wk-sec-count">
                  {data.routineAdherence.done}/{data.routineAdherence.due}
                </span>
              )}
            </div>
            <div className="wk-bar">
              <div
                className="wk-bar-fill"
                style={{ width: `${data?.routineAdherence.ratePct ?? 0}%` }}
              />
              <span className="wk-bar-pct">{data?.routineAdherence.ratePct ?? 0}%</span>
            </div>
          </div>
        </div>

        {/* 부채 추세 */}
        <section className="wk-sec">
          <div className="wk-sec-head">
            <TrendingDown className="text-wr-subtle size-4" />
            <span className="wk-sec-name">부채 추세 (미분류 · Q1 overdue)</span>
          </div>
          {!data || data.debtTrend.length === 0 ? (
            <div className="wk-hint">추세 데이터가 쌓이는 중입니다.</div>
          ) : (
            <DebtTrend points={data.debtTrend} />
          )}
        </section>

        {/* 회고(병합) */}
        <section className="wk-sec">
          <div className="wk-sec-head">
            <span className="wk-sec-name">회고 · 이 주 완료한 일</span>
          </div>
          <ReflectionSection items={weekItems} tags={tags} />
        </section>

        {/* 보관함(병합·접이식) */}
        <ArchiveAccordion tags={tags} />
      </div>
    </div>
  );
}

function StatTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="wk-tile">
      <span className="wk-tile-top">
        {icon}
        <span className="wk-tile-label">{label}</span>
      </span>
      <span className="wk-tile-val">{value}</span>
    </div>
  );
}

function DebtTrend({ points }: { points: DebtPoint[] }) {
  const max = Math.max(1, ...points.map((p) => Math.max(p.unclassified, p.q1Overdue)));
  return (
    <div className="wk-trend">
      {points.map((p) => (
        <div key={p.date} className="wk-trend-col">
          <div className="wk-trend-bars">
            <div
              className="wk-trend-bar wk-trend-uncl"
              style={{ height: `${(p.unclassified / max) * 100}%` }}
              title={`미분류 ${p.unclassified}`}
            />
            <div
              className="wk-trend-bar wk-trend-q1"
              style={{ height: `${(p.q1Overdue / max) * 100}%` }}
              title={`Q1 overdue ${p.q1Overdue}`}
            />
          </div>
          <span className="wk-trend-date">{md(p.date)}</span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 0 error. (이 시점엔 RetroView가 아직 존재 — App에서 참조 중이라 OK.)

- [ ] **Step 3: 커밋**

```bash
git add src/components/WeeklyView.tsx
git commit -m "feat(weekly): WeeklyView 통합 — 주차 네비+레이더+모멘텀+회고+보관함 한 페이지"
```

---

### Task 10: 라우팅 정리 (파괴적 — retro 제거)

**Files:**

- Modify: `src/store.ts:4-15` (`View`에서 `"retro"` 삭제)
- Modify: `src/lib/nav.ts:80-87` (retro NAV_ITEM 삭제)
- Modify: `src/App.tsx:17,47` (import + 분기 삭제)
- Delete: `src/components/RetroView.tsx`, `src/components/RetroView.css`

- [ ] **Step 1: `View`에서 `"retro"` 제거**

`src/store.ts` 의 `View` 유니온에서 `| "retro"` 줄 삭제:

```ts
export type View =
  | "board"
  | "today"
  | "weekly"
  | "routines"
  | "settings"
  | "radar"
  | "worktree"
  | "jobs"
  | "skills"
  | "control-room";
```

- [ ] **Step 2: nav.ts에서 retro NAV_ITEM 제거**

`src/lib/nav.ts` `NAV_ITEMS` 배열에서 다음 객체 전체 삭제(view: "weekly" 다음, "routines" 앞):

```ts
  {
    view: "retro",
    label: "회고 / 보관함",
    search: "retro 회고 완료 임팩트 보관함 archive 복원 regret",
    icon: History,
    group: "review",
    defaultShortcut: "Cmd+5",
  },
```

또한 `weekly`의 `search`에 회고 키워드 흡수(병합 반영):

```ts
    search: "weekly review 주간 회고 집계 처리량 추세 임팩트 보관함 archive 복원",
```

(`History` import가 더 이상 쓰이지 않으면 import 목록에서 제거 — tsc/lint가 표면.)

- [ ] **Step 3: App.tsx에서 RetroView 제거**

`src/App.tsx`:

- `import { RetroView } from "@/components/RetroView";` 줄 삭제.
- `if (renderedView === "retro") return <RetroView />;` 줄 삭제.

- [ ] **Step 4: RetroView 파일 삭제**

```bash
git rm src/components/RetroView.tsx src/components/RetroView.css
```

- [ ] **Step 5: typecheck + lint (잔여 참조 표면)**

Run: `pnpm typecheck && pnpm lint 2>&1 | tail -15`
Expected: 0 type error. lint는 기존 baseline 경고만(신규 에러 0). `"retro"` 잔여 참조가 있으면 여기서 에러로 표면 → 해당 파일 수정.

- [ ] **Step 6: 커밋**

```bash
git add -A
git commit -m "feat(weekly)!: retro 뷰/라우트 제거 — 회고·보관함을 Weekly Review로 통합

BREAKING: 'retro' View/NAV_ITEM 삭제, RetroView 파일 제거. Cmd+5 미할당."
```

---

### Task 11: 스타일 (`WeeklyView.css`)

**Files:**

- Modify: `src/components/WeeklyView.css` (신규 `.wk-*` 추가; 기존 유지)

토큰만 사용(raw hex 금지 — 단, recharts inline은 토큰 var()). 네비/스크러바/히어로 2단/레이더 바/회고/아코디언.

- [ ] **Step 1: CSS 추가**

`src/components/WeeklyView.css` 끝에 추가:

```css
/* ── 주차 네비게이터 ─────────────────────────── */
.wk .wk-nav {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 0;
  border-bottom: 1px solid var(--color-wr-border-light);
}
.wk .wk-pager {
  display: flex;
  align-items: center;
  gap: 6px;
}
.wk .wk-pager button {
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid var(--color-wr-card-border);
  border-radius: 8px;
  background: var(--color-wr-bg);
  color: var(--color-wr-fg);
  cursor: pointer;
}
.wk .wk-pager button:disabled {
  opacity: 0.35;
  cursor: default;
}
.wk .wk-cur {
  min-width: 150px;
  text-align: center;
  font: 600 13px/1.1 var(--font-sans);
}
.wk .wk-cur small {
  display: block;
  margin-top: 3px;
  font: 500 10px/1.3 var(--font-mono);
  color: var(--color-wr-subtle);
}
.wk .wk-today-btn {
  margin-left: auto;
  font: 600 11px/1 var(--font-sans);
  padding: 7px 12px;
  border: 1px solid var(--color-wr-card-border);
  border-radius: 8px;
  background: var(--color-wr-bg);
  color: var(--color-wr-subtle);
  cursor: pointer;
}

/* ── 스크러바 ─────────────────────────── */
.wk .wk-scrub {
  display: flex;
  gap: 4px;
  padding: 12px 0 14px;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-wr-border-light);
}
.wk .wk-week {
  flex: 0 0 auto;
  width: 44px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 4px 6px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: none;
  cursor: pointer;
}
.wk .wk-week:hover {
  background: var(--color-wr-surface);
}
.wk .wk-week.on {
  background: var(--color-wr-bg);
  border-color: var(--color-wr-fg);
  box-shadow: var(--wr-shadow-sm);
}
.wk .wk-spark {
  height: 34px;
  display: flex;
  align-items: flex-end;
}
.wk .wk-spark i {
  display: block;
  width: 14px;
  border-radius: 3px;
  background: var(--color-wr-subtle);
}
.wk .wk-week.on .wk-spark i {
  background: var(--color-wr-green);
}
.wk .wk-week-lab {
  font: 600 10px/1 var(--font-mono);
  color: var(--color-wr-subtle);
}
.wk .wk-week.on .wk-week-lab {
  color: var(--color-wr-fg);
}

/* ── 히어로 2단 ─────────────────────────── */
.wk .wk-hero {
  display: grid;
  grid-template-columns: minmax(0, 360px) 1fr;
  gap: 24px;
  padding-top: 18px;
}
@media (max-width: 720px) {
  .wk .wk-hero {
    grid-template-columns: 1fr;
  }
}
.wk .wk-card {
  border: 1px solid var(--color-wr-card-border);
  border-radius: 12px;
  padding: 16px;
}
.wk .wk-momentum {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* ── 레이더 ─────────────────────────── */
.wk .wk-radar-legend {
  display: flex;
  gap: 14px;
  justify-content: center;
  margin-top: 8px;
}
.wk .wk-radar-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font: 500 11px/1 var(--font-sans);
  color: var(--color-wr-subtle);
}
.wk .wk-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}
.wk .wk-radar-bars {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0;
}
.wk .wk-bar-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.wk .wk-bar-axis {
  width: 64px;
  font: 500 11px/1 var(--font-sans);
  color: var(--color-wr-fg);
}
.wk .wk-bar-track {
  flex: 1;
  height: 14px;
  border-radius: 999px;
  background: var(--color-wr-surface);
  overflow: hidden;
}
.wk .wk-bar-cur {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--color-wr-green);
}
.wk .wk-bar-num {
  font: 600 12px/1 var(--font-mono);
  color: var(--color-wr-subtle);
}
.wk .wk-radar-empty {
  padding: 24px;
  text-align: center;
  font: 400 12px/1.5 var(--font-sans);
  color: var(--color-wr-subtle);
}
.wk .wk-link {
  color: var(--color-wr-green);
  text-decoration: underline;
  background: none;
  border: 0;
  cursor: pointer;
  font: inherit;
}

/* ── 회고 랭킹/타임라인 ─────────────────────────── */
.wk .wk-rank {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 14px;
}
.wk .wk-rank-card {
  border: 1px solid var(--color-wr-card-border);
  border-radius: 12px;
  padding: 12px 14px;
}
.wk .wk-rank-card.impact {
  background: var(--color-wr-accent-soft, #eaf3ee);
}
.wk .wk-rank-card.regret {
  background: var(--cb-pale-coral, #f7ece8);
}
.wk .wk-rank-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.wk .wk-rank-title {
  font: 600 12px/1 var(--font-sans);
}
.wk .wk-rank-count {
  margin-left: auto;
  font: 600 11px/1 var(--font-mono);
  color: var(--color-wr-subtle);
}
.wk .wk-rank-empty {
  font: 400 11px/1.4 var(--font-sans);
  color: var(--color-wr-subtle);
}
.wk .wk-rank-list {
  margin: 0;
  padding-left: 16px;
}
.wk .wk-rank-item {
  font: 400 12px/1.5 var(--font-sans);
}
.wk .wk-group {
  display: grid;
  grid-template-columns: 48px 1fr;
  gap: 14px;
  padding: 11px 0;
  border-top: 1px solid var(--color-wr-border-light);
}
.wk .wk-group-date {
  font: 600 11px/1.3 var(--font-mono);
  color: var(--color-wr-subtle);
}
.wk .wk-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 0;
}
.wk .wk-item-ttl {
  font: 400 13px/1.4 var(--font-sans);
}
.wk .wk-item-body {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.wk .wk-item-tags {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.wk .wk-tag-btn {
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border: 1px solid var(--color-wr-card-border);
  border-radius: 7px;
  background: var(--color-wr-bg);
  color: var(--color-wr-subtle);
  cursor: pointer;
}
.wk .wk-tag-btn.impact.on {
  background: var(--cb-pale-green, #eaf3ee);
  color: var(--color-wr-green);
  border-color: transparent;
}
.wk .wk-tag-btn.regret.on {
  background: var(--cb-pale-coral, #f7ece8);
  color: var(--color-wr-coral);
  border-color: transparent;
}

/* ── 보관함 아코디언 ─────────────────────────── */
.wk .wk-accordion {
  border: 1px solid var(--color-wr-card-border);
  border-radius: 12px;
  margin-top: 18px;
  overflow: hidden;
}
.wk .wk-accordion-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  cursor: pointer;
  list-style: none;
  font: 600 13px/1 var(--font-sans);
  background: var(--color-wr-elevated, var(--color-wr-surface));
}
.wk .wk-accordion-head::-webkit-details-marker {
  display: none;
}
.wk .wk-accordion-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.wk .wk-accordion-hint {
  font: 400 11px/1 var(--font-sans);
  color: var(--color-wr-subtle);
}
.wk .wk-accordion-body {
  padding: 4px 16px 12px;
}
.wk .wk-arc-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-top: 1px solid var(--color-wr-border-light);
}
.wk .wk-arc-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.wk .wk-arc-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.wk .wk-arc-badge {
  font: 600 10px/1 var(--font-sans);
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--color-wr-surface);
  color: var(--color-wr-subtle);
  border: 1px solid var(--color-wr-card-border);
}
.wk .wk-arc-sub {
  font: 500 11px/1 var(--font-mono);
  color: var(--color-wr-subtle);
}
```

> 주의: 위에서 참조한 토큰명(`--color-wr-green`, `--color-wr-coral`, `--color-wr-subtle`,
> `--color-wr-card-border`, `--color-wr-border-light`, `--color-wr-surface`, `--color-wr-elevated`,
> `--color-wr-accent-soft`, `--cb-pale-green`, `--cb-pale-coral`, `--wr-shadow-sm`)이 실재하는지
> `src/styles/tokens.css`/기존 `WeeklyView.css`/`RetroView.css`에서 확인하고, 없으면 가장 가까운
> 기존 토큰으로 치환(fallback 값은 임시일 뿐 — raw hex 잔존 금지가 원칙).

- [ ] **Step 2: typecheck + lint + dev 부팅**

Run: `pnpm typecheck && pnpm lint 2>&1 | tail -5`
Expected: 0 type error, 신규 lint 에러 0.

- [ ] **Step 3: 커밋**

```bash
git add src/components/WeeklyView.css
git commit -m "style(weekly): 네비/스크러바/히어로 2단/레이더 바/회고/아코디언 스타일(토큰)"
```

---

### Task 12: 전체 게이트 + 통합 검증

**Files:** (없음 — 검증)

- [ ] **Step 1: 전체 게이트**

Run: `pnpm typecheck && pnpm lint 2>&1 | tail -5 && pnpm vitest run 2>&1 | tail -6`
Expected: typecheck 0 / lint 신규 에러 0 / vitest 전부 PASS(베이스라인 + 신규 weekRange·lifeWheelRadar·useWeekNav).

- [ ] **Step 2: bindings drift 0 확인(백엔드 무변경 자명)**

Run: `git status --short src/bindings.ts`
Expected: 출력 없음(미변경).

- [ ] **Step 3: tauri dev 부팅 스모크**

Run: `pnpm tauri dev`(백그라운드) → 콘솔 패닉 0, Weekly Review 진입.
Expected: 부팅 성공. (네이티브 WKWebView 클릭 스모크는 사용자/cmux — 핸드오프에 명시.)

- [ ] **Step 4: critic 별도 패스**

`oh-my-claudecode:critic`(opus)에게 diff 전체 리뷰 의뢰 — INVARIANT(특히 #1 자동분류 0/#2 외부변경 0), area 경계, 토큰 준수, 빈/degenerate 상태. ACCEPT 전엔 done 아님.

- [ ] **Step 5: 라이브 비주얼 스모크 핸드오프**

사용자/cmux 체크리스트: 주차 페이징(‹ ›)·스크러바 클릭·이번 주로·키보드 ←/→·레이더 갱신·태그 개수 0/1/2/3+ 케이스·회고 impact/regret 토글·보관함 펼침/복원.

---

## Self-Review (작성자 점검 완료)

- **Spec 커버리지:** §3 데이터(Task 9 단일 12주 쿼리 버킷팅) / §4.1 useWeekNav(Task 4) / §4.2 레이더 가변축·degenerate(Task 3+5) / §5 라우팅 파괴적 제거(Task 10) / §6 디자인 토큰(Task 11) / §8 테스트(Task 1·3·4) / §9 슬라이스 순서 매핑. 모두 태스크 존재.
- **Placeholder:** 모든 코드 단계에 실제 코드 포함. Task 11 토큰 검증은 "확인 후 치환" 구체 지시(placeholder 아님).
- **타입 일관성:** `weekRangeForOffset`/`WeekRange`/`clampOffset`/`computeRadarAxes`/`RadarAxis`/`radarRenderMode`/`useWeekNav`/`parseAreaTagKeys` 명칭이 정의 태스크와 소비 태스크에서 일치.
- **알려진 검증 항목:** `weeklyReview(range.end)`가 현재 주(미래 일요일 endDate) 입력에 에러 없이 동작하는지 — Task 0 이후 dev 부팅/Task 9에서 실측. 에러 시 폴백: 현재 주만 `end=today`로 clamp(weekRangeForOffset에 today clamp 추가).
