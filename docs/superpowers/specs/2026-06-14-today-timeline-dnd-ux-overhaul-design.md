# Today × Timeline — DnD / Time-block UX Overhaul (Design)

- **Date**: 2026-06-14
- **Area**: `docs/areas/today-timeline.md` (frontend), `docs/areas/frontend-board.md` (drag classification)
- **Status**: Design — awaiting user review before plan
- **Scope decisions (user, 2026-06-14)**: full overhaul (Phases 0–4) · routine length = **message-only**
  (no migration) · snapping = **modifier + magnetic** · **desktop-only** (touch deferred)

## 1. Problem

The Today timeline lets users place/move/resize cards (signal / event / routine) on a continuous
absolute-minute axis (60px/hour, 15-min snap). Two independent read-only reviews (Claude architect +
codex, 2026-06-14) found a confirmed hit-target bug and a set of UX gaps versus best-in-class calendar
tools (Google Calendar, Notion, Sunsama).

### 1.1 The reported bug — bottom resize handle requires the cursor _below_ it

**Confirmed root causes (both reviewers, with file:line evidence):**

1. **Adjacent-block boundary hit-test conflict (PRIMARY).** Each block is a `.tl-block-wrap` positioned
   absolutely with inline `zIndex: dragging ? 10 : 2` and no `overflow`
   (`src/components/today/timelineBlockStyle.ts:30-41`) — every non-dragging wrap is its own stacking
   context at the **same** z-index (2). A handle's `z-index:3` (`src/components/TodayView.css:719`) only
   orders it _within its own wrap_; it does not lift it above a _sibling_ wrap. Blocks render
   start-time ascending (`src/lib/timelineLayout.ts:65`, `src/components/today/TimelineCanvas.tsx:202`),
   so the **lower** block paints **after** (on top of) the upper one. The upper block's bottom handle
   (`bottom:0`, 3–8px) and the lower block's top handle (`top:0`) share the boundary row; at equal
   z-index, **paint/DOM order wins the pointer**, so the neighbor steals the bottom-handle hits.
   Adjacent blocks where `end === nextStart` are not even treated as overlapping
   (`src/lib/timelineLayout.ts:83`), so they abut exactly.
2. **3px hitbox on short blocks (compounding).** `resizeHandleHeightPx` floors at **3px**
   (`src/components/today/timelineBlockStyle.ts:9-11`) — below usable mouse precision, and it exactly
   equals the `PointerSensor` activation `distance: 3` (`src/components/today/useTimelineDnd.ts:653`),
   so a near-miss reads as "the handle didn't grab."
3. **`scale(1.02)` on `:active` (contributing).** `.tl-block:active { transform: scale(1.02) }`
   (`src/components/TodayView.css:596-600`) shifts block geometry the instant you press, while the
   sibling handles do not scale — degrading precision at the boundary during the pending-drag phase.

**Adjudicated disagreement:** Claude called the grip-line "drawn above the hitbox" a primary cause;
codex refuted it and is geometrically correct — the grip `::after` is `top:50%` + `translate(-50%,-50%)`,
i.e. _centered_ in the band, with `pointer-events:none` (`src/components/TodayView.css:744-757`). It is
not offset. The agreed fix resolves the symptom regardless of this point.

**Refuted (both):** canvas overlays (all `pointer-events:none`), and `distance:3` as a _standalone_
cause (it only delays activation; relevant only via the small hitbox).

### 1.2 UX gaps (ranked, from the reviews)

- **P1** No conflict/overlap feedback during a move — overlapping blocks silently re-column; commit never
  signals a busy slot (`src/components/today/timelinePreview.ts`, `useTimelineDnd.ts:476-547`).
- **P1** Canvas drag released _outside_ the grid still commits as a move/resize — `normalizeDropDataForDragEnd`
  converts `over=null` to `{to:"canvas"}` (`src/components/today/useTimelineDnd.ts:150-160, 475`).
- **P1** Snapping is 15-min only; no fine modifier, no magnetic edge-snap (`src/lib/timelineCoords.ts:8-13`).
- **P1** Routine resize is offered but silently snaps back — `routine_checks` has no per-day duration column,
  so the dispatcher deliberately does not optimistic-patch `durationMin`
  (`src/components/today/useTimelineDnd.ts:425-430`) while still staging a `routineResize`.
- **P1** Keyboard move/resize is below best-in-class (documented v2 gap — `docs/areas/today-timeline.md`
  "v2 follow-ups", `docs/adr/0004-dnd-kit-adoption.md`).
- **P2** Stage-IPC failures are mostly silent snap-backs; only cross-calendar shows a toast
  (`src/components/today/useTimelineDnd.ts:360, 462, 536, 604`).
- **P2** Routine midnight-clamp asymmetry (routines clamp to occurrence date; signals/events cross midnight)
  is invisible — a routine near midnight silently sticks (`useTimelineDnd.ts:388-401, 478-487`).
- **P2** Resize has no duration/end-time pill; the preview card is hidden for `canvas`/`canvas-resize`
  (`src/components/today/TimelineCanvas.tsx:218, 254`).
- **P2** A redundant DragOverlay ghost follows the raw cursor during canvas moves while the snapped preview
  is authoritative — two representations can read as lag (`src/components/today/TodayView.tsx:375-377`).
- **P3** Touch affordance weak (desktop-only by current design — **out of scope** per user decision).

## 2. Goals / Non-goals

**Goals**: (a) make grabbing both resize handles reliable on every block height and at adjacent
boundaries; (b) raise move/placement/resize _feel_ to calendar-grade; (c) richer snapping; (d) usable
keyboard/a11y; (e) consistent failure/edge UX. Every change must improve code health and stay the
smallest local change that achieves the phase's done-criteria.

**Non-goals (this overhaul)**: touch-specific interaction; per-day routine duration persistence (no
migration — routine length stays definition-driven, surfaced via message); `createBlank` draw-to-create;
per-calendar drop bands; week grid. These remain documented v2 items.

## 3. Architecture decision — handle reliability (Approach A)

Chosen: **A — enlarged hitbox + seam de-confliction + hover/focus z-lift**. Rejected: **B** (dedicated
top-most handle overlay layer) — strongest but a larger refactor that re-plumbs `useDraggable` ids/data
out of `TimelineBlock` and must keep geometry synced with previews; reserved as a fallback only if A
proves insufficient in live smoke. Rationale: A resolves every _confirmed_ cause with a near-CSS-only
diff, honoring the repo "가장 작은 변경" invariant.

### 3.1 Occlusion geometry (precise) — what actually contends

Overlapping blocks are placed in **separate columns** by `computeLayout` (different `leftPct`/`widthPct`,
`src/lib/timelineLayout.ts`), so they sit side-by-side and their vertical resize bands do **not** cover
each other. Vertical contention therefore happens **only** between same-column **abutting** blocks
(`end === nextStart`, not treated as overlapping — `src/lib/timelineLayout.ts:83`), and only at the
**single shared boundary row**. The handle _band_ itself (the bottom ~8px inside block A) is **not**
occluded by neighbor B (B lives below A's bottom edge); only the 1px seam is contested, plus any
sub-pixel/`scale(1.02)` bleed. This is why the past-border `bottom:-4px` extension considered earlier is
**rejected** — extending A's hitbox _into_ B would steal B's top-edge pointer (a reverse conflict).

### 3.2 Approach A, concretely

**Real-height grounding (critic-corrected):** `computeLayout` floors every block to `MIN_BLOCK_PX = 20`
(`src/lib/timelineLayout.ts:50,125`), so the **smallest block any code sees is 20px** (a 15-min block).
"15px blocks" do not exist; all geometry below is stated in real, producible heights.

- **Enlarge the hitbox, decoupled from the visual grip — but only _inward_** (never past the block's own
  border, which would steal the abutting neighbor's pointer). Raise the `resizeHandleHeightPx` floor from
  3 → **8px**; the grip `::after` stays centered in the (now larger) band.
- **Short blocks (`20px ≤ heightPx < 28px`) render a single bottom handle (8px), whole body = move.** Two
  8px handles (16px) on a 20px block leave only a 4px move band — too small to grab. The 28px threshold
  guarantees a ≥12px move band whenever both handles render (28 − 16). In the single-handle range the
  handle is a flat **8px** (no shrink formula — a cap keyed to sub-20px heights would be inert since
  nothing below 20px exists). `TimelineBlock` conditionally renders only the `edge="bottom"` `ResizeHandle`
  below the threshold; the `block:<id>` body draggable is unaffected. **Top-edge adjustment for these
  blocks is intentionally deferred to keyboard (Phase 3)** — see the Phase 0 done-criteria note and §4
  capability-gap decision.
- **Threshold independence:** the new 28px 1-vs-2-handle threshold is _separate_ from the existing visual
  bands `compact < 36` / `ultra < 22` (`src/components/today/TimelineBlock.tsx:185-186`). It is purely the
  "two handles + a usable move band don't fit" boundary — do **not** fold it into `ultraCompact`.
- **Seam de-confliction:** inset the top handle down 1px and the bottom handle up 1px from the exact
  boundary row, drawing the visual edge separately, so abutting blocks never share the contested row.
- **Hover/focus z-lift:** move the base wrap z-index out of the inline style into CSS
  (`.tl-block-wrap { z-index: 2 }`) and the dragging lift into the existing `[data-dragging]` rule
  (`src/components/TodayView.css:557`), so `.tl-block-wrap:hover, .tl-block-wrap:focus-within
{ z-index: 6 }` can win (inline style otherwise beats a stylesheet rule). The band itself is not occluded
  (§3.1), so the lift is **not** the primary fix — it hardens the 1px seam and any `scale(1.02)` sub-pixel
  bleed.
  - **⚠ Coupling (must ship together):** the z-lift and the 1px seam inset are **interdependent**. A
    hovered upper block A lifts to `z-6` and its _body_ then paints over the abutting lower block B's top
    edge at the seam; this is safe **only because** the 1px inset has moved B's top handle off that row.
    Shipping the lift without the inset (or vice-versa) reintroduces a reverse-occlusion. Phase 0 lands
    both in one PR; never split them.
- **Neutralize the press shift:** prefer **shadow-only** press feedback (drop the geometric `scale(1.02)`
  at `src/components/TodayView.css:596-600`). `transform-origin: top center` still grows the bottom edge
  downward (~0.4px on a 20px block) — a half-fix; shadow-only fully eliminates the contributing cause
  named in §1.1.3.

## 4. Phased plan

Each phase = one concern = one PR (repo convention). Phases 0–1 are the high-value core.

### Phase 0 — Handle reliability (the bug)

- **Changes**: Approach A (§3.2). Files: `src/components/TodayView.css` (move base z-index into CSS +
  `[data-dragging]` + `:hover/:focus-within` lift; 1px seam inset on top/bottom handles; `:active`
  transform-origin), `src/components/today/timelineBlockStyle.ts` (floor 3→8; **add the 1-handle-vs-2-handle
  height threshold** at ~28px and the ultra-short cap `min(floor(h*0.4), 8)`; keep `--tl-resize-h`
  injection; drop the inline base z-index), `src/components/today/TimelineBlock.tsx` (conditionally render
  only the bottom `ResizeHandle` when below threshold; whole body stays the move draggable).
- **Tests**: the existing `resizeHandleHeightPx` assertions (`TimelineBlock.test.ts:50-68`: `20→3, 30→5,
36→8, clamp [3,8]`) **will fail and must be rewritten, not extended** — the floor and semantics change
  (`30` was 5, becomes 8). New rows in _real_ heights: `36→8`, `60→8`, `28→8` (2-handle boundary), `27→8`
  single-handle, `20→8` single-handle; assert **no top `ResizeHandle` renders for `heightPx < 28`**; assert
  the bottom handle's offset never goes negative (8px handle + 1px inset = 9px ≤ 20px body).
- **§4 capability-gap decision (top-edge resize on `20–27px` blocks):** removing the top handle leaves
  these blocks with **no mouse top-edge resize** until Phase 3's keyboard support lands (separate PR).
  **Decision: accept and document** — a 15–20-min block is fully movable (body) and bottom-resizable, and
  start-time is still adjustable by _moving_ the block; direct top-edge mouse-resize on a sub-28px block is
  a rare need and matches GCal (tiny events resist top-resize). This is the one product tradeoff flagged
  for the user at the review gate; if rejected, the fallback is to keep both handles at 6px for `20–27px`
  (smaller move band) instead of single-bottom.
- **Done-criteria**: unit tests green; `pnpm typecheck` + `pnpm lint` clean; **live grab-smoke (user/cmux)**
  — (a) grabbing the visible grip pixel of a block stacked directly above another initiates a _resize_ of
  the upper block, not a move of the lower; (b) a 15-min (20px) block is movable by its body and resizable
  by its single bottom handle; (c) grabbing near the top edge of the _lower_ abutting block does not trigger
  the upper block's resize (no reverse conflict).

### Phase 1 — Drag/resize feel

- **Overlap-conflict tint**: derive a "would overlap" boolean from `computeLayout` cluster size and apply a
  preview-only class (`src/components/today/timelinePreview.ts`, `TimelineCanvas.tsx`, CSS). Pure-CSS +
  small render; no commit blocking (last-write-wins stays, per area doc — only _feedback_ is added).
- **Duration pill**: floating `HH:MM–HH:MM · 1h15m` on the active edge during resize, and start-time during
  move (`TimelineCanvas.tsx:218-268`). Render + CSS.
- **Suppress redundant ghost**: render no `DragOverlay` ghost for `from:"canvas"`/`"canvas-resize"` (preview
  is authoritative); keep it for tray/routine (`TodayView.tsx:375-377`). Dispatcher/TodayView.
- **Outside-grid release**: distinguish "lost droppable mid-drag" from "released outside the grid" in
  `normalizeDropDataForDragEnd` / `onDragEnd` (`useTimelineDnd.ts:150-160, 475`); snap back (no commit) +
  toast when truly outside. **Note:** the current fallback maps a lost droppable to `{to:"canvas",
gridY:0}` (commits to the _top_ of the grid) and the pure `normalizeDropDataForDragEnd` does **not**
  receive the release pointer — Phase 1 must thread the pointer-at-release (from `pointerClientRef` + fresh
  grid rect, already available in `onDragEnd`) into the decision so "over grid → re-resolve from pointer"
  vs "off grid → snap back" can be told apart. Dispatcher; **needs-tests** (extend `useTimelineDnd.test.ts`).
- **Done-criteria**: vitest green incl. new drop-normalization cases; typecheck/lint clean; live smoke
  (overlap tint visible; pill tracks the edge; no double-ghost; drag off-grid snaps back) = user/cmux.

### Phase 2 — Snapping model

- Parameterize `snap` in `src/lib/timelineCoords.ts` (keep default 15); add **Alt/Option = 5-min** fine snap
  read from `ev.activatorEvent`/pointer event in the dispatcher; add **magnetic edge-snap** to adjacent
  block start/end within ~6px (compute candidate edges from the rendered boxes; nearest wins over grid
  snap). Touches `timelineCoords.ts`, `timelinePreview.ts`, `useTimelineDnd.ts`.
- **Tests**: snap-priority (magnetic > grid within threshold), cross-midnight parity, routine-clamp parity
  (`src/lib/timelineCoords.test.ts`, `timelinePreview.test.ts`).
- **Done-criteria**: vitest green; typecheck/lint clean; live feel-smoke = user/cmux.

### Phase 3 — Keyboard / a11y (closes documented v2 gap)

- Custom `coordinateGetter` for 15-min keyboard steps (Shift = 1h); visible focus ring on handles +
  `aria-keyshortcuts`; live-region announcing the new time on move/resize. Touches `TimelineBlock.tsx`,
  `useTimelineDnd.ts`, CSS. Update `docs/areas/today-timeline.md` to retire the v2 keyboard items.
- **Tests**: keyboard step math + announcement wiring where unit-testable.
- **Done-criteria**: keyboard-only move + resize works (Tab→block→Space→arrows→Space, Esc cancels); vitest
  green; typecheck/lint clean; a11y smoke = user/cmux.

### Phase 4 — Failure & edge UX

- Unify **all** stage-IPC failures → toast + rollback (schedule/reschedule/resize/moveCalendar/
  routineSchedule), matching the existing cross-calendar path (`useTimelineDnd.ts:360-639`).
- Routine **midnight-clamp affordance**: cursor/tick cue (or boundary stop indicator) before the silent
  stick (`useTimelineDnd.ts:388-401, 478-487`).
- Routine **fixed-length tooltip** (message-only decision): on routine resize, surface "루틴 길이는 정의로
  고정" rather than silently snapping back (`useTimelineDnd.ts:425-430`).
- **Tests**: failure-path rollback assertions in `useTimelineDnd.test.ts`.
- **Done-criteria**: vitest green; typecheck/lint clean; live failure-injection smoke = user/cmux.

## 5. Risks / invariants

- **No new IPC types by hand** — none of these phases add IPC; if any does, regenerate `src/bindings.ts`
  via `cargo test` (tauri-specta), never hand-edit (AGENTS.md invariant).
- **No schema change** — routine model stays message-only; no migration (honors migrations-only invariant
  and the user decision).
- **Design tokens** — all new CSS uses existing Tailwind `@theme` / motion tokens / `var(--…)`; no raw hex.
  NB: the design-tokens lint gate is **TSX-only** (CSS hex is caught by build, not the token gate), so
  reviewers must eyeball new CSS for literal colors — though all color here comes from existing vars, so
  this is moot in practice. Marketing components untouched.
- **Self-approve forbidden** — each phase verified by a separate reviewer/critic pass (codex or
  `oh-my-claudecode:critic`), not the author context.
- **Live GUI smoke cannot be run by the agent** (native WKWebView) — every phase's live done-criterion is
  explicitly user/cmux, never claimed as "passed" by the agent.
- **Push policy** — push to `dev` only on explicit user request; `main` is PR-only.

## 6. Verification index

- Front: `pnpm typecheck` · `pnpm lint` · `pnpm vitest run timelineLayout todayBlocks optimisticSchedule
timelineCoords timelinePreview` · targeted `pnpm vitest run useTimelineDnd TimelineBlock`.
- Full command index: `docs/reference/commands.md` (canonical — not duplicated here).
- Per-phase live smoke: user/cmux on a populated Today timeline.

## 7. Open questions

- Phase 3 announcement copy (Korean strings) — confirm wording during implementation.
- Magnetic-snap threshold (~6px) and whether it also snaps to the now-line / work-hours boundaries —
  tune during Phase 2 live smoke.
