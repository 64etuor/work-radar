# Jobs Run Ledger Redesign

**Date:** 2026-07-15
**Status:** Approved
**Scope:** `src/components/jobs/` frontend presentation and view-local derivations only

## Context

Jobs already exposes the Phase 7 execution spine: bounded Echo and Codex runs, live status polling,
kill, logs, cost and duration metadata, and Acceptance proposal panels. The current screen proves those
capabilities, but presents them as a narrow stack of similarly weighted cards. On a desktop canvas the
860px column leaves large unused margins, diagnostics precede the primary Codex action, and repeated
full error strings make recent execution state difficult to scan.

The redesign must improve operational comprehension without changing how a run is created, polled,
killed, persisted, or accepted.

## Chosen Direction: Editorial Operations Ledger

The page becomes a calm operations ledger with three explicit layers:

1. **Orientation** — an editorial page header and compact polling state.
2. **Action** — a primary Codex run composer with environment readiness, followed by secondary
   bounded diagnostics.
3. **Review** — a ruled run ledger that foregrounds status, kind, bounds, cost, duration, logs, and
   approval work without repeating card chrome.

The content measure expands to a maximum of 1180px. The layout remains flat and token-driven in the
project's Cohere white editorial language: hairline rules, typographic hierarchy, restrained status
color, and no gradients or decorative shadow.

## Information Architecture

### Header

- Eyebrow: `AUTOMATION / RUN LEDGER`
- Title: `Jobs · Agent`
- Supporting copy explains that executions are bounded and suggestions remain review-gated.
- The current polling indicator remains visible at the right edge and communicates `실행 추적 중`
  or `유휴`.

### Operational Summary

Four view-local counts are derived from the already loaded `AgentRunView[]`:

- **Active**: `proposed` or `running`
- **Approval**: `awaiting_approval`
- **Failed**: `failed`
- **Completed**: `succeeded`

These are status indicators, not filters or new persistence. They do not change polling or query
ownership.

### Run Composer

- Codex readiness moves into the launcher header so availability is understood before interacting.
- The prompt textarea and `codex 잡 실행` action form the primary control.
- Existing timeout, max-turn, cost-cap, read-only sandbox, and success-reset behavior remain unchanged.
- Echo and Timeout triggers are retained as a clearly labelled `실행 환경 진단` secondary group.
- Trigger errors stay adjacent to the launcher and use the existing semantic danger token.

### Run Ledger

- The ledger receives a section eyebrow, title, total count, and short scanning guidance.
- Each run is an `article` separated by horizontal rules instead of a rounded generic card.
- The first row prioritizes status and kind. Engine and sandbox remain visible but subordinate.
- Bounds, duration, token cost, and dollar cost remain readable as compact mono metadata.
- Kill and log controls remain explicit text actions with icons and accessible names.
- Non-error details are concise summaries. Failed detail is clamped in the row and remains fully
  accessible through a native `details` disclosure labelled `오류 상세`.
- Open logs and Acceptance proposal panels stay directly beneath their owning run.

## Component and State Boundaries

`JobsView` remains the orchestration owner for queries, mutations, prompt state, open-log state,
polling, and scroll restoration. Existing leaves continue to own presentation:

- `JobsHeader` receives derived counts and renders orientation and summary.
- `JobControls` renders the primary composer and secondary diagnostics.
- `JobList` owns loading, empty, section framing, and run iteration.
- `JobCard` becomes a ledger row while preserving logs, kill, and proposal composition.

No new global state, query, IPC command, database field, or design token is introduced.

## Responsive and Scroll Contract

- `.jobs-scroll` remains the single vertical scroll owner beneath the fixed view header.
- At wide widths, the summary is four columns and run metadata/actions use an aligned grid.
- Below 900px, summary and ledger content reflow without horizontal scrolling.
- Below 720px, the header, summary, composer actions, and run actions stack; touch targets remain at
  least 36px where space permits.
- At the supported 750x480 compact window, orientation, summary, launcher, and the start of the ledger
  remain understandable through the single scroll surface.
- Long Korean/English identifiers, engine names, error text, and logs wrap or truncate within their
  own column; they never expand the page width.

## States

- **Loading:** ledger-shaped skeleton rows avoid misreading an initial fetch as empty.
- **Empty:** explains that no runs exist and points to the launcher/diagnostics without adding a new
  CTA implementation.
- **Codex unavailable:** composer remains visibly disabled while Echo, history, kill, and logs work.
- **Trigger error:** error stays next to controls and is announced as status text.
- **Active run:** polling indicator and active summary count update from the existing query lifecycle.
- **Awaiting approval:** the current proposal panel remains inline and retains all Acceptance gates.
- **Failed run:** compact error preview plus full native disclosure prevents repeated error walls.
- **Log open:** the existing pinned-to-bottom behavior and bounded copy feedback are unchanged.

## Accessibility

- Summary values are grouped under a labelled status region.
- The launcher and ledger use section headings and descriptive labels.
- Each run uses an article labelled by status and kind.
- Buttons keep visible text; icon-only semantics are not introduced.
- Failed detail disclosure uses native keyboard-operable `details`/`summary`.
- Focus outlines and semantic token contrast continue to come from existing UI primitives and local
  focus-visible rules.

## Invariants Preserved

- All execution remains bounded by timeout, max turns, cost cap, and explicit kill.
- Codex unavailable remains graceful degradation.
- `agent_runs` remains the source of truth.
- Suggestions remain proposals until the existing Acceptance UI is completed.
- Renderer code performs no new external network or secret operation.
- The redesign does not automate decisions or broaden execution authority.

## Verification

- Add DOM coverage for summary counts, launcher hierarchy, ledger semantics, and failed-detail
  disclosure.
- Run targeted tests first, then frontend typecheck, lint, full Vitest, build, formatting, and repo
  frontend guards.
- Run React Doctor against the changed scope.
- Build and inspect the actual Tauri app at desktop and compact dimensions, including top-of-page,
  failed-row disclosure, and open-log states.
- Obtain fresh independent functional and visual/CJK review passes after the final capture set.

## Deliberate Deferrals

- No status filters, search, pagination, sorting control, or bulk actions.
- No changes to run creation defaults or diagnostic payloads.
- No backend, IPC, database, proposal, or log-polling changes.
- No redesign of the separate Agent Run modal beyond maintaining shared `JobCard` compatibility.
