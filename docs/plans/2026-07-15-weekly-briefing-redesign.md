# Weekly Review Briefing Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Recompose Weekly Review as an editorial briefing that moves from weekly direction to
evidence to reflection while preserving all existing data and human-review actions.

**Architecture:** Keep `WeeklyView` as the page-level query, week-navigation, derivation, and scroll
orchestrator. Extract a render-only briefing header and evidence ledger so the container stays focused;
reuse all existing diagnosis, Life OS, radar, debt, completion, reflection, and archive components.
Restrict visual changes to the colocated Weekly CSS and introduce no backend, IPC, persistence, store,
or global-token change.

**Tech Stack:** React 19, TypeScript, TanStack Query, shadcn/ui primitives, Tailwind v4 design tokens,
colocated CSS, Vitest server-rendered DOM contracts, Tauri 2.

---

## Task 1: Lock the briefing hierarchy with a failing DOM test

**Files:**

- Create: `src/components/WeeklyView.dom.test.tsx`
- Reference: `src/components/WeeklyView.tsx`
- Reference: `src/components/weekly/WeekNavigator.tsx`
- Reference: `src/components/weekly/WeekScrubber.tsx`

1. Mock the Weekly query/store/scroll seams and expensive child visualizations.
2. Render `WeeklyView` with a typed current-week review fixture.
3. Assert the page contains:
   - `REVIEW / WEEKLY BRIEFING` and one visible `Weekly Review` heading;
   - direction, evidence, balance, and reflection section labels;
   - evidence groups for flow, routine, pull requests, and focused time;
   - the conditional OKR prompt before the direction region;
   - completed work before reflection, because tagging is owned by completed rows.
4. Run `pnpm vitest run src/components/WeeklyView.dom.test.tsx` and confirm the new assertions fail
   against the current layout.

## Task 2: Build the compact briefing header

**Files:**

- Create: `src/components/weekly/WeeklyBriefingHeader.tsx`
- Modify: `src/components/WeeklyView.tsx`
- Modify: `src/components/weekly/WeekNavigator.tsx`
- Modify: `src/components/weekly/WeekScrubber.tsx`

1. Move the title, page description, week pager, and scrubber under one semantic header.
2. Keep `WeekNavigator` a render-only bounded pager with existing previous/next/reset behavior.
3. Keep `WeekScrubber` data, titles, selected state, and latest-week scroll behavior unchanged.
4. Add semantic labels to the scrubber and selected-week context without changing its horizontal
   scroll ownership.
5. Pass plain range/navigation/count props from `WeeklyView`; do not move `useWeekNav` ownership.

## Task 3: Extract the weekly evidence ledger

**Files:**

- Create: `src/components/weekly/WeeklyEvidence.tsx`
- Modify: `src/components/WeeklyView.tsx`

1. Render four labelled groups from the existing `WeeklyReview` value:
   - flow: captured, completed, promoted;
   - routine: rate plus done/due;
   - pull requests: new attention and resolved;
   - focused time: total plus by-area rows.
2. Use plain values and existing `fmtMinutes` / `areaLabel` helpers.
3. Keep zero and missing data honest; add no comparison, score, or generated summary.
4. Remove the superseded inline `StatTile` and separate routine-momentum markup from `WeeklyView`.

## Task 4: Recompose the review body in decision order

**Files:**

- Modify: `src/components/WeeklyView.tsx`

1. Keep the OKR check-in prompt as the first conditional item in `.wk-scroll`.
2. Wrap `SystemDiagnosis` and `LifeOsAdvisorPanel` in a `이번 주 방향` region.
3. Render `WeeklyEvidence` after direction and after the existing review error message.
4. Build a two-column desktop body:
   - `균형과 부채`: Life Wheel, routine-derived activity distribution, debt trend;
   - `완료와 회고`: completed list, reflection rank, archive.
5. Preserve every child prop and action; only reorder presentation.
6. Keep `DebtTrend` view-local unless extraction is needed to remain below the component-size warning
   band.

## Task 5: Replace dashboard card chrome with editorial layout

**Files:**

- Modify: `src/components/WeeklyView.css`

1. Reduce the combined fixed header height while retaining one horizontal scrubber.
2. Use the existing 1180px measure, hairline rules, type hierarchy, and semantic status tokens.
3. Style direction as an aligned editorial comparison/recommendation region without nested generic
   card shadows.
4. Style evidence as a four-group ruled ledger with large values and compact labels.
5. Style the two review columns with clear section headings and flat subregions.
6. Below 920px, stack evidence and review regions in the design order.
7. At 750x480, keep title/date/pager/scrubber bounded and expose the start of the scroll body.
8. Allow long Korean focus/sprint/recommendation text to wrap naturally and prevent page-level
   horizontal overflow.
9. Preserve visible focus indicators and minimum practical touch targets.

## Task 6: Reach green and run frontend health checks

**Files:**

- Modify only the Weekly files above if a changed-scope issue is found.

1. Run the targeted DOM test until green.
2. Run the existing `src/components/WeeklyView.test.tsx` Life Wheel contracts.
3. Run `pnpm typecheck`.
4. Run `pnpm lint`.
5. Run `pnpm vitest run`.
6. Run `pnpm build`.
7. Run frontend ownership, classname regression, design-token, and timeline-axis guards.
8. Run scoped Prettier and `git diff --check`.
9. Run `npx react-doctor@latest --verbose --scope changed --base HEAD` and resolve changed-file
   findings.
10. Count pure LOC for changed TSX files and split if repository warning/blocking bands require it.

## Task 7: Verify the actual Tauri UI and independent review gate

**Files:**

- Output only: `output/visual-qa/weekly-*.jpg` (not committed)

1. Run `pnpm tauri build --debug` and launch the built application.
2. Capture fresh actual-app evidence for:
   - desktop 1504x768 current-week top;
   - desktop lower balance/reflection region;
   - desktop historical week after using the previous-week control;
   - compact 750x480 current-week top;
   - compact direction/evidence and lower reflection states.
3. Verify JPEG signatures, dimensions, modification times, and black/blank region ratios.
4. Exercise previous week, next week, and `이번 주로` without mutating review data.
5. Do not generate, accept, dismiss, audit, tag, restore, or otherwise mutate Life OS/review state
   solely for QA.
6. Dispatch two fresh read-only reviewers over the final source and complete capture set:
   - functional/invariant reviewer;
   - visual hierarchy, responsive, and CJK reviewer.
7. If either returns blocking findings, fix the source, rebuild, recapture every affected state, and
   dispatch fresh reviewers until both pass on the same build.
8. Stop the application cleanly.

## Task 8: Create the implementation checkpoint

**Files:**

- Stage only Weekly implementation and test files from this plan.

1. Re-run the targeted DOM test and typecheck immediately before staging.
2. Inspect scoped diff, staged filenames, staged stat, and staged diff check.
3. Confirm `.codex/config.toml`, `docs/reference/commands.md`, and `governance/AGENTS.md` remain
   unstaged and unchanged by this unit.
4. Commit with `feat(weekly): turn review into weekly briefing`.
5. Push `dev` to `origin/dev`.
6. Verify `git rev-list --left-right --count origin/dev...HEAD` reports `0 0`.
