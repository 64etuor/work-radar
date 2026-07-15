# Jobs Run Ledger Redesign Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn the Jobs screen into an editorial operations ledger while preserving every existing
bounded-run, kill, log, and Acceptance behavior.

**Architecture:** Keep `JobsView` as the only query, mutation, polling, prompt, open-log, and scroll
orchestrator. Derive display-only run counts in the view, then pass plain props into the existing
header, control, list, and row leaves. Restrict all styling to the colocated `JobsView.css`; introduce
no backend, IPC, persistence, or global-token change.

**Tech Stack:** React 19, TypeScript, TanStack Query, shadcn/ui primitives, Tailwind v4 tokens,
colocated CSS, Vitest DOM/static-markup tests, Tauri 2.

---

## Task 1: Lock the new information hierarchy with failing DOM tests

**Files:**

- Create: `src/components/jobs/JobsView.dom.test.tsx`
- Reference: `src/components/jobs/JobsView.tsx`
- Reference: `src/components/jobs/JobsHeader.tsx`
- Reference: `src/components/jobs/JobControls.tsx`
- Reference: `src/components/jobs/JobList.tsx`
- Reference: `src/components/jobs/JobCard.tsx`

1. Build typed `AgentRunView` fixtures for running, awaiting-approval, failed, and succeeded runs.
2. Mock query hooks and scroll restoration at the module seam used by `JobsView`.
3. Render static markup and assert:
   - page eyebrow and supporting copy;
   - active, approval, failed, and completed counts;
   - `새 작업 실행` appears before `실행 환경 진단`;
   - a labelled `최근 실행` ledger contains semantic run articles;
   - failed output exposes an `오류 상세` disclosure rather than a permanently expanded error wall.
4. Run `pnpm vitest run src/components/jobs/JobsView.dom.test.tsx` and confirm the new assertions fail
   for missing presentation.

## Task 2: Add view-local operational summary and editorial header

**Files:**

- Modify: `src/components/jobs/JobsView.tsx`
- Modify: `src/components/jobs/JobsHeader.tsx`

1. Add a strictly typed, pure display summary derived from the current `AgentRunView[]`.
2. Keep active tracking based on the existing `isActiveJobStatus` helper.
3. Pass only plain counts, `tracking`, and `fetching` into `JobsHeader`.
4. Render the eyebrow, title, support copy, polling status, and four labelled metrics.
5. Keep all query and mutation ownership in `JobsView`.

## Task 3: Reorder the launcher around the primary Codex action

**Files:**

- Modify: `src/components/jobs/JobControls.tsx`

1. Add a `새 작업 실행` section header with concise bounded-run guidance.
2. Place `CodexStatusBanner` inside the launcher header so readiness precedes the form.
3. Keep the textarea payload, timeout, max turns, cost cap, success reset, and disabled rules exactly
   as they are.
4. Move Echo and Timeout buttons into a secondary `실행 환경 진단` group after the main form.
5. Add `role="status"` to trigger errors without changing mutation behavior.

## Task 4: Convert cards into semantic ledger rows

**Files:**

- Modify: `src/components/jobs/JobList.tsx`
- Modify: `src/components/jobs/JobCard.tsx`

1. Add ledger section framing, total count, loading skeleton rows, and updated empty copy.
2. Render each run as an `article` labelled by status and kind.
3. Preserve status, engine, sandbox, bounds, duration, tokens, dollars, kill, logs, and proposal panels.
4. For failed detail, render a short CSS-clamped preview and a native `details` disclosure containing
   the complete text. Keep non-failed detail inline.
5. Preserve log follow, copy feedback timer cleanup, and `JobCard` compatibility with
   `AgentRunModal`.

## Task 5: Apply the editorial ledger layout and responsive contract

**Files:**

- Modify: `src/components/jobs/JobsView.css`

1. Expand the content measure to 1180px and keep `.jobs-scroll` as the only vertical scroll owner.
2. Create flat header, four-column summary, launcher, diagnostic strip, and ruled ledger styles using
   existing design tokens only.
3. Use an aligned desktop grid for row identity, metadata, and actions; collapse it below 900px.
4. Add compact behavior below 720px for summary, composer, diagnostics, and row actions.
5. Ensure long Korean/English text, identifiers, errors, and logs cannot create horizontal overflow.
6. Add visible `focus-visible` treatment for native row actions and error disclosure.

## Task 6: Reach green and run frontend health checks

**Files:**

- Modify as needed only within the files above.

1. Run the targeted DOM test until green.
2. Run `pnpm typecheck`.
3. Run `pnpm lint`.
4. Run `pnpm vitest run`.
5. Run `pnpm build`.
6. Run the repository frontend ownership, classname regression, design-token, and timeline-axis guards
   from `package.json` / `docs/reference/commands.md`.
7. Run Prettier check and `git diff --check` for the changed scope.
8. Run React Doctor against the changed frontend scope and resolve changed-file findings.
9. Count pure LOC for touched TypeScript/TSX files and split only if the repo warning/blocking bands
   require it.

## Task 7: Verify the actual Tauri UI and obtain independent reviews

**Files:**

- Output only: `output/visual-qa/jobs-*.jpg` (not committed)

1. Run `pnpm tauri build --debug` and launch the resulting application bundle.
2. Navigate to Jobs in the actual app and capture fresh JPEG evidence at:
   - desktop 1507x768, page top;
   - desktop ledger with succeeded and failed rows;
   - desktop failed disclosure and open-log states;
   - compact 750x480, page top;
   - compact ledger rows.
3. Verify capture signatures, dimensions, modification times, and absence of black/blank regions.
4. If real data has no awaiting-approval row, record that limitation and rely on DOM coverage for the
   preserved proposal composition; do not mutate job state solely to manufacture QA data.
5. Ask two fresh read-only reviewers to inspect the final source and captures:
   - functional/invariant reviewer;
   - visual hierarchy, responsive, and CJK reviewer.
6. Fix every blocking finding, rebuild, recapture, and rerun both reviewers until both pass.
7. Stop the launched app cleanly.

## Task 8: Create the implementation history checkpoint

**Files:**

- Stage only the Jobs implementation and test files from this plan.

1. Inspect `git status`, scoped diff, staged filenames, staged diff, and `git diff --cached --check`.
2. Confirm `.codex/config.toml`, `docs/reference/commands.md`, and `governance/AGENTS.md` remain
   unstaged and unchanged by this work.
3. Commit with `feat(jobs): turn runs into operational ledger`.
4. Push `dev` to `origin/dev`.
5. Verify `git rev-list --left-right --count origin/dev...HEAD` reports `0 0`.
