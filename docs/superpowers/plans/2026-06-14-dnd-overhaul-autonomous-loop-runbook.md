# Autonomous-loop runbook — Today×Timeline DnD UX overhaul (Phases 1–4)

> **Purpose.** Drive the remaining phases of the DnD/time-block UX overhaul autonomously across a
> `/loop` session (self-paced). This file is the durable instruction set; the loop prompt just points here.
> **Read this whole file first each loop iteration**, then act on the _first incomplete_ phase.

## How to launch (next session)

Self-paced loop (no fixed interval):

```
/loop implement the next incomplete phase of docs/superpowers/plans/2026-06-14-dnd-overhaul-autonomous-loop-runbook.md
```

The loop re-enters this runbook each iteration, detects the next incomplete phase from git history +
the Progress ledger below, does one phase end-to-end (plan → implement → review → gate → commit), updates
the ledger, then **pauses for the user** (live-smoke + push are human gates — see Hard Constraints).

## Source of truth (read before acting)

- **Spec:** `docs/superpowers/specs/2026-06-14-today-timeline-dnd-ux-overhaul-design.md`
- **Plan (Phase 0 full + 1–4 roadmap):** `docs/superpowers/plans/2026-06-14-today-timeline-dnd-ux-overhaul.md`
- **Decision log:** `docs/decisions.md` (latest 2026-06-14 entries) — append a one-liner per phase.
- **Repo rules:** `AGENTS.md`, `docs/areas/today-timeline.md`, `docs/areas/decision-rails.md` (7 INVARIANTS),
  `docs/reference/commands.md` (canonical commands).

## Current state (as of 2026-06-14, dev tip `43c7d2e`, PUSHED)

- **Phase 0 (handle reliability) — DONE + PUSHED + user-live-confirmed.** Final model = **Google-Calendar
  grab**: body = move, thin 6px top+bottom edges = resize on every block, handles at the edge (no inset),
  invisible occlusion fix kept (hover/focus z-lift + `scale(1.02)` removed). Commits `ba90b7a`/`02dfc18`/
  `9079500`/`16da9a6` then re-tuned by `43c7d2e`. User said "잘 되는 거 같아" → Phase 0 closed.
- **Routine "stuck at 00:00" is NOT a bug** — routines store `날짜+HH:MM` (`routine_checks`), structurally
  can't cross midnight (spec §5). The Phase 4 affordance below makes it _legible_; do not try to "fix" the
  clamp.

## Phase order & per-phase done-criteria (do ONE per iteration, in this order)

For each phase: (1) run `superpowers:writing-plans` against the matching spec §4 phase to expand it into
bite-sized TDD tasks; (2) execute with `superpowers:subagent-driven-development` (implementer → spec
review → code-quality review per task); (3) run the full gate; (4) separate final critic pass; (5) commit
to `dev` (NO push); (6) append a `docs/decisions.md` line; (7) update the Progress ledger here; (8) STOP
and hand the live-smoke checklist to the user.

### Phase 1 — Drag/resize feel (spec §4 Phase 1)

- Overlap-conflict tint during preview (driven by `computeLayout` cluster size) — `timelinePreview.ts`,
  `TimelineCanvas.tsx`, `TodayView.css`; test `timelinePreview.test.ts`.
- Floating **duration pill** on the active edge during resize (`HH:MM–HH:MM · 1h15m`), start-time on move
  — `TimelineCanvas.tsx` (~218-268).
- Suppress the redundant `DragOverlay` ghost for `from:"canvas"`/`"canvas-resize"` (preview is the truth);
  keep it for tray/routine — `TodayView.tsx` (~375).
- **Outside-grid release**: thread the release pointer (from `pointerClientRef`/`dragRawPointerRef` + fresh
  grid rect, available in `onDragEnd`) into `normalizeDropDataForDragEnd` so "lost-droppable-over-grid"
  (re-resolve from pointer) vs "released-off-grid" (snap back + toast) are distinguishable — today it
  commits a lost droppable to `gridY:0` (grid top). `useTimelineDnd.ts` (~150-160, 475); test
  `useTimelineDnd.test.ts`.
- **Done:** vitest green incl. new drop-normalization cases; tsc 0; eslint 0; bindings drift 0. Live-smoke
  (overlap tint visible; pill tracks edge; no double-ghost; off-grid drag snaps back) = **user**.

### Phase 2 — Snapping model (spec §4 Phase 2)

- Parameterize `snap` in `timelineCoords.ts` (default 15); **Alt/Option = 5-min** fine snap read from
  `ev.activatorEvent`; **magnetic edge-snap** to adjacent block start/end within ~6px (candidate edges from
  rendered boxes; nearest wins over grid). Touches `timelineCoords.ts`, `timelinePreview.ts`,
  `useTimelineDnd.ts`.
- **Tests:** snap-priority (magnetic > grid within threshold), cross-midnight parity, routine-clamp parity
  in `timelineCoords.test.ts` / `timelinePreview.test.ts`.
- **Done:** gates green. Live feel-smoke = **user**.

### Phase 3 — Keyboard / a11y (spec §4 Phase 3; closes the documented v2 gap)

- Custom `coordinateGetter` for 15-min keyboard steps (Shift = 1h); visible focus ring on handles +
  `aria-keyshortcuts`; live-region announcing the new time on move/resize. `TimelineBlock.tsx`,
  `useTimelineDnd.ts`, CSS. Retire the keyboard v2 items in `docs/areas/today-timeline.md`.
- Also add the **render-level test deferred from Phase 0**: assert both resize handles render (RTL) — this
  is the natural home for it now that both handles always render.
- **Done:** keyboard-only move + resize works (Tab→block→Space→arrows→Space, Esc cancels); gates green.
  a11y smoke = **user**.

### Phase 4 — Failure & edge UX (spec §4 Phase 4)

- Unify **all** stage-IPC failures → toast + rollback (schedule/reschedule/resize/moveCalendar/
  routineSchedule), matching the existing cross-calendar path (`useTimelineDnd.ts` ~360-639).
- **Routine midnight-clamp affordance** (the user-facing fix for the "00:00 막힘" confusion): a cursor/tick
  cue or boundary-stop indicator before the silent stick (`useTimelineDnd.ts` ~388-401, 478-487;
  `timelinePreview.ts` clamp branches). This makes the by-design routine limit _legible_, not silent.
- Routine **fixed-length tooltip** on routine resize (message-only — no migration).
- **Tests:** failure-path rollback assertions in `useTimelineDnd.test.ts`.
- **Done:** gates green. Failure-injection + routine-midnight smoke = **user**.

## Working method (every phase)

1. `superpowers:writing-plans` → bite-sized TDD tasks for the phase (save under `docs/superpowers/plans/`).
2. `superpowers:subagent-driven-development`: one implementer subagent per task (dispatch with FULL task
   text, not a file ref), then spec-compliance review, then code-quality review; fix loops until both pass.
3. Full gate (see below). 4. Separate final critic pass over the whole-phase diff (`oh-my-claudecode:critic`,
   opus). 5. Commit to `dev`. 6. `docs/decisions.md` one-liner. 7. Update Progress ledger. 8. Hand the
   live-smoke checklist to the user and STOP.

## Gate (canonical = `docs/reference/commands.md`)

- `pnpm typecheck` (0) · `pnpm lint` (0 err; ≤2 baseline warns) · `pnpm vitest run` (all green).
- `git status --porcelain src/bindings.ts` empty (no IPC change expected; if a phase adds IPC, regenerate
  via `cargo test`, never hand-edit).
- Before any commit: `export PATH="$HOME/.cargo/bin:$PATH"` (husky runs cargo fmt + typecheck) and
  `pnpm exec prettier --write <staged FE files>` (husky lint-staged otherwise reformats; commits that need
  bypass for a _documented_ reason use `--no-verify` only after manually passing the gate).

## Hard constraints (DO NOT VIOLATE)

- **No auto-push.** Standing user policy (2026-06-01): push to `dev` ONLY on explicit user request. The
  loop commits locally and stops; it never pushes. `main` is PR-only.
- **Live GUI smoke = user only.** The agent cannot drive the native WKWebView. A phase is "implemented +
  gated + reviewed" by the loop, but NOT "done" until the user runs the live smoke. The loop must surface
  the checklist and pause — never claim a phase passed live.
- **No self-approve.** Author and reviewer are separate contexts/subagents (INVARIANT). Final critic pass
  per phase.
- **Smallest local change**; one concern per commit/PR. No unrelated refactors or file cleanup.
- **No schema/migration** in these phases (routine length stays message-only). **No hand-written IPC types**
  (tauri-specta `src/bindings.ts` is generated). **Design tokens** only (no raw hex; the token gate is
  TSX-only, so eyeball new CSS). **Bounded retry only**; AppError envelope.
- **Respect the routing**: `docs/areas/today-timeline.md` + `docs/areas/decision-rails.md` (7 INVARIANTS).
- **Tooling traps** (`docs/areas/shell-tooling.md`): rtk-wrapped output can mislead — verify pushes with
  `git ls-remote origin refs/heads/dev`; foreground `sleep` is blocked (use background); `cargo` not on
  default PATH.

## Stop conditions

- **Pause after each phase** for user live-smoke + push decision (the loop cannot complete the human gates).
- **Hard stop** if: a gate cannot pass after the review loop; an INVARIANT would be violated; a phase needs
  a product decision not covered here; or all four phases are implemented + awaiting user smoke.
- If the user has not yet live-confirmed the _previous_ phase, prefer to STOP rather than stack an
  unverified phase on top — unless the user explicitly said to keep going.

## Progress ledger (update each iteration)

- [x] **Phase 0** — handle reliability / Google-Calendar grab model. dev `43c7d2e`, PUSHED, user-live-confirmed.
- [ ] **Phase 1** — drag/resize feel.
- [ ] **Phase 2** — snapping model.
- [ ] **Phase 3** — keyboard / a11y (+ deferred render-level handle test).
- [ ] **Phase 4** — failure & edge UX (+ routine midnight affordance).
