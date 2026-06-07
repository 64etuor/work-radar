# UI Batch Fixes + Hermes Bridge Removal — Design

Date: 2026-06-07
Branch: `feat/ui-batch-fixes` (worktree `work-radar-wt/ui-batch-fixes`, off `origin/dev` @ `8925f80`)
Integration: **one branch, one PR** (per-area commits inside for review/rollback clarity).
Execution: codex used heavily for mechanical/exhaustive passes (esp. bridge deletion).

## Problem & Goal

A batch of UI/UX defects and one structural removal across six areas. Each is independent;
they share a worktree and land as a single PR. The riskiest item is the **Hermes bridge**
removal — it must delete the Telegram-messenger bridge *completely* without touching the
in-app **Hermes agent panel** (a separate subsystem that is kept and improved here).

Critical distinction (verified):
- **Hermes AGENT panel** = `src-tauri/src/hermes_agent/**`, `commands/hermes_agent.rs`,
  `commands/hermes_panel.rs`, `src/components/hermes/**`, `src/components/HermesView.tsx`,
  `HermesConnectionBlock`, `HermesPanelSettings`. **KEEP + improve.**
- **Hermes BRIDGE** = Telegram Bot messenger to drive an *external* Hermes:
  `commands/hermes.rs`, `messenger.rs`, `models/messenger.rs`, `HermesBridgeBlock.tsx`,
  all of `lib/query/hermes.ts`, `TokenKind::HermesBridge`, tables `hermes_bridge` /
  `hermes_messages` (migration `0012`). **DELETE entirely.**

## Workstreams

### A. News (`src-tauri/src/news/**`, `src/components/news/**`, `src/lib/newsTicker.ts`)

**A1 — Special characters render garbled.** Root cause: feed text (titles/summaries) is
stored/rendered without HTML-entity decoding; React escapes but does not decode, so
`&amp;` / `&#39;` / numeric entities appear literally. Fix: decode HTML entities **on ingest**
in the Rust fetcher (`rss_generic.rs`) at title/summary extraction, so the stored + rendered
string is clean once. First confirm the actual garbled samples (entities vs. mojibake) before
locking the fix; add a unit test over representative entities.

**A2 — "Hot news" filter empties the ticker.** Root cause: only `reddit_programming`
populates `comment_count`; the other 9 sources are `None`, so `hot_threshold` returns `None`
and `rank_and_trim`/`hot_only_items` filter *everything* out. Fix (chosen): redefine "hot" as
a **composite score** computed in `store.rs` (display-layer ranking — INVARIANT #1 unchanged):
recency + engagement-when-present (comment_count/score) + optional keyword boost. Hot-only
returns the top-N by score and is non-empty whenever items exist. Align the frontend 🔥 badge
(`newsTicker.ts isHotTrendingNews`) with the same notion. Unit tests for the scorer + the
empty-engagement case.

### B. Header / Sprint / global header heights

**B1 — Sprint save doesn't persist.** Path: `SprintTimer.tsx` → `lib/.../sprint.ts` →
`commands.*` → `src-tauri/.../sprint.rs` → SQLite. Root cause to be isolated via systematic
debugging (candidate: write silently dropped / serialization mismatch / missing invalidation).
Fix the persistence and surface save errors instead of failing silently.

**B2 — Sprint settings text placement.** Center the sprint-settings labels (currently
left/misaligned in the grid) — `SprintTimer.css` label rule.

**B3 — Global header height unification.** ~13 top-level headers/toolbars have inconsistent
heights (e.g., Capture Board asymmetric padding; Skills/Hermes headers lack a height
constraint). Define one shared header-height standard (token/utility per DESIGN.md) and apply
it across the headers so they visually match. Skill-registry + settings + view headers included.

### C. Hermes agent panel UX (`src/components/hermes/HermesPanel.tsx`, panel-state)

**C1 — Initial size = tall phone-chat portrait.** Change the panel's default width/height to a
vertically-long aspect (phone-chat feel) for first open / after position reset.

**C2 — Centered entrance + correct fade.** Default position centered; fix the fade in/out so
appear/disappear animate cleanly (no abrupt pop / stuck state). Reference (not a base):
existing `feat/hermes-floating` worktree — we build fresh on `origin/dev`.

### D. Skill registry UI

**D1 — Search at top of the skill *list* pane.** Move the skill search input to the top of the
list pane (not wherever it is now).

**D2 — Smaller registry header.** Reduce the oversized registry header.

**D3 — Responsive markdown preview pane.** The skill markdown preview sizes badly when open;
make the preview container responsive (proper min-h-0/flex/overflow, fluid width).

**D4 — Audit-log layout.** The audit log overflows / is misaligned; redesign its container
(scroll, column widths, wrapping) so it fits and reads cleanly.

**D5 — URL-install dropdown.** (a) Hide agent locations that aren't present (e.g., don't show
**OpenClaw** when not installed) — drive options by detected presence. (b) Add a **project
scope** install option: after fetching from URL, vendor into a **registered project** selected
from the existing project list, using the existing `vendor` / `skillWorkspaces` infra
(`.claude/skills`, `.codex/skills`).

### E. Settings

**E1 — Agent prompt collapsed by default.** The agent's prompt content currently renders
expanded; make it a click-to-expand disclosure (collapsed by default).

**E2 — Hermes connection border-color violation.** The "통합 / Hermes 연결" card uses a
non-token border color (design-tokens lint violation). Replace with the token border
(`border-border` / themed token). Locate the exact offending node during implementation.

**E3 — Move Hermes panel shortcut into central shortcut settings.** The Hermes toggle hotkey
(`HotkeyCapture` in `HermesPanelSettings`) moves into the app's centralized keyboard-shortcut
settings section. Non-shortcut bits (panel position reset) stay with the Hermes-panel block.

### F. Hermes bridge removal (codex-heavy, mechanical + exhaustive)

Delete **only** bridge code; keep the agent panel. Surface to remove:

- **Frontend**: `src/components/settings/HermesBridgeBlock.tsx`; all of
  `src/lib/query/hermes.ts` (every hook is bridge); bridge re-exports in `lib/query/index.ts`
  + `persist.ts`; bridge parts of `lib/hermesStartupGuard.test.ts`; SettingsView import +
  mount (`SettingsView.tsx:33,393`).
- **Rust**: `commands/hermes.rs` (whole file), `messenger.rs`, `models/messenger.rs`, command
  registrations in `lib.rs` + `commands/mod.rs`, `TokenKind::HermesBridge` (+ keychain usage)
  in `models/tokens.rs`, the `MessengerError → AppError` `From` in `error.rs`, and
  `models.rs` re-exports. Bridge types: `HermesBridgeStatus`, `HermesFetchResult`,
  `HermesMessage`, `DetectedChat`.
- **DB**: add a new forward migration `00NN_drop_hermes_bridge.sql` → `DROP TABLE` for
  `hermes_bridge` and `hermes_messages` (0012 is immutable; never edit it).
- **Bindings**: regenerate `src/bindings.ts` via `cargo test` (drift gate must be clean).
- **Tests**: remove/adjust any bridge-referencing tests.

Guard: an exhaustive `grep -i hermes`/`bridge`/`messenger` sweep must show **zero** dangling
bridge references after deletion, and **zero** edits under `hermes_agent/**`,
`components/hermes/**`, `HermesView`, `HermesConnectionBlock`, agent panel shortcut.

## Verification (per `docs/reference/commands.md`)

- Rust: `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`.
- Front: `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`.
- bindings drift gate clean (regen via `cargo test`).
- Live smoke (`pnpm tauri dev`) where agent-feasible; native WKWebView click-smoke = user/cmux.
- INVARIANTS (`docs/areas/decision-rails.md`) checked by a separate reviewer/critic pass
  (no self-approve). News ranking stays display-only (#1). External tokens stay in OS
  keychain — the bridge keychain token is removed with its `TokenKind::HermesBridge` variant.

## Risks / Rollback

- Bridge removal blast radius is wide but mechanical; per-area commit makes it revertible in
  isolation even inside the single PR.
- `messenger.rs` is consumed only by `commands/hermes.rs` (verified) → safe to remove with it.
- Header-height unification is cross-cutting visual; verify each header in `tauri dev`.
- News scorer is display-only; no schema change required for A2 (A1 may add an HTML-decode dep).

## Out of scope

- New news engagement-data collection per source (rejected in favor of composite scorer).
- Any change to the Hermes ACP agent runtime behavior (only panel size/position/animation).
- Reworking the `feat/hermes-floating` branch (reference only).
