# Today Timeline — Coordinate & Time SSOT (Architecture Redesign)

- **Date**: 2026-06-20
- **Status**: design (approved to draft; pending user spec-review)
- **Area**: Today × Timeline (`docs/areas/today-timeline.md`, row 14)
- **Diagnosed by**: Claude + Codex (independent passes, converged)
- **Scope decision (user)**: full unification
- **Time representation decision (user)**: branded local-offset ISO
- **Normalization boundary decision (user)**: Rust command boundary

## 1. Problem

Two classes of bug recur on the Today timeline no matter how many point-fixes land:

- **(A) Calendar ↔ schedule misalignment** — a Google calendar event renders at a different vertical position / wrong wall-clock than the user's own schedule blocks.
- **(B) Drag-handle misfire** — grabbing a block or resize handle hits the wrong Y or the wrong (adjacent) block; the drag preview lands somewhere other than where it was shown.

History: ≥5 sequential drag fixes (`165cc81`, `b3db2ce`, `b0eccf9`, `d9bd867`, `f7f0e4a`) + a 5-phase DnD overhaul + a routine-dedup rewrite have all failed to stop recurrence. Per systematic-debugging Phase 4.5, 3+ failed fixes ⇒ the architecture is wrong, not the individual fixes.

## 2. Root-cause diagnosis (both models, with file:line evidence)

**Meta-thesis: the timeline has no single source of truth for either of its two fundamental mappings, and maintains multiple parallel implementations kept in sync by hand and by comment.**

### Mapping 1 — time ↔ pixel (causes bug B)

- `HOUR_PX = 60` copy-defined in **5** places: `src/lib/timelineLayout.ts:49`, `src/lib/timelineCoords.ts:8`, `src/components/today/useTimelineDnd.ts:52`, `src/components/today/TimelineCanvas.tsx:19`, plus `DAY_PX = 24*60` in `src/components/today/useTimelineScroll.ts:8-9`.
- client→grid conversion reimplemented inline 3+ times with no shared fn: `TimelineCanvas.tsx:176-183`, `timelinePreview.ts:30-38` (`clientPointToGridGuide`), `useTimelineDnd.ts:334-341` (`resolveCanvasGridY`).
- **Render geometry ≠ interaction geometry**: `computeLayout` floors `heightPx` to `MIN_BLOCK_PX=20` (`timelineLayout.ts:124-125`) and clamps it to the next overlapping block's top (`timelineLayout.ts:133-154`); but resize data uses semantic duration from raw ISO diff (`TimelineBlock.tsx:96-99` → `timelineDragData.ts:66-109`) and commit math uses `start + durationMin + deltaPx` (`timelineCoords.ts:75-108`, called `useTimelineDnd.ts:491-501`). The visible handle edge represents `heightPx`, while the operation math treats that edge as `start + durationMin`.
- **Preview ≠ guide ≠ commit**: `previewTimelineBoxes` (`timelinePreview.ts:143-215`) and the commit (`useTimelineDnd.ts:491-579`/`594-667`) duplicate operation rules (routine-backed detection, occurrence clamp, duration correction). The guide derives occurrence day from **pixels** (`Math.floor(activeBox.topPx/1440)*1440`, `timelinePreview.ts:106-124`) while preview/commit derive it from the **ISO string** (`localDateOf(...)`, `timelinePreview.ts:176-185`, `useTimelineDnd.ts:502-515/604-613`). The codebase is littered with "commit과 동일해야" comments — two implementations re-synchronized by hand.

### Mapping 2 — instant ↔ local-wall-clock ISO (causes bug A)

- `absMin()` positions blocks by **string-slicing wall-clock digits**, ignoring offset: `src/lib/timeAxis.ts:33-37` (`iso.slice(11,13)`/`(14,16)`). Correct only if every source already shares the viewer's local offset.
- Google event times carried through **raw** (no conversion): `src-tauri/src/calendar/parse.rs:63-79`; `CalendarEvent.start/end` raw RFC3339/date (`src-tauri/src/models/calendar.rs:40-54`, `src/bindings.ts:1338-1349`); copied raw in `src-tauri/src/calendar/mod.rs:197-206`.
- **Three offset conventions coexist**: signals carry an offset (`placement.startAt`, `todayBlocks.ts:162-169`); Google events carry Google's offset; routines carry **no offset** (`isoFor()`, `todayBlocks.ts:115-127`).
- Rust query window uses the Rust process offset (`src-tauri/src/calendar/windows.rs:21-24`, called `commands/calendar.rs:570-572/590-592`) — an independent source from the browser.
- **Bonus defect (found independently by both models)**: even within one block, position and label/duration use different time methods. Label: `new Date(iso).getHours()` (`TimelineBlock.tsx:36-39`); duration: instant diff (`TimelineBlock.tsx:96-99`); position: `absMin` string-slice. A raw Google `+00:00` event is laid out at wall-clock `05:00` but labeled local `14:00` (KST) — the literal "calendar misaligned" symptom.

### Why it recurs

Every prior fix re-synchronized **one pair** of these parallel paths (a "must match commit" comment, a new clamp, a `will-change` removal). None collapsed the parallelism, so the next data/path change manufactures a new divergence.

## 3. Target architecture

### 3.1 `src/lib/timelineAxis.ts` — the one coordinate authority (time↔pixel)

Absorbs the 5 `HOUR_PX`/`DAY_PX` copies and the 3+ inline client→grid conversions.

```ts
createTimelineAxis({ anchorDate, days, hourPx = 60, snapMin = 15 }) → {
  HOUR_PX, DAY_PX, totalPx,
  timeToY(iso): number,                 // the single absMin→px formula
  yToTime(y, opts): TimelineLocalIso,
  clientToGrid(point, rect): { x, y },  // label gutter 60 + clamp, single definition
  snap(absMin, opts),
  shift({ start, deltaPx, snap }),
  resize({ start, durationMin, edge, deltaPx, snap }),
  layout(blocks): LayoutBox[],          // computeLayout folds in here
}
```

All consumers (`TimelineCanvas` render, `computeLayout`, `useTimelineDnd`, `timelinePreview`, `useTimelinePointerDelta`, `useTimelineScroll`, `nowOffsetPx`) import from here. Zero local `HOUR_PX`.

### 3.2 Canonical time — branded `TimelineLocalIso` + Rust-boundary normalization (instant↔ISO)

- Branded type `TimelineLocalIso` = `YYYY-MM-DDTHH:MM:SS±HH:MM`, always the timeline zone. `TimedBlock.startISO/endISO` typed as this ⇒ raw strings cannot compile in.
- **Single normalization chokepoint at the Rust command boundary**: `fetch_calendar_events` converts Google `dateTime` (any offset / `Z`) into the timeline-zone local-offset ISO before emitting `CalendarEvent`. `windows.rs` query window uses the same timeline zone (retire ad-hoc `chrono::Local::now().offset()` capture). DST: IANA-zone-aware conversion, not bare offset strings.
- Routines materialize via the axis/datetime helper (retire `isoFor()`'s no-offset strings). Signals/placements normalized once before `TimedBlock`.
- Ban `new Date(iso).getHours()` and ad-hoc `slice(11,16)` outside the timeline datetime helpers; labels/durations/position all use the same helpers, so they cannot disagree.

### 3.3 `planTimelineDrag` — preview == commit by construction

```ts
planTimelineDrag({ axis, boxes, activeDrag, delta, pointer, snapOpts })
  → { previewBoxes, guide, commit }
```

Owns all operation rules once (routine-backed detection, occurrence clamp, duration correction, snap, off-grid classification). `TimelineCanvas` renders `previewBoxes`+`guide`; `useTimelineDnd` stages `commit` only and must not recompute start/duration. Direct `shiftIsoByPx`/`resizeIsoByPx` calls in `useTimelineDnd` are removed.

### 3.4 `LayoutBox` split — semantic / visual / hit

```ts
LayoutBox = {
  id,
  block,
  semantic: { startAbs, endAbs, durationMin }, // truth (time)
  visual: { topPx, heightPx, leftPct, widthPct }, // drawn; MIN_BLOCK_PX floor + overlap clamp live here only
  hit: { topHandle, bottomHandle, moveBand }, // hit rects derived from semantic geometry
};
```

Resize handles hit-test against `hit`, never the floored wrapper height ⇒ the "visible edge = heightPx but math = start+duration" split disappears. Adjacent same-column hit rects are guaranteed non-overlapping in the `hit` derivation (structural Bug-4 fix).

### 3.5 Structural guards (recurrence becomes impossible, not just fixed once)

- **H1**: property test `yToTime(timeToY(t)) === snap(t)`; lint/grep ban on local pixel constants outside `timelineAxis`.
- **H2**: test every `LayoutBox.hit` handle equals the edge `planTimelineDrag` uses; no adjacent hit overlap.
- **H3**: `useTimelineDnd` accepts only `plan.commit`; lint ban on `shift`/`resizeIsoByPx` outside the planner.
- **H4**: tests that Google `Z`, `-07:00`, `+09:00`, no-offset routine, and placement inputs all yield the same `TimelineLocalIso` zone before layout; lint ban on `new Date(iso).getHours()` and ad-hoc slice outside helpers.

## 4. Phasing (lowest-risk first, each shippable)

1. **Axis SSOT (pure refactor, behavior 0)** — `timelineAxis` constants + conversion helpers; replace all duplicate `HOUR_PX`/`DAY_PX` + client→grid math.
2. **Canonical time** — branded `TimelineLocalIso` + normalizer; `TimedBlock` adopts it. Normalize in `todayBlocks` first (TS), then move Google normalization to the Rust boundary (add normalized `CalendarEvent` fields → migrate Drawer/urgency consumers → retire raw).
3. **Labels/durations via datetime helpers** — remove `new Date(iso).getHours()` from timeline rendering. **→ kills bug A.**
4. **`planTimelineDrag`** — wire preview first, then point commit at the same plan output. **→ kills preview≠commit drift.**
5. **LayoutBox semantic/visual/hit split** — resize handles use hit geometry. **→ kills handle-vs-math divergence.**

Guards/tests land alongside each phase.

## 5. Invariant / ADR alignment

- INVARIANT #7 (local-ISO only, no `toISOString`): preserved and _enforced_ (branded type + lint), not just convention.
- ADR-0002 (card-as-truth, Google = mirror): normalization affects display/positioning only; card SSOT values unchanged.
- ADR-0004 (@dnd-kit confined to `today/**`): unchanged.
- IPC / data-layer / "external calls in Rust" invariants: boundary normalization keeps Google time handling in Rust.

## 6. Risks / open items

- `CalendarEvent.start/end` semantic change affects Drawer/urgency callers → phase via additive normalized fields, migrate, then retire raw.
- DST / range windows need IANA-zone handling, not bare offset strings.
- New `hit` geometry × dnd-kit interaction requires native WKWebView live smoke (agent cannot run; user/cmux).

## 7. Verification

- `pnpm vitest run timelineLayout todayBlocks optimisticSchedule timelineCoords timelinePreview timeAxis` + new `timelineAxis` / `planTimelineDrag` suites.
- `pnpm typecheck` (branded type enforcement), `pnpm lint` (new structural-guard rules), `bindings.ts` drift (CalendarEvent field changes).
- Rust: `cargo test calendar::sync calendar::pending_store` + new normalization tests; `cargo clippy -D warnings`.
- Live: native `pnpm tauri dev` smoke for drag-handle + calendar alignment (user/cmux).
