# Capture Board Decision Canvas Redesign Implementation Plan

> **For Codex:** Execute test-first, preserve the board's human-decision and orchestration boundaries,
> and checkpoint design, plan, and implementation independently on `dev`.

**Goal:** Make Capture Board's capture, classification, and execution flow immediately legible while
fixing the compact Inbox layout without changing board behavior.

**Architecture:** Keep `CaptureBoard` as the sole query/mutation/state owner. Add one pure display-only
brief model, evolve the render-only header, and correct view-local responsive CSS plus the existing
Inbox element ref used by responsive geometry. No backend, IPC, binding, query, or persistence change.

**Tech Stack:** React 19, TypeScript, TanStack Query, shadcn/ui, Tailwind v4 tokens, colocated CSS,
Vitest/happy-dom, Tauri 2.

## Task 1: Lock the decision-canvas contract in RED

**Files:**

- Create: `src/lib/captureBoardBrief.test.ts`
- Create: `src/components/board/CaptureBoardHeader.dom.test.tsx`
- Reference: `src/bindings.ts`

1. Add typed signal and routine fixtures covering unclassified, classified, Today, and completed data.
2. Assert a pure brief reports Inbox, classified decisions, Today items, and routines without inferring
   priority or counting Today items as matrix decisions.
3. Render the header with mocked contextual controls and assert one `Decision Board` heading, Korean
   explanation, workflow eyebrow, and four ordered facts.
4. Verify both targeted tests fail only because the new model/header contract is absent.

## Task 2: Add the pure operational brief

**Files:**

- Create: `src/lib/captureBoardBrief.ts`
- Modify: `src/components/CaptureBoard.tsx`

1. Derive Inbox and classified counts from the already filtered board signal list.
2. Derive Today and routine counts from the already loaded execution arrays.
3. Pass the typed brief to the header without adding a query or moving ownership into a leaf.

## Task 3: Recompose the header as an orientation surface

**Files:**

- Modify: `src/components/board/CaptureBoardHeader.tsx`
- Modify: `src/components/CaptureBoard.css`

1. Add the workflow eyebrow, visible h1, Korean description, and four ruled brief facts.
2. Keep `SprintTimer` and `OkrStrip` callbacks and semantics unchanged in a secondary context rail.
3. Use existing typography utilities and tokens only; avoid new cards, gradients, and scores.
4. Condense the composition at 900px so the title and controls remain readable at logical 750x480.

## Task 4: Fix compact Inbox flow without changing drag semantics

**Files:**

- Modify: `src/components/board/MatrixCanvas.tsx`
- Modify: `src/components/CaptureBoard.css`
- Modify: `src/components/inbox/InboxColumn.css` only if a shared rule is required

1. Connect the actual Inbox element to both the zone registry and the existing responsive `inboxRef`.
2. At 900px and below, override the shared fixed basis and width so Inbox fills the canvas.
3. Let the existing `computeInboxHeight` and multi-column position algorithm size and place cards; do
   not introduce a second geometry path.
4. Keep the matrix, central Brain Dump trigger, card drag/drop, Today target, and overlays unchanged.

## Task 5: Reach green and run automated quality gates

1. Run the targeted brief, header, matrix DOM, and geometry tests until green.
2. Run `pnpm typecheck`, `pnpm lint`, `pnpm vitest run`, and `pnpm build`.
3. Run frontend ownership, classname regression, design-token, and timeline-axis guards.
4. Run scoped formatting, `git diff --check`, React Doctor changed-scope scan, and raw-token checks.
5. Resolve only changed-scope findings and preserve unrelated user files.

## Task 6: Pass actual Tauri visual QA and independent review

1. Launch the actual Tauri app and capture fresh desktop plus logical 750x480 evidence.
2. Confirm the header hierarchy, four facts, continuous desktop board, full-width compact Inbox, early
   matrix visibility, and Today/Routines access through the single compact scroll owner.
3. Open Brain Dump, close it with Esc, and verify the app window remains alive and usable.
4. Confirm screenshots are fresh PNGs without blank or black compositor regions.
5. Obtain fresh functional/invariant and visual/CJK reviewer PASS results on the same source and build.

## Task 7: Create and push the implementation checkpoint

1. Re-run targeted tests and typecheck before staging.
2. Stage only Capture Board implementation/test files; inspect staged names, stat, and diff check.
3. Confirm `.codex/config.toml`, `docs/reference/commands.md`, and `governance/AGENTS.md` remain unstaged.
4. Commit `feat(capture-board): sharpen capture decision flow` and push `dev` to `origin/dev`.
5. Verify `origin/dev...HEAD` is `0 0` and only the three preserved user paths remain dirty.
