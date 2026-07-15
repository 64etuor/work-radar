# Capture Board Decision Canvas Redesign

**Date:** 2026-07-15
**Status:** Approved
**Scope:** Capture Board frontend composition, view-local presentation model, tests, and styling only

## Context

Capture Board already implements the product thesis: a person captures an unclassified signal, decides
its quadrant, and deliberately promotes work into Today or a routine. The current desktop board keeps
that workflow intact, but its header is only a small product mark and does not explain the page or show
the queue at a glance. At compact widths, the shared Inbox retains its 178px desktop width while the
canvas stacks, leaving most of the first viewport blank and pushing the decision matrix below the fold.

The redesign must make `capture -> decide -> execute` obvious without changing classification,
promotion, drag geometry, query ownership, modal behavior, generated bindings, or decision rails.

## Considered Directions

1. **Decorative polish** — tune colors and spacing only. This leaves the compact-width failure and weak
   orientation unresolved.
2. **Tabbed mobile board** — split Inbox, matrix, and execution into tabs. This hides queue context and
   introduces new navigation state around protected drag behavior.
3. **Decision canvas** — retain the continuous board, add a concise operational brief, and make the
   compact Inbox a real full-width tray so the matrix follows immediately.

## Chosen Direction: Decision Canvas

The page follows the existing human workflow:

1. **Capture** — add an unclassified signal without automatic placement.
2. **Decide** — inspect Inbox pressure and place cards in the existing 2x2 matrix.
3. **Execute** — move chosen work to Today and maintain recurring commitments.

The visual language remains `DESIGN.md`'s Cohere white editorial system: a strong display heading,
small mono operational labels, open white canvas, hairline rules, restrained semantic color, and no
new gradients or decorative dashboard chrome.

## Information Architecture

### Decision Header

- Eyebrow: `CAPTURE / DECIDE / EXECUTE`.
- Visible `h1`: `Decision Board` with the Korean explanation
  `흩어진 신호를 붙이고, 직접 분류하고, 오늘의 실행으로 옮깁니다.`
- A four-fact brief reports Inbox, classified decisions, Today items, and routines from data already
  owned by `CaptureBoard`.
- Sprint and OKR remain contextual controls. They do not become recommendations or automatic actions.

### Capture and Decision Surface

- `MatrixCanvas` remains the protected, bespoke drag and geometry surface.
- Inbox stays the only landing zone for newly captured signals.
- The four quadrant labels, card affordances, radial area picker, inline title editing, and central
  Brain Dump trigger remain behaviorally unchanged.
- At compact width, Inbox becomes a full-width tray and uses its existing responsive multi-column card
  geometry instead of a narrow desktop column.

### Execution Rail

- Today and Routines remain adjacent execution destinations with their current actions, ordering,
  completion state, and shared `RoutineModal`.
- No tab state, new filter, score, suggestion, or automatic promotion is introduced.

## Component and State Boundaries

`CaptureBoard` remains the sole query, mutation, selection, overlay, and drag-lifecycle orchestrator.
A pure `captureBoardBrief` helper derives four display counts from already loaded arrays. The header is
render-only and receives typed values. `MatrixCanvas`, `ExecutionRail`, `BoardOverlays`, and
`RoutineModal` retain their current responsibilities.

No Rust, IPC, generated binding, SQLite, query key, mutation, store, calendar, Notion, or agent behavior
change is in scope.

## Responsive and Accessibility Contract

- Desktop preserves the continuous Inbox / matrix / execution layout.
- At 900px and below, the page keeps one vertical scroll owner, shows the full-width Inbox tray before
  the matrix, and removes the current blank-right-column failure.
- The matrix begins directly after Inbox and remains large enough for existing drag targets; Today and
  Routines follow in reading order.
- The header condenses to two readable rows at 750x480; no title may wrap into a vertical word stack.
- There is one visible `h1`, ordered operational facts, textual loading/error/empty states, visible
  focus, and no meaning conveyed by color alone.
- Long Korean and English card text remains contained by existing card and list truncation behavior.

## Invariants Preserved

- Every new signal remains unclassified until a person moves it.
- Suggested urgency and enrichment remain hints only and never move a card.
- Today, Notion, and routine writes remain explicit human actions.
- SQLite remains the source of truth; renderer code performs no external network call.
- Brain Dump, Card Menu, Calendar Drawer, project picker, and routine dialog Esc/focus contracts remain
  intact.

## Verification

- Add a failing pure-model contract for the four header facts and a failing DOM contract for the new
  editorial header.
- Run targeted tests, typecheck, lint, full Vitest, build, frontend ownership/classname/design-token
  guards, timeline-axis guard, React Doctor, and scoped diff checks.
- Inspect the actual Tauri app at desktop and logical 750x480, including full-width compact Inbox,
  matrix visibility, page scrolling, Brain Dump open/Esc close, and Today/Routines accessibility.
- Obtain fresh independent functional/invariant and visual/CJK review passes over the final build.

## Deliberate Deferrals

- No tabs, search, filter, sort, bulk action, prioritization score, AI summary, auto-classification,
  auto-promotion, persistence, backend command, or global shell redesign.
- No redesign of Settings, Skills, Bookkeeping, Today, or unrelated shared components from this unit.
