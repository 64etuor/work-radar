# PR Radar Merge Desk Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Recompose PR Radar as an editorial merge desk that surfaces merge pressure, PR evidence,
and contextual next actions while preserving all existing polling and proposal behavior.

**Architecture:** Keep `PrRadarView` as the React Query, settings, mutation, navigation, and scroll
orchestrator. Extract a pure summary model plus render-only desk and row components so data fetching
and decision-rail boundaries remain obvious. Remove the chart from the page composition, restrict
visual changes to PR Radar's colocated CSS, and introduce no backend, IPC, persistence, store, query,
or global-token change.

**Tech Stack:** React 19, TypeScript, TanStack Query, shadcn/ui primitives, Tailwind v4 design tokens,
colocated CSS, Vitest DOM contracts, Tauri 2.

---

## Task 1: Lock the merge-desk contract with failing tests

**Files:**

- Create: `src/components/pr-radar/prRadarModel.test.ts`
- Create: `src/components/pr-radar/PrRadarDesk.dom.test.tsx`
- Reference: `src/components/PrRadarView.tsx`
- Reference: `src/bindings.ts`

1. Build typed PR fixtures covering blocked, review, ready, stale, and merged-cleanup states plus CI,
   conflict, discussion, alert, draft, and author evidence.
2. Assert the pure summary contract derives total, attention, critical, suspicious, average age, and
   readiness counts without double-counting the attention queue.
3. Render the desk with typed props and assert:
   - `CODE / MERGE READINESS` and one visible `PR Radar` heading;
   - readiness summary labels in canonical bucket order;
   - ledger buckets and PR titles in canonical order;
   - evidence labels and contextual action visibility;
   - an explanatory initial-polling state rather than a blank canvas.
4. Run the two targeted tests and confirm they fail because the new model and presentation components
   do not exist yet.

## Task 2: Extract the pure readiness summary model

**Files:**

- Create: `src/components/pr-radar/prRadarModel.ts`
- Modify: `src/components/PrRadarView.tsx`

1. Define the canonical bucket descriptors once with `ReadinessBucket` typing.
2. Move grouping into a pure function that returns every bucket even when it is empty.
3. Derive:
   - total item count;
   - attention count as the sum of blocked, review, and stale readiness buckets;
   - critical and suspicious/AI-flagged counts;
   - rounded average age;
   - per-bucket counts.
4. Add no score, inferred priority, sorting, filtering, persistence, or mutation.

## Task 3: Build render-only desk and row components

**Files:**

- Create: `src/components/pr-radar/PrRadarDesk.tsx`
- Create: `src/components/pr-radar/PrRadarRow.tsx`
- Modify: `src/components/PrRadarView.tsx`

1. Render the editorial header, polling status, readiness brief, state messages, and non-empty ledger
   buckets in `PrRadarDesk`.
2. Render each PR as a title-first ledger row with repository/number locator, CI/conflict/draft,
   comments/alerts, age, author, and contextual actions in `PrRadarRow`.
3. Use one typed row-action object rather than the current ten independent row parameters.
4. Preserve existing action visibility and disabled rules:
   - code review for every non-merged PR;
   - CI triage only for `ci_blocked`;
   - AI escalation for AI-flagged, over-threshold discussion, or conflict;
   - open GitHub for every PR.
5. Keep existing visible button text, titles, shared `Button` variants, and pending states.

## Task 4: Reduce `PrRadarView` to orchestration

**Files:**

- Modify: `src/components/PrRadarView.tsx`

1. Preserve project queries, per-project polling cadence, bounded retry, signal invalidation, settings,
   Codex status, mutations, navigation outcomes, and scroll restoration exactly.
2. Build the desk state and typed action callbacks from current query and mutation results.
3. Keep `prEscalationPrompt` machine content unchanged.
4. Remove lazy Recharts loading and all chart-specific derivation from this page.
5. Pass partial polling and action errors as distinct textual messages while retaining successful
   project results.
6. Keep changed production TSX files below the repository's component-size warning band by splitting
   only along the model/orchestrator/presentation/row boundaries above.

## Task 5: Replace dashboard chrome with editorial merge-desk styling

**Files:**

- Modify: `src/components/PrRadarView.css`

1. Move the title and description into the single `.pr-scroll` flow while retaining `.pr-scroll` as
   the sole vertical owner.
2. Replace metric cards and chart rules with one lead summary and five compact ruled counters.
3. Style readiness buckets as open ledger sections with hairline separators instead of rounded card
   wrappers.
4. Give titles two-line wrapping room and keep supporting evidence visually secondary.
5. Keep actions grouped independently so they wrap below evidence instead of shrinking titles.
6. Below 900px, stack summary regions while preserving bucket and row order.
7. At 750x480, keep the header, refresh state, summary, and first ledger section in a natural vertical
   flow without horizontal page overflow.
8. Remove superseded dashboard, chart, legacy card, ticket, and unused action selectors.
9. Use only existing `DESIGN.md` tokens, shared radii, and visible focus behavior.

## Task 6: Reach green and run frontend health checks

**Files:**

- Modify only PR Radar files from this plan if a changed-scope issue is found.

1. Run the targeted model and DOM tests until green.
2. Run `pnpm typecheck`.
3. Run `pnpm lint`.
4. Run `pnpm vitest run`.
5. Run `pnpm build`.
6. Run frontend ownership, classname regression, design-token, and timeline-axis guards.
7. Run scoped Prettier and `git diff --check`.
8. Run `npx --yes react-doctor@latest . --verbose --scope changed --base HEAD` and resolve
   changed-file findings.
9. Count pure LOC for changed TypeScript/TSX files and split if repository warning/blocking bands
   require it.

## Task 7: Verify the actual Tauri UI and independent review gate

**Files:**

- Output only: `output/visual-qa/pr-radar-*.jpg` (not committed)

1. Run `pnpm tauri build --debug` and launch the built application.
2. Capture fresh actual-app evidence for:
   - desktop top with readiness summary and populated ledger;
   - desktop lower ledger and wrapped actions;
   - compact 750x480 top;
   - compact lower ledger with long mixed Korean/English content;
   - initial polling, empty, or partial-error state where the available runtime permits.
3. Verify JPEG signatures, dimensions, modification times, and black/blank region ratios.
4. Exercise scrolling and non-mutating navigation only. Do not trigger code review, CI triage, AI
   escalation, or GitHub opening solely for QA.
5. Dispatch two fresh read-only reviewers over the final source and complete capture set:
   - functional and decision-invariant reviewer;
   - visual hierarchy, responsive, and CJK reviewer.
6. If either returns blocking findings, fix the source, rebuild, recapture every affected state, and
   dispatch fresh reviewers until both pass on the same build.
7. Stop the application cleanly.

## Task 8: Create the implementation checkpoint

**Files:**

- Stage only PR Radar implementation and test files from this plan.

1. Re-run targeted tests and typecheck immediately before staging.
2. Inspect scoped diff, staged filenames, staged stat, and staged diff check.
3. Confirm `.codex/config.toml`, `docs/reference/commands.md`, and `governance/AGENTS.md` remain
   unstaged and unchanged by this unit.
4. Commit with `feat(pr-radar): turn readiness into merge desk`.
5. Push `dev` to `origin/dev`.
6. Verify `git rev-list --left-right --count origin/dev...HEAD` reports `0 0`.
