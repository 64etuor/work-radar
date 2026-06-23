# Today Timeline — Sync / Cache-Reconciliation Architecture (design spec)

**Status:** accepted (consensus: independent Codex + Claude analyses converged on every point, 2026-06-23)
**Scope:** Today × Timeline derived-view consistency + Google-mirror sync wiring. Frontend cache layer (React Query) + its relationship to the Rust `pending_calendar_writes` worker.
**Relates:** ADR-0002 (card-as-truth), ADR-0003 (pending write queue), `docs/areas/today-timeline.md`, the just-landed `planTimelineDrag` (`docs/superpowers/plans/2026-06-23-timeline-dnd-planner-geometry.md`).

---

## 1. Problem

The Today timeline keeps producing sync bugs of one shape: a block that should be gone (or should have moved) **lingers / duplicates / orphans** in the timeline. The exemplar reported bug:

> Drag a scheduled card from the timeline back to the inbox (unschedule). The card returns to the inbox, **but a block still remains in the timeline.**

This is not an isolated bug; it is a **structural** consequence of how the timeline view is derived and how each write path keeps its caches consistent.

## 2. The model — the timeline is a derived view over 3 consistency layers

The timeline is **not** stored; it is computed by `buildTodayBlocks` (`src/lib/todayBlocks.ts`) by merging four sources, mirrored to Google Calendar. Every write must keep **three layers** consistent:

| Layer              | What                                                                                                       | Where (frontend)                                                                                   | Reconciler                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **① Card truth**   | `work_signals.scheduled*`/`linked*` + `signal_day_placements`; routines own `time_override ?? time_of_day` | `["today"]`, `["signalPlacements"]`, `["routines", date]` caches; `optimisticSchedule.ts`          | optimistic patch + SQLite SSOT                     |
| **② Mirror cache** | Google calendar events (the mirror of scheduled cards/routines)                                            | `["calendarEvents", date]` + `["calendarEvents","range",s,e]` buckets (`query/calendar.ts:33,164`) | optimistic patch + refetch                         |
| **③ Server**       | Google Calendar via `pending_calendar_writes` + async debounced worker                                     | —                                                                                                  | `calendar_sync.rs` + `calendar/sync.rs` (ADR-0003) |

**The merge rule that makes the bug possible** (`buildTodayBlocks`):

- For each **placement** on the date → emit a signal block, and record that signal's mirror event key in an `absorbed` set (`todayBlocks.ts:158-180`).
- For each **calendar event**: if absorbed (a signal mirror) or matched to a routine → skip; **otherwise emit an independent `event` block** (`todayBlocks.ts:208`).
- ⚠ The signal→mirror absorb happens **only inside the placement loop**. No placement ⇒ the mirror is never absorbed.

## 3. Root cause of the unschedule orphan

Drag-unschedule (`useTimelineDnd.ts:632-671`) updates **layer ① + ③** but **forgets layer ②**:

1. `patchSignalCaches(signalId, { clearLink: true })` → nulls `scheduledAt/duration/linkedEventId/linkedCalendarId` (`optimisticSchedule.ts:34`).
2. `patchPlacementCaches(signalId, { type: "remove", date })` → placement gone.
3. `stage({ kind: "unschedule", … })` → Rust queues a Google **delete** (correct; server side verified — cancels pending-create, supersedes pending-patch, leaves a delete row).
4. **Missing:** nothing removes the mirror event from the `["calendarEvents"]` caches.

Result: placement gone ⇒ `buildTodayBlocks` never absorbs the mirror; link cleared ⇒ it isn't matched either ⇒ the **still-cached Google event renders as an independent orphan `event` block** until the worker deletes it on Google _and_ a refetch occurs.

Two aggravators:

- **No id to remove with:** the signal `DragData` (`timelineDragData.ts:50-59`) carries `calendarId` but **not** `linkedEventId`, so the branch couldn't remove the mirror even if it tried. (`TimedBlock` already has `linkedEventId` — `timelineLayout.ts:17` — it's simply not propagated into signal drag data.)
- **Failure rollback gap:** the branch's `catch` calls only `invalidateSignalCaches()` (`useTimelineDnd.ts:667`); it does not invalidate `["calendarEvents"]`, so an optimistic mirror removal followed by a failed `stage()` would not roll the event back. (Global `CalendarSyncFailed` does invalidate calendarEvents — `calendarSyncEvents.ts:59` — but only on worker failure, not local stage failure.)

## 4. The invariant (single rule that prevents the whole bug class)

> **For every timeline write, the optimistic cache update must reconcile all three layers atomically, and the derived view must never render a mirror event that no live card/routine owns.**

Concretely, per operation the mirror in layer ② must be: **created** (schedule), **patched** (reschedule/resize), **moved** (moveCalendar = delete-old + create-new), or **removed** (unschedule) — in lockstep with layer ① — and the worker (layer ③) reconciles eventually. Today this is done by **scattered, branch-local closures** (`patchSignalCaches`/`patchPlacementCaches`/`patchEventCache`/`patchRoutineCache` inside `useTimelineDnd`, plus a separate `removeEventFromCache` in `useTimelineScheduleActions.ts`), so any one branch can omit a layer. Unschedule omits layer ②; the earlier server leak omitted the mirror move. Same root.

## 5. Decision — a single commit-driven cache reconciler

Mirror what `planTimelineDrag` did for the _math_, for the _cache_:

> Introduce **`applyTimelineCommitToCaches(qc, commit)`** — one function, keyed off the existing `TimelineCommit` union (`timelineDragPlan.ts`), that performs the complete layer-①+② optimistic update for each commit kind. `useTimelineDnd` onDragEnd (and, where it overlaps, `useTimelineScheduleActions`) call it instead of hand-assembling per-branch patches.

Why this shape (consensus rationale):

- **Structural prevention:** the reconciler enumerates every commit kind once; a new/edited branch can't forget the mirror cache because there is one place that owns "apply this commit to all caches."
- **Symmetry + testability:** `planTimelineDrag` (math) → `applyTimelineCommitToCaches` (cache) → `stage` (server). The reconciler is a pure-ish seam (qc-in, cache-mutations-out) that is unit-testable, unlike today's private hook closures.
- **Reuses precedent:** the event-cache removal already exists as `removeEventFromCache` (`useTimelineScheduleActions.ts:16`, `setQueriesData(["calendarEvents"])` — covers **both** per-date and range buckets via the prefix). The reconciler consolidates this.

Hardening `buildTodayBlocks` to suppress orphans was considered and **rejected as the primary fix**: once a card is unlinked there is no reliable client signal that a given event _was_ its mirror (Google events expose no card marker in the FE `CalendarEvent` type), so the view cannot defensively know which events to hide. Keeping the derived view a pure projection and fixing the **cache feeding it** is the clean layer.

## 6. Immediate fix (frontend-only — no Rust/IPC/bindings/schema change)

1. Propagate `block.linkedEventId` into signal `DragData` (`timelineDragData.ts` signal branch) + the `unschedule` `TimelineCommit` (carry `calendarId` + `linkedEventId`).
2. In drag-unschedule, remove the mirror from **all** `["calendarEvents"]` buckets **before** `clearLink` (reuse/extract `removeEventFromCache`).
3. Add `invalidateEventCaches()` to the unschedule `catch` (rollback parity with event-backed branches).

The IPC/stage contract is unchanged — signal `unschedule` still sends only `{ targetSignalId, fromDate }`; Rust resolves the linked event from the DB. The `linkedEventId` is needed **only** client-side, to clean layer ② before layer ① erases the link.

## 7. Edges / follow-ups (non-blocking)

- **Refetch race:** after optimistic removal, a background refetch (`staleTime` 60s) before the worker deletes on Google could re-introduce the event. Bounded by staleTime; the worker delete + next refetch converge. If observed live, add short-lived pending-delete suppression. (Server already leaves only a delete row, so convergence is guaranteed once the worker runs.)
- **Undo path:** drag-unschedule's undo stages a bare `reschedule` after the link is cleared; server `reschedule` without a linked event returns `calendar.no_linked_event` unless `linked_calendar_id`+`scheduled_at` survive (`calendar_sync.rs`). Undo should preserve prior `calendarId`/`linkedEventId` and use a restore/schedule path. Harden after the reconciler lands.
- **@dnd-kit boundary (separate, pre-existing):** `TodayView.tsx:3` imports `@dnd-kit/core` while `today-timeline.md:26` limits @dnd-kit imports to `src/components/today/**` (area-map includes `TodayView.tsx` in scope — `area-map.md:51`). Doc/architecture inconsistency, not part of this bug.

## 8. Verification strategy

- Regression test the exact gap: a signal block/drag fixture **with `linkedEventId`** + assert drag-unschedule removes the matching event from **every** `calendarEvents` bucket (per-date and range). No such test exists today.
- `applyTimelineCommitToCaches` gets unit tests per commit kind (the reconciler is the durable seam).
- Parity net for the migration: existing `useTimelineDnd.test.ts` (stage payloads) + `timelineDragPlan.test.ts` must stay green — behavior unchanged except the orphan fix.
- Server side needs no change (verified covered: cancel-pending-create, delete-only-from_date, supersede-pending-patch).
