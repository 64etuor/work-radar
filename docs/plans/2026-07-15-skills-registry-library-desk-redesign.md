# Skills Registry Library Desk Redesign Implementation Plan

> **For Codex:** Execute test-first, preserve the full-manager safety rails and query ownership, and
> checkpoint design, plan, and implementation independently on `dev`.

**Goal:** Turn the 375-item Skills Registry card wall into a readable library workflow and fix the
compact title/sidebar/action collapse without changing manager behavior.

**Architecture:** Keep `useSkillsView` as the sole query, mutation, filtering, selection, deep-link,
Sheet, and batch owner. Add one pure display-only brief model and one render-only header, then adjust
view-local CSS so desktop records are wider and the compact sidebar becomes a horizontal source rail.
No backend, IPC, binding, query, persistence, filesystem, or network change.

**Tech Stack:** React 19, TypeScript, TanStack Query, shadcn/ui, Tailwind v4 tokens, colocated CSS,
Vitest/happy-dom, Tauri 2.

## Task 1: Lock the library-desk contract in RED

**Files:**

- Create: `src/lib/skillRegistryBrief.test.ts`
- Create: `src/components/skills/SkillsRegistryHeader.dom.test.tsx`
- Reference: `src/bindings.ts`

1. Add typed fixtures covering visible skills, agent environments, project workspaces, and diverged
   copies.
2. Assert a pure brief reports those four facts without inventing health scores or action guidance.
3. Render the header with callback spies and assert one `Skill Registry` heading, Korean explanation,
   workflow eyebrow, four ordered facts, two creation actions, and the existing maintenance actions.
4. Assert view and help controls retain accessible names and pressed state.
5. Verify the targeted tests fail only because the new model and header contracts are absent.

## Task 2: Add the pure operational brief

**Files:**

- Create: `src/lib/skillRegistryBrief.ts`
- Modify: `src/components/SkillsView.tsx`

1. Derive the visible-skill value from the already filtered environment/tag result.
2. Derive environment and workspace values from the existing navigation models.
3. Pass the existing divergence aggregate through unchanged.
4. Do not add a query, mutation, effect, persisted state, or interpretation of manager health.

## Task 3: Recompose the header as a library orientation surface

**Files:**

- Create: `src/components/skills/SkillsRegistryHeader.tsx`
- Modify: `src/components/SkillsView.tsx`
- Modify: `src/components/SkillsView.css`

1. Add the workflow eyebrow, visible h1, Korean description, and four ruled brief facts.
2. Move existing creation callbacks into a primary action group and view/help/maintenance callbacks
   into a secondary group.
3. Preserve every current action label, callback, state reset, grid/list pressed state, and help name.
4. Use existing typography, Button primitives, and design tokens; add no metric cards, gradients, or
   recommendation copy.

## Task 4: Make sources and records readable at desktop and compact widths

**Files:**

- Modify: `src/components/SkillsView.css`
- Modify: `src/components/SkillsTags.css` only if compact tag flow needs a local rule
- Modify: `src/components/skills/SkillCard.tsx` only if record semantics need markup support

1. Widen desktop grid records so name, badges, path, and description form a readable hierarchy.
2. Keep list view, section grouping, selection checkbox, tags, divergence badge, and Sheet opening
   behavior unchanged.
3. At 900px and below, stack the header into readable rows and wrap actions by purpose.
4. Convert `.skl-main` to a vertical composition and `.skl-sidebar` to a full-width horizontal source
   rail with a full-width search row.
5. Keep `.skl-body` as the only vertical scroll owner, retain horizontal source navigation, and use two
   useful card columns at 750px before collapsing to one column at narrow phone widths.

## Task 5: Reach green and run automated quality gates

1. Run targeted brief, header, environment-nav, grouping, card-badge, tag, and Sheet/help tests.
2. Run `pnpm typecheck`, `pnpm lint`, `pnpm vitest run`, and `pnpm build`.
3. Run frontend ownership, classname regression, design-token, and timeline-axis guards.
4. Run scoped formatting, `git diff --check`, React Doctor changed-scope scan, and raw-color checks.
5. Resolve only changed-scope findings and preserve unrelated user files.

## Task 6: Pass actual Tauri visual QA and independent review

1. Launch the actual Tauri app and capture fresh desktop plus logical 750x480 evidence.
2. Confirm the desktop hierarchy, readable card width, source filtering, project visibility, and sole
   library scroll owner.
3. Confirm the compact heading stays horizontal, actions remain reachable, the source rail scrolls
   horizontally, and the library receives full width.
4. Switch grid/list views, select an environment, open a skill Sheet, close it with Esc, and verify
   focus restoration plus continued app usability.
5. Confirm screenshots are fresh PNGs without blank or black compositor regions.
6. Obtain fresh functional/invariant and visual/CJK reviewer PASS results on the same source and build.

## Task 7: Create and push the implementation checkpoint

1. Re-run targeted tests and typecheck before staging.
2. Stage only Skills Registry implementation/test files; inspect staged names, stat, and diff check.
3. Confirm `.codex/config.toml`, `docs/reference/commands.md`, and `governance/AGENTS.md` remain unstaged.
4. Commit `feat(skills): turn registry into a library desk` and push `dev` to `origin/dev`.
5. Verify `origin/dev...HEAD` is `0 0` and only the three preserved user paths remain dirty.
