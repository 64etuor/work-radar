# PR Radar Merge Desk Redesign

**Date:** 2026-07-15
**Status:** Approved
**Scope:** PR Radar frontend composition, view-local presentation components, tests, and styling only

## Context

PR Radar already has the right operational capabilities: multi-project polling, readiness buckets,
CI and conflict signals, Inbox alert indicators, bounded Codex review and triage proposals, and a
direct link to GitHub. The current composition makes those capabilities harder to use than necessary.

Seven equal metric cards and a bucket chart occupy the most prominent region even though the same
counts are repeated immediately below. Each PR then spreads repository, title, evidence, and actions
across four competing columns. This produces a generic dashboard at desktop size and a dense stack of
pills at compact size. When polling is slow, the page shows only a one-line title bar above an empty
canvas, so the user cannot tell what will appear or whether cached information is available.

The redesign must make merge readiness and the next human decision obvious without changing polling,
query keys, mutation payloads, escalation thresholds, navigation outcomes, or decision-rail
semantics.

## Considered Directions

1. **Refined dashboard** — retain the seven cards and chart but improve spacing. This preserves the
   current shape, but keeps duplicate summary information ahead of the PRs that need action.
2. **Kanban readiness board** — turn the five buckets into columns. This makes category movement
   visible, but long PR titles, mixed action sets, and compact windows would create horizontal
   overflow and imply drag-based state mutation that does not exist.
3. **Editorial merge desk** — summarize the portfolio in one evidence band, then present readiness
   buckets as a ruled operational ledger. This best matches the existing read-and-propose behavior and
   `DESIGN.md`.

## Chosen Direction: Editorial Merge Desk

The page follows the sequence used during a merge-readiness sweep:

1. **Orient** — see whether polling is active and how many PRs are in scope.
2. **Find pressure** — read blocked, review, ready, stale, and alert totals without scanning cards.
3. **Inspect evidence** — understand the repository, PR, CI, age, discussion, author, and alert state.
4. **Choose an action** — open GitHub or explicitly start a bounded review, CI triage, or escalation
   proposal.

The visual language remains Cohere white editorial: one typographic header, hairline rules, restrained
mono labels, semantic status color, and open rows. Repeated rounded cards, chart chrome, and decorative
containers are removed.

## Information Architecture

### Merge Desk Header

- Eyebrow: `CODE / MERGE READINESS`
- Visible `h1`: `PR Radar`
- One-line description clarifies that this is a human-controlled review desk.
- Polling status remains on the right with an explicit interval or refresh state.
- The header is part of the single page scroll so compact windows reach the ledger naturally.

### Readiness Brief

The seven-card dashboard and Recharts distribution become one ruled summary:

- A lead statement reports total PRs and the combined attention queue.
- Five compact counters preserve the canonical readiness buckets in their existing order.
- Critical and suspicious signals remain explicit textual annotations.
- Average age remains supporting evidence rather than a peer to actionable readiness states.

No score, trend, recommendation, prioritization model, or new derived persistence is introduced.

### Readiness Ledger

Each non-empty readiness bucket becomes an editorial ledger section:

- The section heading retains its existing label, hint, count, and semantic tone.
- Repository and PR number form a compact locator above or beside the title.
- The title is the primary row text and may wrap to two lines.
- CI, conflict, draft, discussion count, age, author, and alert state form one readable evidence line.
- Available actions remain contextual and appear as a separate action rail.
- `열기` stays available for every PR; proposal actions keep existing disabled and pending behavior.

The bucket order and membership continue to come directly from the existing backend result.

## Component and State Boundaries

`PrRadarView` remains the page-level data and mutation orchestrator. It owns projects, polling,
settings, Codex availability, scroll restoration, errors, and navigation outcomes.

- A pure summary model groups items and derives display-only counts.
- A render-only merge-desk component owns the header, readiness brief, state messaging, and ledger.
- A render-only row component receives one typed action object rather than ten independent
  parameters.
- Existing React Query hooks and mutation payloads remain in `PrRadarView`.
- The existing chart module is not changed; PR Radar simply stops loading it.

No backend, IPC, binding, SQLite, query-key, polling cadence, store, or global design-token change is
in scope.

## Loading, Empty, and Error States

- **Initial polling:** the full merge-desk header and a bounded explanatory loading state are visible;
  the page never presents an unexplained blank canvas.
- **Background polling:** existing items remain visible and the header reports refresh progress.
- **No projects:** explain that a GitHub-backed project must be configured.
- **No open PRs:** explain that enabled repositories currently have no displayable PRs.
- **Partial polling error:** keep successful project results visible and show the joined error message
  above the ledger.
- **Action errors:** code review, CI triage, and escalation errors remain separate and textual.

The renderer invents no cached result or success state.

## Responsive and Scroll Contract

- `.pr-scroll` remains the only vertical page scroll owner.
- The content measure stays bounded near the existing 1120px desktop width.
- At wide widths, the lead summary and readiness counters share one aligned evidence band.
- Below 900px, the summary stacks before the ledger without changing reading order.
- At 750x480, the title, polling state, attention statement, and first ledger section are reachable in
  one natural vertical flow.
- Long Korean and English repository names, titles, authors, errors, and action labels wrap or truncate
  within their own columns and never create page-level horizontal overflow.
- Row actions wrap as a group below evidence rather than squeezing the title.

## Accessibility

- The page exposes one visible `h1`; readiness brief and buckets use ordered headings.
- Summary metrics use an accessible list with explicit labels and values.
- Loading, empty, and failure messages remain readable text rather than color-only signals.
- Alert, CI, conflict, and draft states retain visible labels or accessible titles.
- Action buttons retain visible text, native disabled states, and current explanatory titles.
- Focus styles continue to come from the shared shadcn button primitive.

## Invariants Preserved

- PR Radar stays in its own ambient view; no item is moved into the decision matrix automatically.
- Codex actions create bounded proposals or Jobs and preserve their current human-review gates.
- GitHub is never mutated by the redesign.
- Alert thresholds and Inbox intelligence remain backed by current settings and backend results.
- External network calls and credentials remain outside the renderer.
- Polling stays bounded through the current React Query retry and interval configuration.

## Verification

- Add a failing DOM contract for the merge-desk hierarchy, summary labels, bucket order, evidence, and
  contextual action visibility before implementation.
- Add pure summary-model coverage for attention, alert, and average-age derivation.
- Run targeted tests first, then typecheck, lint, full Vitest, build, formatting, and repository
  frontend guards.
- Run changed-scope React Doctor and resolve findings in changed files.
- Build and inspect the actual Tauri app at desktop and 750x480 sizes, including initial polling,
  populated ledger, long mixed Korean/English content, action wrapping, empty state, and partial error
  presentation where the available runtime state permits.
- Obtain fresh independent functional and visual/CJK review passes over the final build and captures.

## Deliberate Deferrals

- No new filter, search, sorting control, detail drawer, bulk action, drag interaction, or GitHub write.
- No new AI summary, generated priority, risk score, trend chart, or recommendation.
- No change to polling, caching, Inbox alert creation, Codex prompts, retry caps, or mutation outcomes.
- No redesign of Jobs, Inbox, project settings, or the global news and agent bars from this page.
