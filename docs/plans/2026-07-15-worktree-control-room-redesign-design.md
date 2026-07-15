# Worktree Control Room Redesign

**Date:** 2026-07-15
**Status:** Approved
**Scope:** Worktree frontend composition, view-local presentation components, tests, and styling only

## Context

The Worktree view already supports the complete review workflow: multi-repository worktree discovery,
live dirty and ahead/behind status, four diff lenses, lazy file diffs, branch and commit graphs, safe
rebase, and guarded cleanup. Its current composition gives navigation, review evidence, maintenance,
and graph tools nearly equal visual weight. The selected worktree and the decision the user is trying
to make are therefore harder to read than the amount of functionality warrants.

The redesign must improve orientation and review speed without changing IPC, polling, git commands,
rebase or cleanup guards, diff semantics, query keys, or decision-rail boundaries.

## Considered Directions

1. **Density polish** — retain the existing panels and improve spacing. Low risk, but it preserves the
   competing hierarchy.
2. **Kanban worktree board** — represent worktrees as columns. This implies state movement and wastes
   horizontal space needed by diffs.
3. **Review workbench** — make the selected workspace and its review evidence the center, with
   repository navigation on the left and maintenance in a deliberately secondary rail.

## Chosen Direction: Review Workbench

The page follows the operator's actual sequence:

1. **Orient** — identify repository health and active worktrees.
2. **Select** — choose one workspace and immediately understand branch, base, dirt, and divergence.
3. **Review** — select a lens, scan changed files, and inspect one lazy-loaded diff.
4. **Investigate** — open branch or commit evidence only when needed.
5. **Maintain** — invoke safe rebase or guarded cleanup from a separated maintenance surface.

The visual language stays within `DESIGN.md`: white editorial canvas, strong display hierarchy,
hairline rules, restrained mono evidence, semantic diff color, and minimal container chrome.

## Information Architecture

### Control Header

- Visible `h1`: `Worktree Control Room` with an operational one-line description.
- A compact live-status brief reports repository count, worktree count, active changes, and worktrees
  needing attention.
- Refresh state remains explicit; no health score or generated recommendation is introduced.

### Workspace Navigator

- Repository groups remain the primary left navigation.
- Each row leads with branch/worktree identity and keeps dirty, staged, unstaged, ahead, behind, clean,
  merged, and active-change evidence visible.
- Long repository, branch, and path values truncate inside their own columns and expose full text via
  native titles.

### Review Brief and Lens Bar

- The selected workspace receives one clear review brief: branch, base, status, change totals, and
  recent activity.
- Working, staged, vs-base, and branch-to-branch modes remain exactly the existing four lenses.
- Reference selectors appear only when their lens requires them.
- Commit and branch evidence remain disclosure actions, not permanent peer panels.

### Changed-File Ledger and Diff

- File rows form a ruled ledger grouped by existing source semantics.
- Status, path, additions, deletions, and binary state remain visible without pill overload.
- The selected file and selected lens are repeated at the diff header so the evidence has context.
- The file list and diff retain independent bounded scroll ownership; the page never gains a second
  accidental viewport scroll.

### Maintenance Drawer

- Safe rebase and cleanup remain available but are visually separated from read-only inspection.
- Existing dirty refusal, protected-candidate, force, confirmation, backup, abort, and restoration
  behavior is unchanged.
- Destructive controls retain explicit labels and disabled states; no bulk default selection is added.

## Component and State Boundaries

`WorktreeView` remains the sole query, mutation, selection, resize, drawer, and scroll orchestrator.
Presentation may be split only along existing workflow boundaries: Control Header, Workspace
Navigator, Review Brief/Lens Bar, Changed-File Ledger, Diff Panel, and Maintenance Drawer. Child
components receive typed props and do not own React Query hooks or mutation lifecycle.

No backend, IPC, generated binding, SQLite, query-key, polling cadence, store, global token, or git
behavior change is in scope.

## Responsive and Accessibility Contract

- `.wt` remains a bounded app-view root and names exactly one page-level layout owner.
- Desktop uses navigator plus review surface; compact widths stack navigator before review without
  reordering the decision sequence.
- File ledger and diff remain usable at 750x480 with no page-level horizontal overflow.
- Long Korean and English branch, path, subject, author, status, and error strings stay contained.
- One visible `h1`, ordered section headings, textual loading/error/empty states, keyboard-reachable
  rows, visible focus, and native disabled semantics are required.
- Color never carries dirty, diff, merged, or error meaning alone.

## Invariants Preserved

- Diff inspection remains read-only and uses the existing four canonical modes.
- Live status polling remains bounded at the current React Query cadence.
- Rebase and cleanup remain explicit human actions with current backend safety checks.
- No agent automatically decides, stages, commits, pushes, or changes worktree state.
- External commands and repository access remain in Rust; the renderer receives typed IPC data only.

## Verification

- Add failing model and DOM contracts for the header brief, navigator ordering, review context, lens
  visibility, changed-file ledger, and maintenance separation.
- Run targeted tests, typecheck, lint, full Vitest, build, repository frontend guards, formatting,
  React Doctor, and scoped diff checks.
- Build and inspect the actual Tauri app at desktop and 750x480, including long mixed CJK/English
  content, loading, empty/error presentation, independent scrolling, and non-mutating interactions.
- Obtain fresh independent functional and visual/CJK review passes over the final build and captures.

## Deliberate Deferrals

- No new search, filter, sort, bulk action, drag behavior, git mutation, AI summary, health score,
  polling interval, persistence, or backend command.
- No redesign of Jobs, PR Radar, Capture Board, Settings, or the global app shell from this page.
