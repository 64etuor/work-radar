# Skills Registry Library Desk Redesign

**Date:** 2026-07-15
**Status:** Approved
**Scope:** Skills Registry frontend composition, display-only summary model, tests, and styling only

## Context

Skills Registry is already a full manager: it discovers skills across agent environments and project
workspaces, groups duplicates, exposes divergence, and provides explicit install, backup, update,
audit, apply, and removal actions. The current presentation compresses that capability into a single
header row followed by a dense card wall. With 375 discovered items, the desktop view produces five
narrow columns with weak reading hierarchy. At logical 750x480, the fixed 184px sidebar and unbounded
toolbar squeeze the Korean title into a vertical character stack while the cards retain only a cramped
two-column area.

The redesign must make `find -> inspect origin -> manage deliberately` obvious without changing
queries, mutations, generated bindings, external-directory safety, Sheet behavior, or decision rails.

## Considered Directions

1. **Denser command center** — add more counters, status colors, and filters. This increases the very
   dashboard density that currently obscures the library.
2. **Mobile drawer navigation** — move sources and workspaces behind a new overlay. This adds navigation
   state and another Esc surface to a page whose existing Sheet contract is safety-sensitive.
3. **Library desk** — keep sources visible, add a concise operational brief, separate creation from
   maintenance actions, widen cards, and turn the compact sidebar into a horizontal source rail.

## Chosen Direction: Library Desk

The page follows the existing manager workflow:

1. **Find** — search and narrow the registry by environment, workspace, or tag.
2. **Inspect** — compare source, provider, location, enabled state, and divergence before acting.
3. **Manage deliberately** — add, install, apply, update, back up, or remove only through explicit
   existing user actions with the current audit and reversal guarantees.

The visual language stays within `DESIGN.md`'s Cohere white editorial system: an open white canvas,
large readable heading, mono operational labels, hairline rules, restrained semantic color, and no
gradients or decorative metric cards.

## Information Architecture

### Registry Header

- Eyebrow: `LIBRARY / SOURCES / WORKSPACES`.
- Visible `h1`: `Skill Registry` with the Korean explanation
  `에이전트 도구를 찾고, 출처를 비교하고, 필요한 환경에 적용합니다.`
- A four-fact brief reports visible skills, registered environments, project workspaces, and diverged
  copies from data already loaded by `SkillsView`.
- Creation actions (`인앱 프롬프트 추가`, `URL로 설치`) form the primary action group.
- View, help, backup, update, and audit controls form a quieter maintenance group while preserving
  their labels, callbacks, disabled states, and explicit-user-action semantics.

### Source Rail and Library Surface

- Search remains first and continues to filter the existing client-side list.
- Agent environments and project workspaces remain visible and retain counts, active state, local
  ordering, drag reordering where already supported, and divergence health.
- Desktop cards widen enough to support names, paths, badges, and descriptions as readable records
  rather than tiles. List view remains available.
- Section grouping, deduplication, provider labels, tags, selection, batch actions, and Sheet details
  remain behaviorally unchanged.

### Compact Composition

- At 900px and below, the header becomes readable rows; the heading never collapses into a vertical
  character stack and actions wrap by purpose.
- The fixed left sidebar becomes a full-width source rail above the library. Search spans the available
  width and environment/workspace buttons scroll horizontally rather than consuming a narrow column.
- The library receives the full content width, keeps two useful columns at 750px, and falls to one
  column at narrow phone widths.
- `skl-body` remains the sole vertical scroll owner; the horizontal source rail does not introduce a
  second vertical page scroll.

## Component and State Boundaries

`useSkillsView` remains the sole query, mutation, selection, filtering, deep-link, Sheet, batch, and
environment-order owner. A pure `skillRegistryBrief` helper derives four display values from already
loaded collections. A render-only `SkillsRegistryHeader` receives those values and existing callbacks.
`EnvNavButton`, `SkillCard`, manager panels, and query hooks retain their current responsibilities.

No Rust, IPC, generated binding, SQLite, query key, mutation, store, network, keychain, filesystem, or
agent-execution behavior changes are in scope.

## Responsive and Accessibility Contract

- Desktop preserves visible sources beside the continuously scrollable library.
- Logical 750x480 shows a readable heading, purpose-grouped actions, full-width source rail, and useful
  card width without horizontal clipping.
- There is one visible `h1`, ordered brief facts, semantic navigation and toolbar labels, textual
  loading/error/empty states, and visible keyboard focus.
- Korean copy stays on natural word boundaries; skill names and paths truncate or wrap without
  changing row geometry unexpectedly.
- Existing grid/list pressed state, environment pressed state, checkboxes, tags, and Sheet focus/Esc
  semantics remain intact.

## Invariants Preserved

- Installing, applying, updating, restoring, removing, and syncing skills remain explicit user actions.
- Managed skills retain central-library SSOT; discovered external skills remain disk-SSOT until import.
- External directory writes remain reversible and audited; config and secret files remain out of scope.
- Network installation and update behavior remain Rust-owned and bounded; the renderer gains no token or
  network path.
- Skills never execute or auto-apply a Codex job. Gated proposal and Acceptance behavior is unchanged.

## Verification

- Add failing pure-model tests for the four brief facts and a failing DOM contract for the editorial
  header and purpose-grouped actions.
- Run targeted tests, typecheck, lint, full Vitest, build, frontend ownership/classname/design-token
  guards, React Doctor, raw-token checks, and scoped diff checks.
- Inspect the actual Tauri app at desktop and logical 750x480, including source filtering, grid/list
  switching, library scrolling, Sheet open/Esc close, and focus restoration.
- Obtain fresh independent functional/invariant and visual/CJK review passes over the final build.

## Deliberate Deferrals

- No new marketplace, ranking, recommendation, AI summary, sort, filter, bulk behavior, mutation,
  persistence, backend command, or shell navigation.
- No changes to installer, sync, backup, update, audit, divergence, or external-directory semantics.
- No redesign of Settings, Bookkeeping, Today, or unrelated shared components in this unit.
