# Timeline Coordinate/Time SSOT — Phase 1 (Axis SSOT) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the 5 duplicated `HOUR_PX`/`DAY_PX` pixel constants and the 3+ inline client→grid conversions into one module (`src/lib/timelineAxis.ts`), with **zero behavior change**.

**Architecture:** Phase 1 of the redesign in `docs/superpowers/specs/2026-06-20-today-timeline-coordinate-time-ssot-design.md` §3.1 / §4(1). It is a pure refactor: every consumer (`timelineLayout`, `timelineCoords`, `useTimelineDnd`, `TimelineCanvas`, `useTimelineScroll`, `timelinePreview`, `useTimelinePointerDelta`) imports the constants + conversion helpers from the new module instead of redefining them. No runtime behavior changes; the existing test suites are the regression net.

**Tech Stack:** TypeScript, React, Vite, Vitest. Pure functions only (no `Date.now`/random).

## Global Constraints

- **No behavior change.** Every existing test must stay green; no new runtime behavior. (Behavior changes belong to Phases 2–5.)
- **INVARIANT #7** (`docs/areas/today-timeline.md`): local-ISO only; never `.toISOString()`. Phase 1 touches pixels only, not ISO parsing — keep it that way.
- **Domain separation (critical):** `1px == 1min` holds only because `HOUR_PX=60`. Keep **pixel** quantities (`DAY_PX`, `totalPxForDays`) distinct from **minute** quantities (`MIN_PER_DAY`). Do NOT replace a minutes `1440` with a pixels `DAY_PX` or vice-versa even though they are numerically equal.
- **ADR-0004:** `@dnd-kit` imports stay in `src/components/today/**`. Phase 1 adds no dnd imports.
- **Verification gates** (`docs/reference/commands.md`): `pnpm typecheck`, `pnpm lint`, `pnpm vitest run`. `bindings.ts` is untouched in Phase 1 (no Rust/IPC change) → drift must stay 0.
- **Commit style:** Conventional Commits; commit message body ends with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push (user pushes explicitly). Stage only the files each task lists — the working tree has an unrelated `src-tauri/src/lib.rs` WIP that must never be staged.

---

## File Structure

- **Create** `src/lib/timelineAxis.ts` — the single source of truth for time↔pixel constants and stateless conversion helpers.
- **Create** `src/lib/timelineAxis.test.ts` — unit tests for the new helpers.
- **Modify** `src/lib/timelineLayout.ts` — import `HOUR_PX`, `MIN_BLOCK_PX` from axis; delete local copies.
- **Modify** `src/lib/timelineCoords.ts` — import `HOUR_PX`, `SNAP_MIN`, `MIN_PER_DAY` from axis; delete local copies.
- **Modify** `src/components/today/TimelineCanvas.tsx` — import `HOUR_PX`, `DAY_PX` from axis; route `onPointerMove` through `clientToGrid`.
- **Modify** `src/components/today/useTimelineScroll.ts` — import `DAY_PX` from axis; delete local copy.
- **Modify** `src/components/today/useTimelineDnd.ts` — import `HOUR_PX`, `SNAP_MIN` from axis; route `resolveCanvasGridY` through `clientToGrid`.
- **Modify** `src/components/today/timelinePreview.ts` — re-implement `clientPointToGridGuide` as a thin delegate to axis `clientToGrid` (keeps the existing export name so callers don't churn).

---

### Task 1: Create the `timelineAxis` module + tests

**Files:**

- Create: `src/lib/timelineAxis.ts`
- Test: `src/lib/timelineAxis.test.ts`

**Interfaces:**

- Consumes: nothing (leaf module).
- Produces:
  - `HOUR_PX: 60`, `MIN_BLOCK_PX: 20`, `SNAP_MIN: 15`, `MIN_PER_DAY: 1440`, `PX_PER_MIN: 1`, `DAY_PX: 1440`, `LABEL_GUTTER_PX: 60`
  - `minToPx(min: number): number`
  - `pxToMin(px: number): number`
  - `totalPxForDays(days: number): number`
  - `clientToGrid(point: {x:number;y:number}, rect: {left:number;top:number;width:number}, totalPx: number): {x:number;y:number}`

- [ ] **Step 1: Write the failing test**

Create `src/lib/timelineAxis.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  clientToGrid,
  DAY_PX,
  HOUR_PX,
  LABEL_GUTTER_PX,
  MIN_BLOCK_PX,
  MIN_PER_DAY,
  minToPx,
  PX_PER_MIN,
  pxToMin,
  SNAP_MIN,
  totalPxForDays,
} from "./timelineAxis";

describe("timelineAxis constants", () => {
  it("pins the values the whole timeline relies on", () => {
    expect(HOUR_PX).toBe(60);
    expect(MIN_BLOCK_PX).toBe(20);
    expect(SNAP_MIN).toBe(15);
    expect(MIN_PER_DAY).toBe(1440);
    expect(PX_PER_MIN).toBe(1);
    expect(DAY_PX).toBe(1440);
    expect(LABEL_GUTTER_PX).toBe(60);
  });
});

describe("minToPx / pxToMin", () => {
  it("round-trips minutes through pixels", () => {
    for (const min of [0, 15, 90, 1439, 2880]) {
      expect(pxToMin(minToPx(min))).toBe(min);
    }
  });
  it("uses 1px == 1min (HOUR_PX/60)", () => {
    expect(minToPx(60)).toBe(60);
    expect(pxToMin(60)).toBe(60);
  });
});

describe("totalPxForDays", () => {
  it("is days * DAY_PX", () => {
    expect(totalPxForDays(1)).toBe(1440);
    expect(totalPxForDays(3)).toBe(4320);
  });
});

describe("clientToGrid", () => {
  const rect = { left: 100, top: 200, width: 800 };
  it("subtracts rect origin", () => {
    expect(clientToGrid({ x: 460, y: 560 }, rect, 4320)).toEqual({ x: 360, y: 360 });
  });
  it("clamps y to [0, totalPx]", () => {
    expect(clientToGrid({ x: 460, y: 100 }, rect, 4320).y).toBe(0);
    expect(clientToGrid({ x: 460, y: 999999 }, rect, 4320).y).toBe(4320);
  });
  it("clamps x to [LABEL_GUTTER_PX, rect.width]", () => {
    expect(clientToGrid({ x: 100, y: 560 }, rect, 4320).x).toBe(LABEL_GUTTER_PX);
    expect(clientToGrid({ x: 999999, y: 560 }, rect, 4320).x).toBe(800);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/timelineAxis.test.ts`
Expected: FAIL — `Failed to resolve import "./timelineAxis"`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/timelineAxis.ts`:

```ts
/**
 * 타임라인 좌표 정본(SSOT) — 시간↔픽셀 상수 + 무상태 변환 헬퍼.
 *
 * 이 모듈만 픽셀-per-시간을 정의한다. 다른 어떤 파일도 HOUR_PX/DAY_PX를
 * 로컬 정의하지 않는다(SSOT 설계 `docs/superpowers/specs/2026-06-20-...-ssot-design.md` §3.1).
 *
 * 도메인 주의: `1px == 1min`은 HOUR_PX=60이라서 성립한다. 픽셀량(DAY_PX/totalPxForDays)과
 * 분량(MIN_PER_DAY)을 절대 섞지 않는다 — 수치는 같아도 의미가 다르다.
 */

/** 1시간 = 60px (연속 타임라인 스펙 §D2). */
export const HOUR_PX = 60;
/** 렌더 시 블록 최소 높이(px) — 짧은 블록 가독성 floor. */
export const MIN_BLOCK_PX = 20;
/** 기본 그리드 스냅 단위(분). Alt/Option fine-snap 시 5. */
export const SNAP_MIN = 15;
/** 하루 분(min). 절대-분 축 클램프용 — 픽셀 아님. */
export const MIN_PER_DAY = 1440;
/** 1분당 픽셀. HOUR_PX/60. */
export const PX_PER_MIN = HOUR_PX / 60;
/** 하루 높이(px) = 60px/h × 24h. MIN_PER_DAY와 수치 동일하나 의미는 픽셀. */
export const DAY_PX = 24 * HOUR_PX;
/** 시간 라벨 거터 너비(px) — 그리드 컬럼 왼쪽 여백. client→grid x 클램프 하한. */
export const LABEL_GUTTER_PX = 60;

/** 절대 분 → 픽셀(Y). */
export function minToPx(min: number): number {
  return min * PX_PER_MIN;
}

/** 픽셀(Y) → 절대 분. */
export function pxToMin(px: number): number {
  return px / PX_PER_MIN;
}

/** 로드된 일수의 그리드 총 높이(px). */
export function totalPxForDays(days: number): number {
  return days * DAY_PX;
}

/**
 * viewport client 좌표 → 그리드 로컬 좌표. y는 [0, totalPx], x는
 * [LABEL_GUTTER_PX, rect.width]로 클램프. 타임라인 전역의 유일한 client→grid 변환.
 */
export function clientToGrid(
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number },
  totalPx: number,
): { x: number; y: number } {
  return {
    y: Math.max(0, Math.min(totalPx, point.y - rect.top)),
    x: Math.max(LABEL_GUTTER_PX, Math.min(rect.width, point.x - rect.left)),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/timelineAxis.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/timelineAxis.ts src/lib/timelineAxis.test.ts
git commit -m "feat(today): add timelineAxis coordinate SSOT module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Migrate `timelineLayout.ts` to the axis constants

**Files:**

- Modify: `src/lib/timelineLayout.ts:49-50` (delete local `HOUR_PX`/`MIN_BLOCK_PX`), `:124-125`, `:14` (import).
- Test: `src/lib/timelineLayout.test.ts` (existing — regression net, do not change).

**Interfaces:**

- Consumes: `HOUR_PX`, `MIN_BLOCK_PX` from Task 1.
- Produces: unchanged `computeLayout` / `magnetEdgesFromBoxes` signatures.

- [ ] **Step 1: Run the existing suite to confirm green baseline**

Run: `pnpm vitest run src/lib/timelineLayout.test.ts`
Expected: PASS (baseline before refactor).

- [ ] **Step 2: Replace the local constants with imports**

In `src/lib/timelineLayout.ts`, the import at line 14 is currently:

```ts
import { absMin, localDateOf } from "./timeAxis";
```

Add an axis import directly below it:

```ts
import { HOUR_PX, MIN_BLOCK_PX } from "./timelineAxis";
```

Delete lines 49-50:

```ts
const HOUR_PX = 60;
const MIN_BLOCK_PX = 20;
```

Leave `topPx: startMin * (HOUR_PX / 60)` (line 124) and `heightPx: Math.max(MIN_BLOCK_PX, (endMin - startMin) * (HOUR_PX / 60))` (line 125) exactly as-is — they now reference the imported constants.

- [ ] **Step 3: Run typecheck + the layout suite**

Run: `pnpm vitest run src/lib/timelineLayout.test.ts && pnpm typecheck`
Expected: PASS, 0 type errors. (Values identical → behavior unchanged.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/timelineLayout.ts
git commit -m "refactor(today): timelineLayout uses timelineAxis constants

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Migrate `timelineCoords.ts` to the axis constants

**Files:**

- Modify: `src/lib/timelineCoords.ts:6-9` (import + delete local `HOUR_PX`/`SNAP_MIN`), `:49-51` (`clampAbs`).
- Test: `src/lib/timelineCoords.test.ts` (existing — regression net).

**Interfaces:**

- Consumes: `HOUR_PX`, `SNAP_MIN`, `MIN_PER_DAY` from Task 1.
- Produces: unchanged `snapAbsMin` / `pixelToLocalIso` / `shiftIsoByPx` / `resizeIsoByPx` / `clampIsoToDate` / `clampDurationToDate` / `plusMinutesLocal` signatures.

- [ ] **Step 1: Run the existing suite to confirm green baseline**

Run: `pnpm vitest run src/lib/timelineCoords.test.ts`
Expected: PASS.

- [ ] **Step 2: Replace local constants with imports; keep minute-domain explicit**

The header import (line 6) is:

```ts
import { absMin, isoFromAbsMin } from "./timeAxis";
```

Add below it:

```ts
import { HOUR_PX, MIN_PER_DAY, SNAP_MIN } from "./timelineAxis";
```

Delete lines 8-9:

```ts
const HOUR_PX = 60;
const SNAP_MIN = 15;
```

Keep `MAGNET_THRESHOLD_MIN` (line 11) local — it is coords-specific, not a pixel constant.

In `clampAbs` (lines 49-51), the `1440` is **minutes per day**, not pixels. Make that explicit:

```ts
function clampAbs(min: number, days: number): number {
  return Math.max(0, Math.min(days * MIN_PER_DAY - SNAP_MIN, min));
}
```

Leave every `(deltaPx / HOUR_PX) * 60` and `(gridY / HOUR_PX) * 60` expression unchanged — they now read the imported `HOUR_PX`.

- [ ] **Step 3: Run typecheck + the coords suite**

Run: `pnpm vitest run src/lib/timelineCoords.test.ts && pnpm typecheck`
Expected: PASS, 0 type errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/timelineCoords.ts
git commit -m "refactor(today): timelineCoords uses timelineAxis constants (minute vs pixel domain split)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Unify `clientPointToGridGuide` onto axis `clientToGrid`

**Files:**

- Modify: `src/components/today/timelinePreview.ts:30-38` (re-implement as delegate), `:1-15` (import).
- Test: `src/components/today/timelinePreview.test.ts` (existing — regression net).

**Interfaces:**

- Consumes: `clientToGrid` from Task 1.
- Produces: `clientPointToGridGuide(point, rect, totalPx)` — **same name, same signature, same result** (so `useTimelinePointerDelta` needs no change).

- [ ] **Step 1: Run the existing suite to confirm green baseline**

Run: `pnpm vitest run src/components/today/timelinePreview.test.ts`
Expected: PASS.

- [ ] **Step 2: Replace the body with a delegate**

Add to the imports at the top of `src/components/today/timelinePreview.ts`:

```ts
import { clientToGrid } from "@/lib/timelineAxis";
```

Replace the existing `clientPointToGridGuide` (lines 30-38) with:

```ts
/**
 * viewport client 좌표 → 그리드 로컬 좌표. 정본 변환 `timelineAxis.clientToGrid`에 위임한다
 * (기존 호출부 호환을 위해 이름·시그니처 유지). 드래그 중 raw client pointer를 이 함수로
 * 환산하면 오버레이 hit-test로 onPointerMove가 끊겨도 크로스헤어/델타가 실제 커서를 따른다.
 */
export function clientPointToGridGuide(
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number },
  totalPx: number,
): { x: number; y: number } {
  return clientToGrid(point, rect, totalPx);
}
```

- [ ] **Step 3: Run typecheck + the preview suite**

Run: `pnpm vitest run src/components/today/timelinePreview.test.ts && pnpm typecheck`
Expected: PASS (identical math), 0 type errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/today/timelinePreview.ts
git commit -m "refactor(today): clientPointToGridGuide delegates to timelineAxis.clientToGrid

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Migrate `TimelineCanvas.tsx` + `useTimelineScroll.ts`

**Files:**

- Modify: `src/components/today/TimelineCanvas.tsx:19-20` (delete local `HOUR_PX`/`DAY_PX`), import, `:176-189` (`onPointerMove`).
- Modify: `src/components/today/useTimelineScroll.ts:9` (delete local `DAY_PX`), import.
- Test: existing `today` suites + typecheck (these files have no direct unit test; the guard is typecheck + lint + render-path tests).

**Interfaces:**

- Consumes: `HOUR_PX`, `DAY_PX`, `clientToGrid`, `totalPxForDays` from Task 1.
- Produces: unchanged component/hook behavior.

- [ ] **Step 1: Confirm green baseline for the area**

Run: `pnpm vitest run src/components/today src/lib/timelineLayout.test.ts`
Expected: PASS.

- [ ] **Step 2: Migrate `useTimelineScroll.ts`**

Add to the imports (below line 3 `import { addDays, dayDiff } from "@/lib/timeAxis";`):

```ts
import { DAY_PX } from "@/lib/timelineAxis";
```

Delete lines 8-9:

```ts
/** 하루 높이(px) — 60px/h × 24h. */
const DAY_PX = 24 * 60;
```

(Leave `MAX_LOADED_DAYS` and the `now.getHours() * 60 + now.getMinutes()` math at line 49 unchanged — that is minute arithmetic for the now-line scroll target, untouched in Phase 1.)

- [ ] **Step 3: Migrate `TimelineCanvas.tsx` constants**

Add to the imports (the file already imports from `@/lib/timeAxis` at line 16):

```ts
import { clientToGrid, DAY_PX, HOUR_PX } from "@/lib/timelineAxis";
```

Delete lines 19-20:

```ts
const HOUR_PX = 60;
const DAY_PX = 24 * HOUR_PX;
```

(`HOURS` at line 21 stays.) `nowOffsetPx` (line 54) still uses `HOUR_PX` — now the imported one; leave its body unchanged (its `new Date().getHours()` is a Phase-3 concern, NOT Phase 1).

- [ ] **Step 4: Route `onPointerMove` through `clientToGrid`**

Replace the body of `onPointerMove` (lines 176-189). Current:

```ts
function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
  const el = gridRef.current;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const y = Math.max(0, Math.min(totalPx, e.clientY - rect.top));
  const x = Math.max(60, Math.min(rect.width, e.clientX - rect.left));
  if (pointerYRef) pointerYRef.current = y;
  if (pointerXRef) pointerXRef.current = x;
  if (isOver || activeDrag) {
    setHoverPx(y);
    setHoverX(x);
    if (gridWidth !== rect.width) setGridWidth(rect.width);
  }
}
```

New (identical clamps via the SSOT helper; `totalPx` is already `days * DAY_PX` at line 95):

```ts
function onPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
  const el = gridRef.current;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const { x, y } = clientToGrid({ x: e.clientX, y: e.clientY }, rect, totalPx);
  if (pointerYRef) pointerYRef.current = y;
  if (pointerXRef) pointerXRef.current = x;
  if (isOver || activeDrag) {
    setHoverPx(y);
    setHoverX(x);
    if (gridWidth !== rect.width) setGridWidth(rect.width);
  }
}
```

- [ ] **Step 5: Run typecheck + lint + the area suite**

Run: `pnpm typecheck && pnpm vitest run src/components/today && pnpm lint`
Expected: PASS, 0 type errors, 0 new lint errors. (`totalPxForDays` import is optional here since `totalPx` already exists; import it only if you also replace line 95 `const totalPx = days * DAY_PX;` with `const totalPx = totalPxForDays(days);` — equivalent.)

- [ ] **Step 6: Commit**

```bash
git add src/components/today/TimelineCanvas.tsx src/components/today/useTimelineScroll.ts
git commit -m "refactor(today): TimelineCanvas + useTimelineScroll use timelineAxis (constants + clientToGrid)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Migrate `useTimelineDnd.ts` + route `resolveCanvasGridY` through `clientToGrid`

**Files:**

- Modify: `src/components/today/useTimelineDnd.ts:49-53` (import + delete local `HOUR_PX`/`SNAP_MIN`), `:334-341` (`resolveCanvasGridY`).
- Test: existing `today` suites + typecheck.

**Interfaces:**

- Consumes: `HOUR_PX`, `SNAP_MIN`, `clientToGrid`, `totalPxForDays` from Task 1.
- Produces: unchanged `useTimelineDnd` behavior. (NOTE: `SNAP_MIN`/`HOUR_PX` may be referenced elsewhere in this 833-line file; this task only changes their definition source, not call sites.)

- [ ] **Step 1: Confirm green baseline**

Run: `pnpm vitest run src/components/today`
Expected: PASS.

- [ ] **Step 2: Replace local constants with imports**

The coords import block ends at line 49 (`import { type LayoutBox, magnetEdgesFromBoxes } from "@/lib/timelineLayout";`). Add below it:

```ts
import { clientToGrid, HOUR_PX, SNAP_MIN, totalPxForDays } from "@/lib/timelineAxis";
```

Delete lines 52-53:

```ts
const HOUR_PX = 60;
const SNAP_MIN = 15;
```

Leave `DEFAULT_SCHEDULE_MIN` / `ROUTINE_SCHEDULE_MIN` / `hhmmOfIso` (lines 54-59) unchanged.

- [ ] **Step 3: Route `resolveCanvasGridY` through `clientToGrid`**

Replace `resolveCanvasGridY` (lines 334-341). Current:

```ts
const resolveCanvasGridY = (fallback: number): number => {
  const el = gridElRef?.current;
  const p = pointerClientRef?.current;
  if (!el || !p) return fallback;
  const rect = el.getBoundingClientRect();
  const y = p.y - rect.top;
  return Math.max(0, Math.min(days * 24 * HOUR_PX, y));
};
```

New (same clamp domain `days * DAY_PX` via `totalPxForDays`; same y math via `clientToGrid`):

```ts
const resolveCanvasGridY = (fallback: number): number => {
  const el = gridElRef?.current;
  const p = pointerClientRef?.current;
  if (!el || !p) return fallback;
  const rect = el.getBoundingClientRect();
  return clientToGrid(p, rect, totalPxForDays(days)).y;
};
```

- [ ] **Step 4: Run full gate for the area**

Run: `pnpm typecheck && pnpm vitest run src/components/today && pnpm lint`
Expected: PASS, 0 type errors. If `HOUR_PX` ends up unused after this change (only `SNAP_MIN` referenced elsewhere), remove it from the import to satisfy `noUnusedLocals`; if `SNAP_MIN` is unused, likewise. Let typecheck/lint dictate the final import list.

- [ ] **Step 5: Commit**

```bash
git add src/components/today/useTimelineDnd.ts
git commit -m "refactor(today): useTimelineDnd uses timelineAxis (constants + clientToGrid)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Structural guard — ban duplicate pixel constants (H1)

**Files:**

- Create: `scripts/check-timeline-axis-ssot.mjs`
- Modify: `package.json` (add a `check:timeline-axis` script + wire into the lint/CI aggregate the repo already uses, mirroring `check:design-tokens`).
- Test: the guard script itself (run it; it must pass on the now-migrated tree and fail on a planted violation).

**Interfaces:**

- Consumes: nothing.
- Produces: a CI guard that fails if `HOUR_PX`/`DAY_PX`/`= 24 * 60`/`* HOUR_PX` pixel constants are defined outside `src/lib/timelineAxis.ts`.

- [ ] **Step 1: Write the guard script**

Create `scripts/check-timeline-axis-ssot.mjs`:

```js
#!/usr/bin/env node
// Fails if any timeline pixel constant is defined outside the SSOT module.
// SSOT design: docs/superpowers/specs/2026-06-20-today-timeline-coordinate-time-ssot-design.md §3.5 (H1).
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";

const SSOT = "src/lib/timelineAxis.ts";
const files = globSync("src/**/*.{ts,tsx}", {
  exclude: [SSOT, "src/**/*.test.ts", "src/**/*.test.tsx"],
});
const offenders = [];
const banned = [/\bconst\s+HOUR_PX\s*=/, /\bconst\s+DAY_PX\s*=/, /\bconst\s+MIN_BLOCK_PX\s*=/];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const re of banned) {
    if (re.test(src)) offenders.push(`${f}: ${re}`);
  }
}
if (offenders.length) {
  console.error("timeline-axis-ssot: pixel constants must live only in src/lib/timelineAxis.ts");
  for (const o of offenders) console.error("  " + o);
  process.exit(1);
}
console.log("timeline-axis-ssot: ok");
```

(If `globSync` import shape differs in the repo's Node version, mirror exactly how `scripts/check-design-tokens.mjs` enumerates files — read that script first and copy its file-walking helper.)

- [ ] **Step 2: Run it — expect pass on the migrated tree**

Run: `node scripts/check-timeline-axis-ssot.mjs`
Expected: `timeline-axis-ssot: ok` (all locals were removed in Tasks 2-6).

- [ ] **Step 3: Plant a violation, confirm it fails, revert**

Temporarily add `const HOUR_PX = 60;` to `src/lib/timelineLayout.ts`, run the script, confirm exit 1 + the offender is listed, then remove the planted line.

Run: `node scripts/check-timeline-axis-ssot.mjs; echo "exit=$?"`
Expected: prints the offender, `exit=1`. After revert: `timeline-axis-ssot: ok`.

- [ ] **Step 4: Wire into package.json**

Read `package.json`, find the `check:design-tokens` script and the aggregate that runs it (the husky/lint chain). Add:

```json
"check:timeline-axis": "node scripts/check-timeline-axis-ssot.mjs"
```

and append `&& pnpm check:timeline-axis` to the same aggregate that runs `check:design-tokens` (match the existing pattern exactly).

- [ ] **Step 5: Run the full Phase-1 gate**

Run: `pnpm typecheck && pnpm lint && pnpm vitest run && pnpm check:timeline-axis`
Expected: all PASS, 0 type errors, `bindings.ts` drift 0 (no Rust touched).

- [ ] **Step 6: Commit**

```bash
git add scripts/check-timeline-axis-ssot.mjs package.json
git commit -m "test(today): guard banning duplicate timeline pixel constants (H1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Phase 1 Done-Criteria (verify with evidence, not prose)

- [ ] `src/lib/timelineAxis.ts` is the only file defining `HOUR_PX`/`DAY_PX`/`MIN_BLOCK_PX` (guard green).
- [ ] `pnpm vitest run` fully green (existing suites unchanged + new `timelineAxis.test.ts`).
- [ ] `pnpm typecheck` 0 errors; `pnpm lint` 0 new errors; `bindings.ts` drift 0.
- [ ] Zero behavior change confirmed by the unchanged existing suites passing.
- [ ] Live native WKWebView smoke (drag a block, resize a 15-min block, scroll) — user/cmux (agent cannot run native WKWebView).

---

## Phases 2–5 Roadmap (each gets its own spec-aligned plan when reached)

These are sequential and depend on Phase 1's concrete output, so they are planned in detail at their own execution time (matching this repo's per-phase pattern, e.g. the DnD-overhaul phase plans). Summary from the spec §4:

- **Phase 2 — Canonical time (`TimelineLocalIso` + normalizer).** Branded type; `TimedBlock.startISO/endISO` adopt it. Normalize in `todayBlocks` first (TS), then move Google normalization to the Rust boundary (`fetch_calendar_events` → timeline zone; `windows.rs` same zone; additive `CalendarEvent` fields → migrate Drawer/urgency → retire raw). Guard H4 (multi-offset inputs → same zone; ban `new Date(iso).getHours()`). **Touches Rust + `bindings.ts`.**
- **Phase 3 — Labels/durations via datetime helpers.** Remove `new Date(iso).getHours()` from `TimelineBlock.hhmm`/duration and `nowOffsetPx`. **Kills bug A (calendar misalignment).**
- **Phase 4 — `planTimelineDrag` single planner.** `{ previewBoxes, guide, commit }`; `useTimelineDnd` consumes `commit` only; ban direct `shift`/`resizeIsoByPx` outside the planner (guard H3). **Kills preview≠commit drift.**
- **Phase 5 — `LayoutBox` semantic/visual/hit split.** Resize handles hit-test on `hit` geometry; floor/clamp live in `visual` only (guard H2). **Kills drag-handle-vs-math divergence.**
