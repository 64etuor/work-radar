# Inbox: routed page → agent-bar accordion tray

**Date:** 2026-06-02
**Branch:** `feat/wire-dangling-features`
**Area:** `docs/areas/frontend-shell.md` (\*View / agent bar / global overlays)
**Status:** design — awaiting implementation

## Problem

The Inbox is currently a **full routed page** (`App.tsx:46` → `<InboxView />`), reached
by navigating away from the current view via the agent-bar bell (`goTo("inbox")`), the
command palette, and a `NAV_ITEMS` entry. Two issues:

1. **Wrong altitude.** Operational alerts are a glanceable side-channel, not a destination.
   Leaving the current view to read two PR/notification alerts is heavyweight. It should
   **expand from the bell button** like a notification tray, not replace the screen.
2. **Over-specified sources.** Code + docs advertise a fixed "6 sources" roster (alerts,
   AI escalations, workflow failures, review requests, reminders, native mirrors) and the
   FE ships empty `Agent`/`Workflow` filter placeholders. Only two producers are real
   (`pr_radar`, `notification`). The roster should not be enumerated up front — sources
   get added incrementally as producers are written.

## Decisions (locked with user, 2026-06-02)

- **Container:** shadcn **Popover anchored to the agent-bar bell button**. Not a page, not
  a drawer. Compact notification-tray feel.
- **Body:** **accordion sections grouped by source**, derived _dynamically_ from the rows
  present (no hardcoded source list). New sources appear as new collapsible sections
  automatically.
- **Scope:** **no new producers.** `pr_radar` + `notification` stay the only live sources.
  Agent-failure / escalation / reminder producers are explicitly _not_ built. The fixed
  source enumeration is removed from code + docs.
- **Invariant:** Inbox stays **display/navigation only** (INVARIANT #1) — rows summarize and
  deep-link, never auto-classify the matrix, enqueue work, or write externally.

## Why this fits the architecture

- **Mirrors the Calendar precedent.** `CalendarDrawer` is opened from a sibling agent-bar
  button via a store flag (`calendarOpen`/`setCalendarOpen`), mounted globally, non-modal,
  Esc/✕ to close with trigger-focus restore. The Inbox tray reuses the same shape, but as a
  Popover (anchored to its trigger) rather than an edge drawer.
- **Overlay-stack contract is free.** `src/components/ui/popover.tsx` (radix-based) already
  stamps `data-wr-overlay-open` on its content and unmounts on close, so `isOverlayOpen()`
  works and the App-shell Esc→`window.hide()` is correctly yielded. radix also restores
  focus to the trigger natively. No bespoke Esc handler needed (unlike `CalendarDrawer`).
- **Controlled open enables palette/keyboard parity.** A store flag `inboxOpen` /
  `setInboxOpen` lets the bell (PopoverTrigger), the command palette, and an optional
  keyboard action all toggle the same tray — exactly the `EXTRA_ACTIONS` pattern calendar
  uses (`nav.ts:169` + `App.tsx:132`).

## Components & changes

### New

- `src/components/inbox/InboxTray.tsx` — the Popover content. Renders:
  - header (title "Inbox" + the existing Unread/Critical counts, compact) + ✕,
  - **accordion sections by source** (collapsed state held in local `useState<Set<string>>`),
  - reuses the existing row UI + actions (read / dismiss / deep-link / GitHub).
  - A small pure helper `groupInboxBySource(items): { source; label; items }[]` (vitest-tested),
    replacing the current severity grouping. Section order: by max severity then unread count.
  - `labelSource` / `inferTargetView` / `parseActionPayload` / `formatDate` move here from
    `InboxView.tsx` (reused as-is). Severity stays a per-row badge/icon.

### Modified

- `src/store.ts` — add `inboxOpen: boolean` + `setInboxOpen(open)`. Remove `"inbox"` from
  the `View` union.
- `src/components/AgentStatusBar.tsx` — wrap the bell (`inboxBtn`, both render branches) in
  `<Popover open={inboxOpen} onOpenChange={setInboxOpen}><PopoverTrigger asChild>…</PopoverTrigger>
<PopoverContent align="end"><InboxTray/></PopoverContent></Popover>`. Bell keeps its unread
  badge; drop the `goTo("inbox")` onClick.
- `src/App.tsx` — remove the `renderedView === "inbox"` branch and the `InboxView` import;
  add the `"inbox"` keyboard action toggle (parity with calendar at `:132`).
- `src/lib/nav.ts` — remove the inbox `NAV_ITEMS` entry; add an `EXTRA_ACTIONS` entry
  `{ key: "inbox", label: "Inbox 열기/닫기" }` **with no `defaultShortcut`** (⌘⇧I is the
  WebView devtools binding — avoid the collision; user can bind one in Settings keymap).
- `src/components/CommandPalette.tsx` — repoint the "Inbox" command (`:100`) and
  `actionForRecent` (`:241`) from `goTo("inbox")` to `setInboxOpen(true)`.
- `src/components/InboxView.tsx` — deleted (logic lifted into `InboxTray`). `InboxView.css`
  → renamed/trimmed to `InboxTray.css` (drop page-chrome: header h1/kicker, source-filter
  toolbar, full-page layout; keep row/list styling).

### Docs

- `src-tauri/src/commands/inbox.rs` — soften the module doc comment (lines 3–5): drop the
  fixed 6-source enumeration; describe Inbox as "local operational alerts + native
  notification mirrors; sources added incrementally." **Code unchanged.**
- `PLAN.md` / `docs/specs/phase-12-20-dogfood-refinement.md` — add a one-line note that the
  Inbox is an agent-bar tray (not a page) with sources added incrementally; do not enumerate
  agent-failure / escalation / reminder as planned inbox sources.
- `docs/decisions.md` — one-line breadcrumb.

### Explicitly NOT touched

- **Migrations are immutable** — `0024_inbox_items.sql`'s comment enumerates sources, but
  sqlx checksums migration file contents; editing it would break startup on existing DBs.
  Leave all migration files alone.
- Backend producers, `inbox_*` IPC commands, `InboxItem` model — unchanged.
- `docs/plans/2026-05-27-workflow-intelligence-goal.md` (parked governance branch) — out of scope.

## Data flow

bell click (or palette / ⌘⇧I) → `setInboxOpen(true)` → radix Popover opens anchored to the
bell → `InboxTray` reads `useInboxItems(null, false)` + `useInboxCounts()` → `groupInboxBySource`
→ collapsible sections → row actions call `useMarkInboxItemRead` / `useDismissInboxItem` /
`goTo(targetView)` / `openExternal(url)`. Esc/✕/outside-click → `setInboxOpen(false)`,
radix restores focus to the bell. No producer or backend change in this flow.

## Error / empty states

- Loading → small skeleton (reuse). Error → inline message + the query error.
- Empty → "현재 처리할 운영 알림이 없습니다" (reuse). With no sources present, the tray shows
  only the empty state — correct, since sources are incremental.

## Testing

- `vitest`: `groupInboxBySource` pure-function tests (single source, multiple sources,
  ordering by severity/unread, empty). Optional: a render test that the tray groups two
  mixed-source items into two sections and collapses/expands.
- `pnpm typecheck` must pass after removing `"inbox"` from `View` (catches every stale
  `goTo("inbox")` / nav reference — that's the safety net for the removal).
- `pnpm lint`, `git diff --exit-code src/bindings.ts` (expect **0 drift** — no IPC change).
- Manual (user/cmux, native WKWebView): bell → tray opens anchored, sections expand/collapse,
  Esc closes + refocuses bell, palette "Inbox" opens tray, board stays interactive behind.

## Risks / rollback

- **Low risk, FE-only + comments.** No schema, no IPC, no producer change.
- Main risk = a missed `goTo("inbox")` or `View` reference → caught by `pnpm typecheck`.
- Rollback = revert the single commit; no migration or data implications.
