# Worktree Control Room Redesign Implementation Plan

> **For Codex:** Execute test-first, preserve the current query/mutation boundaries, and checkpoint
> design, plan, and implementation independently on `dev`.

**Goal:** Recompose Worktree as a review workbench that makes repository pressure, selected-workspace
context, changed files, and diff evidence immediately legible while preserving every git safety guard.

**Architecture:** Keep `WorktreeView` as the sole state/query/mutation orchestrator. Add one pure
portfolio-brief model to `worktreeReview.ts`; evolve the existing render-only workflow components in
place. No backend, IPC, binding, query, polling, persistence, or git behavior changes.

**Tech Stack:** React 19, TypeScript, TanStack Query, shadcn/ui, Tailwind v4 tokens, colocated CSS,
Vitest/happy-dom, Tauri 2.

## Task 1: Lock the review-workbench contract in RED

**Files:**

- Modify: `src/lib/worktreeReview.test.ts`
- Create: `src/components/worktree/WorktreeWorkbench.dom.test.tsx`
- Reference: `src/bindings.ts`

1. Add typed worktree fixtures covering active, dirty, staged, divergent, clean, merged, detached, and
   mixed Korean/English identities.
2. Assert a pure portfolio brief reports repository count, worktree count, active count, and attention
   count without double-counting a worktree.
3. Render the presentation boundary and assert one `Worktree Control Room` heading, summary labels,
   repository-first navigation, selected review context, canonical lens order, changed-file evidence,
   and separated maintenance actions.
4. Verify both targeted tests fail only because the new brief/presentation contract is absent.

## Task 2: Add the pure control-room brief

**Files:**

- Modify: `src/lib/worktreeReview.ts`
- Modify: `src/components/worktree/WorktreeView.tsx`

1. Derive repository, worktree, active, and attention counts from the already filtered worktree list.
2. Define attention as a unique worktree with local changes, base divergence, or confirmed unmerged
   state; never add a score or inferred priority.
3. Pass the brief to `WorktreeHeader` and keep project filtering and selection behavior unchanged.

## Task 3: Turn the header and navigator into an orientation surface

**Files:**

- Modify: `src/components/worktree/WorktreeHeader.tsx`
- Modify: `src/components/worktree/WorktreeSideList.tsx`

1. Add the editorial eyebrow, visible h1, description, live polling state, and four ruled brief facts.
2. Keep filter, refresh, graph, and cleanup callbacks unchanged; group graph/cleanup as secondary
   evidence and maintenance actions.
3. Make repository group counts explicit and branch identity primary; retain every current status label
   and full-value title.
4. Keep loading, error, and empty states textual and mutually exclusive.

## Task 4: Recompose selected-workspace review evidence

**Files:**

- Modify: `src/components/worktree/WorktreeReviewPanel.tsx`
- Modify: `src/components/worktree/WorktreeLensToolbar.tsx`
- Modify: `src/components/worktree/WorktreeRefsBar.tsx`
- Modify: `src/components/worktree/WorktreeEmptyState.tsx`

1. Present branch, base, local state, divergence, merge state, and review queue in one readable brief.
2. Retain local, unstaged, staged, vs-base, and branch-to-branch semantics and current selection rules.
3. Keep ref selectors conditional and put safe rebase plus AI review in a clearly labelled action rail.
4. Replace the unselected placeholder with an explanatory workbench state.

## Task 5: Refine the changed-file ledger and diff evidence

**Files:**

- Modify: `src/components/worktree/WorktreeFileList.tsx`
- Modify: `src/components/worktree/WorktreeDiffPanel.tsx`
- Modify: `src/components/worktree/WorktreeDiffText.tsx` only if the visual contract requires it

1. Preserve lazy file diff queries, source grouping, empty-state cross-links, and selected-file logic.
2. Give file path primary weight; keep source, status, additions, deletions, and binary evidence visible.
3. Repeat lens and path context at the diff header without introducing generated explanation.
4. Preserve virtualization hints and independent file-list/diff scroll ownership.

## Task 6: Separate guarded maintenance and rewrite view-local CSS

**Files:**

- Modify: `src/components/worktree/CleanupPanel.tsx`
- Modify: `src/components/worktree/RebaseBar.tsx`
- Modify: `src/components/worktree/CommitGraphDrawer.tsx`
- Modify: `src/components/worktree/WorktreeView.css`

1. Preserve confirmation, protection, force, backup/restore, Esc, and focus-restoration behavior.
2. Use open editorial sections and hairline rules instead of repeated rounded cards and pill chrome.
3. Keep `.wt` as the bounded root, make scroll owners explicit, and contain every grid with
   `min-width: 0` / `minmax(0, 1fr)`.
4. At 900px and 750x480, stack navigator before review, preserve reading order, and prevent page-level
   horizontal overflow.
5. Use `typo-*` utilities for standard text and existing local/global tokens only.

## Task 7: Reach green and run automated quality gates

1. Run targeted model and DOM tests until green.
2. Run `pnpm typecheck`, `pnpm lint`, `pnpm vitest run`, and `pnpm build`.
3. Run frontend ownership, classname regression, design-token, and timeline-axis guards.
4. Run scoped Prettier, `git diff --check`, React Doctor changed-scope scan, and pure LOC checks.
5. Resolve only changed-scope findings and preserve unrelated user files.

## Task 8: Pass actual Tauri visual QA and independent review

1. Run `pnpm tauri build --debug` and launch the built app.
2. Capture fresh desktop and 750x480 evidence for the header brief, navigator, selected review state,
   file ledger, diff, graph/maintenance disclosure, loading, empty/error states where runtime permits,
   and long mixed Korean/English content.
3. Exercise selection, lens changes, panel resize/collapse, graph open/Esc close, and scrolling without
   triggering destructive actions or external navigation.
4. Verify capture signatures, dimensions, freshness, and blank/black-region integrity.
5. Obtain fresh functional/invariant and visual/CJK reviewer PASS results on the same final build.

## Task 9: Create and push the implementation checkpoint

1. Re-run targeted tests and typecheck before staging.
2. Stage only Worktree implementation/test files; inspect staged names, stat, and diff check.
3. Confirm `.codex/config.toml`, `docs/reference/commands.md`, and `governance/AGENTS.md` remain unstaged.
4. Commit `feat(worktree): turn diff viewer into control room` and push `dev` to `origin/dev`.
5. Verify `origin/dev...HEAD` is `0 0` and only the three preserved user paths remain dirty.
