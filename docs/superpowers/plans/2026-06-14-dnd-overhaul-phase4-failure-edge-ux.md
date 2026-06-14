# DnD Overhaul — Phase 4 (Failure & Edge UX) Implementation Plan

> Final phase. Renderer-only, all in `src/components/today/useTimelineDnd.ts` (+ its test). No IPC/schema/migration. Implemented directly (single file, scattered precise edits) with a separate opus critic for the no-self-approve gate.

**Goal:** Make timeline DnD failures and the by-design routine limits legible: (1) unify ALL stage-IPC failures → user toast + rollback (matching the existing cross-calendar path); (2) routine midnight-clamp affordance (the "00:00 막힘" confusion made legible) on routine moves; (3) routine fixed-length tooltip on routine resize (message-only — routine length is definition-fixed).

**Pure, testable helpers (`useTimelineDnd.ts`, tested in `useTimelineDnd.test.ts`):**

- `stageFailureToast(kind): { scope, message }` — centralizes the failure-toast copy per stage kind (schedule/reschedule/resize/unschedule/moveCalendar/routineSchedule). Exhaustive.
- `routineBoundaryClamped(rawAt, clampedAt, rawDurationMin, clampedDurationMin): boolean` — true iff the occurrence-date clamp actually moved the start or shortened the duration (i.e., the routine hit the midnight boundary).

**Wiring (inspection + critic + user failure-injection smoke):**

- Every silent `catch` (schedule/resize/reschedule/unschedule/routineSchedule) gains `pushError(stageFailureToast(kind))` alongside the existing `invalidate*` rollback. `moveCalendar` switches its inline string to the same helper for consistency.
- Routine **move** (reschedule, `blockKind==="routine"`): if `routineBoundaryClamped(...)`, `pushInfo("루틴은 자정을 넘을 수 없어 그 날 안에서 멈췄어요")` — the midnight affordance.
- Routine **resize** (`blockKind==="routine"`): `pushInfo("루틴 길이는 정의에서 고정 — 시간만 옮겨집니다")` — the fixed-length tooltip (explains why the height snaps back; also covers the midnight case for resize, so the affordance is move-only to avoid double-toasting).

**Done-criteria:** vitest green (new helper tests); typecheck/lint clean; ownership guard pass (no TodayView change); bindings drift 0. Failure-injection + routine-midnight live smoke = user/cmux.

**Tests added:**

- `stageFailureToast`: each kind returns a non-empty scope + message; moveCalendar keeps its existing copy.
- `routineBoundaryClamped`: clamped start → true; shortened duration → true; unchanged → false.

**Invariants:** local-ISO only; bounded (toasts auto-dismiss); AppError envelope (pushError accepts string scope); @dnd-kit in `today/**`; smallest change; do NOT remove the routine clamp (it is by-design per spec §5 — only make it legible).
