# Timeline Sync — Cache-Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the timeline→inbox unschedule orphan (a scheduled card dragged back to the inbox leaves a stale Google-mirror block in the timeline) and remove the bug _class_ by centralizing optimistic cache reconciliation behind one commit-driven reconciler.

**Architecture:** See spec `docs/superpowers/specs/2026-06-23-timeline-sync-cache-reconciliation-design.md` (consensus Codex+Claude). The timeline is a derived view over 3 layers (card truth / Google-mirror cache / Google server). Unschedule updates the card + server layers but forgets the mirror cache; `buildTodayBlocks` then renders the un-absorbed mirror as an orphan. Fix the cache layer, not the view.

**Tech Stack:** React, @tanstack/react-query, TypeScript, Vitest. Frontend-only — **no Rust / IPC / `bindings.ts` / schema changes** (the Rust unschedule queue is already correct).

## Global Constraints

- **Frontend-only.** Do NOT touch `src-tauri/**`, `src/bindings.ts`, capabilities, or the IPC/stage contract. Signal `unschedule` keeps sending only `{ targetSignalId, fromDate }`; `linkedEventId` is needed **only** client-side.
- **@dnd-kit** stays in `src/components/today/**` (do not add @dnd-kit imports to `src/lib`). The pure reconciler lives in `src/lib` and must not import @dnd-kit.
- **INVARIANT #7:** local-offset ISO; time math via timeAxis string ops (no `toISOString()`/`new Date().getHours()` in positioning). The reconciler does cache mutation only — no time math (consume `commit.at`/`durationMin` as-is).
- **Behavior parity except the fix:** schedule/reschedule/resize/moveCalendar/routine paths unchanged; only unschedule gains mirror removal + the scattered patches get consolidated. `useTimelineDnd.test.ts` (stage payloads) + `timelineDragPlan.test.ts` are the parity net and must stay green.
- **Event cache removal must hit ALL buckets:** use `setQueriesData({ queryKey: ["calendarEvents"] })` (prefix) — covers per-date `["calendarEvents", date]` AND range `["calendarEvents","range",s,e]` (`src/lib/query/calendar.ts:33,164`). Never a single-date key.
- **Verification:** `pnpm typecheck` 0, `pnpm lint` 0, `pnpm vitest run` green, `bindings.ts` drift 0. Live native WKWebView smoke (drag scheduled card → inbox → no leftover block) = user.
- **Commits:** Conventional Commits; body ends `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Do NOT push unless asked. Stage only each task's files; NEVER `src-tauri/src/lib.rs` (unrelated WIP).

## File Structure

- **Modify** `src/components/today/timelineDragData.ts` — signal `DragData` carries `linkedEventId`.
- **Modify** `src/components/today/useTimelineDnd.ts` — `DragData` type gains `linkedEventId?`; unschedule branch removes mirror from event cache + invalidates on catch.
- **Modify** `src/lib/timelineDragPlan.ts` — `unschedule` `TimelineCommit` carries `calendarId?` + `linkedEventId?` (copied from `activeDrag`).
- **Create** `src/lib/timelineEventCache.ts` — pure `removeEventFromBuckets(events, calendarId, eventId)` (+ later the reconciler) so cache logic is unit-testable.
- **Create** `src/lib/applyTimelineCommitToCaches.ts` (Task 2) — the commit-driven reconciler.
- **Tests:** `timelineDragData.test.ts`, `timelineDragPlan.test.ts` (extend), `timelineEventCache.test.ts`, `applyTimelineCommitToCaches.test.ts`.

---

## Task 1: Immediate unschedule orphan fix (user-visible)

**Files:** Modify `timelineDragData.ts`, `useTimelineDnd.ts`, `timelineDragPlan.ts`; Create `src/lib/timelineEventCache.ts` + `timelineEventCache.test.ts`; extend `timelineDragData.test.ts` + `timelineDragPlan.test.ts`.

**Interfaces — Produces:**

- `DragData.linkedEventId?: string` (signal blocks now carry it).
- `TimelineCommit` `unschedule` variant: `{ kind: "unschedule"; targetSignalId: string; fromDate: string; calendarId?: string; linkedEventId?: string }`.
- `removeEventFromBuckets(events: CalendarEvent[], calendarId: string, eventId: string): CalendarEvent[]` (pure).

- [ ] **Step 1: Failing pure test** — `timelineEventCache.test.ts`: `removeEventFromBuckets` filters out the event matching `(calendarId, id)` and leaves others (incl. same id different calendar).
- [ ] **Step 2: Implement** `src/lib/timelineEventCache.ts`:

```ts
import type { CalendarEvent } from "@/bindings";
/** 미러 이벤트 1건을 버킷에서 제거(언스케줄 등). 같은 id·다른 캘린더는 보존. 순수. */
export function removeEventFromBuckets(
  events: CalendarEvent[],
  calendarId: string,
  eventId: string,
): CalendarEvent[] {
  return events.filter((e) => !(e.calendarId === calendarId && e.id === eventId));
}
```

- [ ] **Step 3: Run pure test → pass.** `pnpm vitest run src/lib/timelineEventCache.test.ts`.
- [ ] **Step 4: Plumb `linkedEventId` into signal drag data** — `timelineDragData.ts` signal branch (the final `return` ~line 50): add `linkedEventId: block.linkedEventId`. Add `linkedEventId?: string` to the `DragData` type in `useTimelineDnd.ts` (next to `eventId`). Extend `timelineDragData.test.ts`: a signal box with `block.linkedEventId` → `dragDataForBox(...).linkedEventId` equals it.
- [ ] **Step 5: Carry it on the commit** — `timelineDragPlan.ts`: extend the `unschedule` `TimelineCommit` type with `calendarId?`/`linkedEventId?`, and where it builds the unschedule commit, copy `activeDrag.calendarId` + `activeDrag.linkedEventId`. Extend `timelineDragPlan.test.ts`: unschedule of a linked signal → commit carries `calendarId`+`linkedEventId`; unlinked signal → both undefined.
- [ ] **Step 6: Remove mirror in the unschedule branch** — `useTimelineDnd.ts`: add a local closure

```ts
const removeEventFromCache = (calendarId: string, eventId: string) =>
  qc.setQueriesData<CalendarEvent[]>({ queryKey: ["calendarEvents"] }, (old) =>
    old ? removeEventFromBuckets(old, calendarId, eventId) : old,
  );
```

In the `c.kind === "unschedule"` branch (~632), BEFORE `patchSignalCaches(..., { clearLink: true })`, add:

```ts
if (c.calendarId && c.linkedEventId) removeEventFromCache(c.calendarId, c.linkedEventId);
```

and in that branch's `catch` (~666) add `invalidateEventCaches();` alongside `invalidateSignalCaches();`.

- [ ] **Step 7: Gates** — `pnpm typecheck` 0, `pnpm lint` 0, `pnpm vitest run src/lib src/components/today` green (existing suites unchanged).
- [ ] **Step 8: Commit** (`fix(today): remove Google mirror from event cache on drag-unschedule (orphan block)`).

**Done:** dragging a scheduled card to the inbox removes the placement AND the mirror event from the cache → no orphan block. Live smoke = user.

---

## Task 2: Extract `applyTimelineCommitToCaches` reconciler

**Files:** Create `src/lib/applyTimelineCommitToCaches.ts` + `applyTimelineCommitToCaches.test.ts`. Read `useTimelineDnd.ts` patch closures (`patchSignalCaches`/`patchPlacementCaches`/`patchEventCache`/`patchRoutineCache`/`removeEventFromCache`) — this task LIFTS their per-kind composition into one function; it does NOT yet rewire onDragEnd (Task 3).

**Interfaces — Produces:** `applyTimelineCommitToCaches(qc: QueryClient, commit: TimelineCommit): void` — performs the full layer-①+② optimistic update for each commit kind (signal/placement/event/routine caches), reproducing today's per-branch patches exactly. No @dnd-kit import; no time math (consume commit fields).

- [ ] **Step 1: Failing tests** — `applyTimelineCommitToCaches.test.ts` with a real `QueryClient`: seed caches, apply each commit kind, assert the resulting cache state (e.g. `unschedule` → signal link cleared + placement removed + mirror event gone from all buckets; `resize`/`eventResize` → event patched; `reschedule` signal → scheduledAt moved). Cover all 10 kinds.
- [ ] **Step 2: Implement** the reconciler: a `switch (commit.kind)` that calls the same cache transforms currently inlined in `useTimelineDnd` (move the pure transforms — `applySchedulePatch`/`applyPlacementPatch`/`removeEventFromBuckets`/event-patch/routine-patch — behind `qc.setQueriesData`/`setQueryData`). Keep behavior identical to the current branches.
- [ ] **Step 3: Run → pass.** `pnpm vitest run src/lib/applyTimelineCommitToCaches.test.ts`.
- [ ] **Step 4: Gates + Commit** (`feat(today): add applyTimelineCommitToCaches commit-driven cache reconciler`). Not wired yet — additive, all existing suites green.

---

## Task 3: Route onDragEnd (+ overlapping schedule actions) through the reconciler

**Files:** Modify `useTimelineDnd.ts` (and `useTimelineScheduleActions.ts` where it duplicates event-cache removal). Read both first.

- [ ] **Step 1: Baseline green** — `pnpm vitest run src/components/today`.
- [ ] **Step 2: Rewire** — in `onDragEnd`, after `if (!plan.commit) return;`, call `applyTimelineCommitToCaches(qc, plan.commit)` for the optimistic update, keeping ONLY the non-cache concerns inline in each branch (the `await stage(...)`, the calendar picker for schedule, the routine info/clamp toasts, the undo toast, and the `catch` rollback/`stageFailureToast`). Remove the now-duplicate inline cache-patch calls (`patchSignalCaches`/`patchPlacementCaches`/`patchEventCache`/`patchRoutineCache`/`removeEventFromCache`) that the reconciler now owns. Keep `invalidate*` rollback in catches.
- [ ] **Step 3: De-dup schedule actions** — `useTimelineScheduleActions.ts`: replace its bespoke `removeEventFromCache`/patches with the shared reconciler or the shared `removeEventFromBuckets` (single source).
- [ ] **Step 4: Gates** — `useTimelineDnd.test.ts` MUST pass unchanged (parity lock on stage payloads + resulting state); `pnpm typecheck`/`lint`/`vitest` green. Any failure ⇒ a kind's reconciler mapping diverged — fix the reconciler, not the test.
- [ ] **Step 5: Commit** (`refactor(today): route timeline commit cache updates through applyTimelineCommitToCaches`).

---

## Task 4 (follow-up, optional this run): Undo-path hardening

**Files:** `useTimelineDnd.ts` unschedule undo.

- [ ] The undo currently re-upserts the placement and stages a bare `reschedule` after the link was cleared. Capture `prevCalendarId` + `prevLinkedEventId` at unschedule time; on undo, restore them (signal cache + re-add the mirror event to cache) and stage a path that re-establishes the mirror (schedule/restore), so server `reschedule` doesn't hit `calendar.no_linked_event`. Add a test for the undo→restore cache state. Commit (`fix(today): restore mirror context on unschedule undo`).

---

## Out of scope (note, separate concern)

- `TodayView.tsx:3` imports `@dnd-kit/core` vs `today-timeline.md:26` boundary — pre-existing doc/architecture inconsistency; reconcile the area doc separately (not part of this fix).

## Done-Criteria (evidence)

- [ ] Drag scheduled card → inbox: placement removed AND no orphan mirror block remains (Task 1; live smoke = user).
- [ ] All optimistic cache updates flow through `applyTimelineCommitToCaches`; no branch-local cache patches remain in `useTimelineDnd` onDragEnd (Task 3).
- [ ] `useTimelineDnd.test.ts` + `timelineDragPlan.test.ts` green unchanged; new reconciler + event-cache + drag-data tests green.
- [ ] `pnpm typecheck`/`lint`/`vitest` green; `bindings.ts` drift 0; no Rust touched.
