# Weekly Review Briefing Redesign

**Date:** 2026-07-15
**Status:** Approved
**Scope:** Weekly Review frontend composition and component-local styling only

## Context

Weekly Review already contains the data and actions needed for a real review: twelve-week navigation,
OKR check-in nudges, weekly-focus and sprint alignment, Life OS recommendations, throughput, PR
activity, routine adherence, focused time, Life Wheel distribution, work-debt trend, completed work,
reflection tags, and the archive.

The current page renders those capabilities as a long sequence of similarly weighted panels. Week
navigation occupies three fixed horizontal bands, while diagnosis, recommendations, KPI tiles, and
reflection each introduce another card system. At 750x480 the meaningful review content begins below
the fold; at desktop width the user sees substantial navigation chrome before the actual weekly
story.

The redesign must make the page read like a weekly briefing without changing any query, mutation,
recommendation, audit, archive, or review semantics.

## Chosen Direction: Editorial Weekly Briefing

The page follows the sequence a reviewer actually needs:

1. **Orient** — which week is selected, and how active was it relative to the previous eleven weeks?
2. **Choose direction** — what is the weekly focus, how does it align with the sprint, and what Life OS
   recommendation requires human review?
3. **Read the evidence** — what moved, how consistently routines were kept, where focused time went,
   and whether work debt improved?
4. **Reflect** — what was completed, what had impact or regret, and what should remain archived?

The visual language stays within `DESIGN.md`: white editorial canvas, restrained mono labels,
typographic contrast, hairline rules, and semantic status color. Repeated rounded dashboard cards and
decorative shadow are removed where a section rule communicates hierarchy more clearly.

## Information Architecture

### Briefing Header

The current title bar, week pager, and twelve-week scrubber become one compact header:

- Eyebrow: `REVIEW / WEEKLY BRIEFING`
- Title: `Weekly Review`
- One-line description: evidence first, decisions remain human-reviewed.
- Selected ISO week and date range sit beside previous/next controls.
- `이번 주로` remains available for historical weeks.
- The twelve-week activity scrubber stays horizontally scrollable and retains its selected-week and
  completion-count behavior.

The header remains outside `.wk-scroll`, but its total height is reduced enough that compact windows
show the start of the review body rather than only navigation chrome.

### Direction Block

`SystemDiagnosis` and `LifeOsAdvisorPanel` become one editorial direction region:

- Weekly focus and sprint goal are the primary comparison.
- Alignment status remains explicit text, never color-only.
- Life OS generation remains a user-triggered action.
- Existing recommendations still require explicit accept/replace or dismiss.
- Existing focus audit actions (`완료`, `너무 큼`, `막힘`) remain unchanged.
- The conditional OKR check-in prompt remains the first item in the scroll body when work is pending.

No recommendation is generated or applied automatically.

### Evidence Ledger

The current throughput, PR, batch-time, and routine panels become one ruled evidence strip with four
groups:

- **Flow:** captured, completed, promoted
- **Routine:** percentage plus done/due
- **Pull requests:** new attention and resolved
- **Focused time:** total minutes plus the existing area breakdown

Values are still read directly from `WeeklyReview`. The redesign adds no score, trend inference,
comparison, filter, or persistence.

### Review Body

The body uses two deliberate columns on desktop:

- **Balance and debt:** Life Wheel activity distribution, then work-debt trend.
- **Completion and reflection:** completed work first, then impact/regret reflection and archive.

Completed work precedes reflection because it owns the controls used to tag impact and regret. The
archive stays collapsed by default and retains restore behavior.

## Component and State Boundaries

`WeeklyView` remains the only page-level orchestrator for week navigation, review queries, completed
signals, routine occurrences, OKR prompt derivation, and scroll restoration.

- `WeekNavigator` remains a render-only pager but adopts the compact briefing-header treatment.
- `WeekScrubber` preserves its twelve-week data and horizontal scroll behavior.
- `SystemDiagnosis` and `LifeOsAdvisorPanel` keep their existing query and mutation seams; only their
  surrounding presentation changes.
- `LifeWheelRadar`, `DebtTrend`, `CompletedList`, `ReflectionRank`, and `ArchiveAccordion` keep their
  current data and actions.
- A view-local evidence component may be extracted only to keep `WeeklyView` below the repository's
  component-size warning band and to provide a focused DOM-test seam.

No backend, IPC, binding, SQLite, store, or global design-token change is in scope.

## Responsive and Scroll Contract

- `.wk-scroll` remains the single vertical review-body scroll owner.
- The week scrubber remains its own horizontal scroll surface and never creates page-level overflow.
- At wide widths, direction and evidence use aligned editorial grids within the existing 1180px
  measure.
- Below 920px, evidence and review columns stack in reading order.
- At 750x480, the compact header shows title, selected week, pager, and scrubber in a bounded height;
  the scroll body begins with the OKR prompt and direction content.
- Long Korean focus and sprint titles may wrap to two lines instead of ellipsizing essential context.
- Recommendation reasons, area labels, completed titles, and mixed Korean/English strings wrap within
  their own columns without horizontal page overflow.

## States

- **Loading:** existing query-default values remain honest zero/empty placeholders; no invented trend
  or balance is shown.
- **Review error:** the current explicit error message remains above evidence.
- **No weekly focus:** direction states `선택된 주간 목표 없음` and retains sprint alignment status.
- **No Life OS review:** the panel explains that no review has been generated and keeps `정리` visible.
- **No completed work:** completion and reflection empty states remain distinct.
- **Sparse or empty Life Wheel:** the existing measured/sparse/empty contract remains unchanged.
- **Historical week:** next is bounded, `이번 주로` appears, and all evidence follows the selected
  range.

## Accessibility

- The page has one visible `h1`; direction, evidence, balance, and reflection use ordered section
  headings.
- The evidence strip is labelled as a weekly evidence summary and each metric group has an accessible
  name.
- Week buttons retain explicit `이전 주`, `다음 주`, and completion-count titles.
- Recommendation and audit actions keep visible text and existing disabled states.
- Focus states, alignment, sparse-data notes, and errors are communicated by text rather than color
  alone.
- Native archive disclosure remains keyboard operable.

## Invariants Preserved

- Life OS suggestions remain review-only until a person accepts them.
- No decision rail is automated or widened.
- Weekly aggregates and completed signals remain backed by their current query/SQLite sources.
- External calls, secrets, and tokens remain outside the renderer.
- Navigation stays bounded to the existing twelve-week window.
- Existing OKR prompt behavior remains conditional and minimal.

## Verification

- Add a DOM contract for the briefing hierarchy, evidence labels, and completion-before-reflection
  order.
- Preserve existing Life Wheel empty/sparse/measured tests.
- Run targeted tests first, then typecheck, lint, full Vitest, build, formatting, and repository
  frontend guards.
- Run changed-scope React Doctor and resolve findings in changed files.
- Build and inspect the actual Tauri app at desktop and 750x480 compact sizes, including current week,
  historical-week navigation, the top review body, and lower reflection/archive states.
- Obtain fresh independent functional and visual/CJK review passes over the final build and capture
  set.

## Deliberate Deferrals

- No new AI summary, generated narrative, scoring model, trend comparison, or next-week planner.
- No change to Life OS recommendation generation or audit semantics.
- No new week filters, export, print, sharing, or persistence.
- No redesign of Mission OKR check-in or Routine Tracking from this page.
