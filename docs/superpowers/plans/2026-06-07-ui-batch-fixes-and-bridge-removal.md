# UI Batch Fixes + Hermes Bridge Removal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a batch of news/header/Hermes-panel/skill-registry/settings UI defects and remove the Hermes Telegram-messenger bridge entirely, in one worktree → one PR.

**Architecture:** Six independent workstreams (A news, B header/sprint, C Hermes panel UX, D skill registry, E settings, F bridge removal) each committed separately inside branch `feat/ui-batch-fixes`. Bridge removal (F) and exhaustive grep sweeps run through codex. News ranking stays display-only; bridge removal adds a forward DROP migration (0012 is immutable). No change to the Hermes ACP agent runtime.

**Tech Stack:** Rust (Tauri 2, sqlx/SQLite, feed-rs, reqwest), React + Vite + TypeScript, Tailwind v4 + shadcn/ui, tauri-specta bindings, vitest, cargo test/clippy/fmt.

**Worktree:** `/Users/davidpark/private_project/work-radar-wt/ui-batch-fixes` (branch `feat/ui-batch-fixes`, off `origin/dev` @ `8925f80`). Spec: `docs/superpowers/specs/2026-06-07-ui-batch-fixes-and-bridge-removal-design.md`.

**Conventions (durable):**
- `cargo`/`git commit` need cargo on PATH: `export PATH="$HOME/.cargo/bin:$PATH"` before cargo AND before commit (husky pre-commit runs cargo fmt). Run cargo from `src-tauri/`.
- FE: run `pnpm exec prettier --write <files>` before commit (husky lint-staged). `pnpm typecheck`/`pnpm lint`/`pnpm vitest run` from repo root.
- bindings.ts is generated — never hand-edit; regenerate via `cargo test` (a binding-export test writes it). Drift = CI gate.
- New primary-key ids are `i32` (never specta `i64`).
- Do NOT push. Commit locally; push only on explicit user request.
- Separate critic pass (opus) before declaring a workstream done — no self-approve.

---

## Suggested execution order

F (bridge removal) **last** is tempting but it touches `SettingsView` + bindings, which E also touches — do **F before E** so E edits the already-trimmed SettingsView. Recommended order: **A → B → C → D → F → E**. Each workstream = its own commit(s).

---

## Workstream A — News

### Task A1: Decode HTML entities in news text on ingest

**Files:**
- Investigate: `src-tauri/src/news/rss_generic.rs` (title/summary extraction ~lines 63–103)
- Modify: `src-tauri/src/news/rss_generic.rs`
- Maybe modify: `src-tauri/Cargo.toml` (add `html-escape` if no decoder present)
- Test: inline `#[cfg(test)]` in `rss_generic.rs`

- [ ] **Step 1 — Reproduce the actual garble.** Query the dev DB for offending titles to confirm it is HTML entities vs. mojibake:
  `sqlite3 <dev db> "SELECT title FROM news_items WHERE title LIKE '%&%' LIMIT 10;"`
  (DB path: see `db.rs` / `WORK_RADAR_DEV_DB`.) Record whether you see `&amp;`, `&#39;`, `&#x27;`, `&quot;`, or byte-mojibake. If mojibake (not entities), STOP and re-scope — the fix below targets entities.
- [ ] **Step 2 — Write failing test.** Add a unit test asserting a decode helper turns entity-laden input into clean text:

```rust
#[cfg(test)]
mod entity_tests {
    use super::decode_entities; // helper to add in Step 4
    #[test]
    fn decodes_common_entities() {
        assert_eq!(decode_entities("Rust &amp; C &#39;23 &#x2014; &quot;hi&quot;"), "Rust & C '23 — \"hi\"");
        assert_eq!(decode_entities("plain text"), "plain text");
    }
}
```

- [ ] **Step 3 — Run, verify it fails.** From `src-tauri/`: `cargo test -p <crate> entity_tests -- --nocapture` → FAIL (`decode_entities` undefined).
- [ ] **Step 4 — Implement.** Add `fn decode_entities(s: &str) -> String` using `html_escape::decode_html_entities` (add dep) or a small match for the common set if avoiding a dep is preferred. Apply it to `title` and the summary/description at extraction (line ~71 and the summary field). Decode **once** at ingest so stored text is clean.
- [ ] **Step 5 — Run, verify pass.** `cargo test ... entity_tests` → PASS. Then `cargo clippy --all-targets -- -D warnings` and `cargo fmt`.
- [ ] **Step 6 — Commit.** `fix(news): decode HTML entities in feed titles/summaries on ingest`

### Task A2: Composite "hot" score so hot-only is never empty

**Files:**
- Modify: `src-tauri/src/news/store.rs` (`hot_threshold` 194–202, `hot_only_items` 184–192, `rank_and_trim` 157–182)
- Modify (align badge): `src/lib/newsTicker.ts` (`isHotTrendingNews` ~58–69)
- Test: inline `#[cfg(test)]` in `store.rs`; `src/lib/newsTicker.test.ts` if present

- [ ] **Step 1 — Write failing test.** In `store.rs` tests, assert: given items where NONE have `comment_count`, `rank_and_trim(items, limit, hot_only=true)` returns a non-empty, score-ordered subset (recency-driven), and given mixed engagement the higher-engagement/newer items rank first.
- [ ] **Step 2 — Run, verify fail.** `cargo test ... rank_and_trim` → FAIL.
- [ ] **Step 3 — Implement composite score.** Replace the `comment_count`-only threshold logic with a per-item `hotness(item) -> f64` = normalized recency (newer→higher) + engagement-when-present (log(comment_count or score)) + small keyword boost (configurable keyword list already in the area; reuse if present, else a minimal set). `rank_and_trim` sorts by `hotness` desc; `hot_only=true` returns top-`total_limit`. Keep it pure/display-only (INVARIANT #1 — no writes, no schema change).
- [ ] **Step 4 — Run, verify pass.** `cargo test ... store` → PASS; clippy + fmt clean.
- [ ] **Step 5 — Align FE badge.** Update `isHotTrendingNews` so the 🔥 badge matches the composite notion (or reads a backend-provided flag if you add one — prefer no new field; recompute client-side consistently). Add/adjust `newsTicker.test.ts`.
- [ ] **Step 6 — Run FE tests.** `pnpm vitest run src/lib/newsTicker.test.ts` → PASS; `pnpm typecheck`.
- [ ] **Step 7 — Commit.** `fix(news): redefine hot news as composite recency+engagement score (never empties hot-only)`

---

## Workstream B — Header / Sprint / global header heights

### Task B1: Fix sprint save persistence

**Files:**
- Investigate + Modify: `src/components/.../SprintTimer.tsx` (save handler ~212–223), `src/lib/.../sprint.ts` (~40–49), `src-tauri/src/.../sprint.rs` (~151–156)
- Test: `src-tauri` sprint store test and/or FE handler test

- [ ] **Step 1 — Reproduce + locate root cause (systematic-debugging).** Trace the save end-to-end. Add a temporary `tracing::info!`/`console` at each hop; trigger a save in `tauri dev`; identify where the value is lost (candidates: handler not awaited, debounce unmount-flush dropping the last write, serialization/shape mismatch with the IPC arg, or missing query invalidation so UI shows stale). Write down the exact failing hop before changing code.
- [ ] **Step 2 — Write a failing test at the broken hop.** E.g. Rust: a `sprint.rs` store test that round-trips save→load and asserts equality; or FE: a test that the save mutation is called with the correct payload and invalidates the sprint query.
- [ ] **Step 3 — Run, verify fail.**
- [ ] **Step 4 — Implement the fix** for the identified hop. Surface save errors to the user (toast) instead of silent failure.
- [ ] **Step 5 — Run, verify pass** (cargo and/or vitest). Live re-verify save persists across app restart in `tauri dev` where feasible.
- [ ] **Step 6 — Commit.** `fix(sprint): persist sprint settings + surface save errors`

### Task B2: Center sprint settings labels

**Files:** Modify `src/components/.../SprintTimer.css` (label rule, ~157–167)

- [ ] **Step 1 — Apply centering.** Add `justify-self: center;` (and `text-align: center;` if needed) to the sprint label rule so the 길이/요일/시각 labels sit centered in the grid.
- [ ] **Step 2 — Verify in `tauri dev`** the labels are centered; no layout regression.
- [ ] **Step 3 — Commit.** `fix(sprint): center sprint settings labels`

### Task B3: Unify global header heights

**Files:**
- Audit: all top-level header/toolbar components under `src/components/**` (agent bar, view headers, capture board header, skills/registry header, settings header, Hermes panel header). Use the audit from the spec (Capture Board asymmetric padding; Skills/Hermes lack a height constraint).
- Modify: a shared header token/utility (Tailwind `@theme`/`@utility` per DESIGN.md) + each header to consume it.

- [ ] **Step 1 — Inventory.** `grep -rn "h-\[\|min-h-\|py-\|h-1[0-4]\b" src/components | grep -i "header\|bar\|toolbar"` plus a manual pass; produce a table of each header's current height.
- [ ] **Step 2 — Define the standard.** Pick one header height (match the dominant existing value; check DESIGN.md for an existing header token). Add a shared utility/var if none exists.
- [ ] **Step 3 — Apply** the standard height to each divergent header; fix Capture Board asymmetric padding; add the missing `flex: 0 0 auto` height constraints.
- [ ] **Step 4 — Verify** in `tauri dev` that headers across views visually match. `pnpm lint` (design-tokens) clean for touched files.
- [ ] **Step 5 — Commit.** `style(headers): unify header heights across app surfaces`

---

## Workstream C — Hermes agent panel UX

**Files:** `src/components/hermes/HermesPanel.tsx` (size/position/animation), panel-state defaults (the `hermesPanelStateSet` default + `useHermesPanelState`), possibly `commands/hermes_panel.rs` default geometry.

### Task C1: Tall phone-chat default size
- [ ] **Step 1 — Locate default geometry.** Read `HermesPanel.tsx` + `useHermesPanelState.ts` + `commands/hermes_panel.rs`; find where default w/h are set when `x/y/w/h` are null (after reset / first open).
- [ ] **Step 2 — Set portrait default.** Change default to a vertically-long phone-chat aspect (e.g. ~`380×720`, clamped to viewport). Keep user-dragged sizes intact (only the default/reset changes).
- [ ] **Step 3 — Verify** reset → panel opens tall/portrait.
- [ ] **Step 4 — Commit.** `feat(hermes-panel): tall phone-chat default size`

### Task C2: Centered entrance + correct fade
- [ ] **Step 1 — Default centered position.** When `x/y` are null, center the panel in the viewport (compute from window size) instead of a corner.
- [ ] **Step 2 — Fix fade in/out.** Ensure open/close uses a clean opacity (+ subtle scale/translate) transition with proper mount/unmount (no abrupt pop, no stuck-visible after close). If CSS-only, gate on an `open` class with transition + `transitionend` unmount, or use the existing animation primitive in the codebase.
- [ ] **Step 3 — Verify** open/close animates smoothly and panel appears centered.
- [ ] **Step 4 — Commit.** `feat(hermes-panel): center on open + fix fade in/out`

---

## Workstream D — Skill registry UI

**Files (locate first):** `src/components/SkillsView.tsx`, `src/components/SkillMarkdown.tsx`, audit-log component, URL-install component, vendor/project-workspace hooks (`skillWorkspaces`, `vendor`). Read these before editing — the Explore pass did not return full internals.

### Task D1: Move skill search to top of list pane
- [ ] **Step 1 — Locate** the search input + the list pane component in `SkillsView.tsx`.
- [ ] **Step 2 — Move** the search input to render at the top of the list pane (sticky if the list scrolls).
- [ ] **Step 3 — Verify + Commit.** `ui(skills): move search to top of skill list pane`

### Task D2: Reduce registry header size
- [ ] **Step 1 — Locate** the registry header; reduce its height/typography to match the B3 standard.
- [ ] **Step 2 — Verify + Commit.** `ui(skills): shrink registry header to standard height`

### Task D3: Responsive markdown preview pane
- [ ] **Step 1 — Locate** the markdown preview container (`SkillMarkdown.tsx` + its parent layout).
- [ ] **Step 2 — Fix sizing.** Apply responsive flex layout (`min-h-0`, `flex-1`, `overflow-auto`, fluid width, `max-w` prose) so the preview fills its pane and scrolls instead of overflowing/collapsing.
- [ ] **Step 3 — Verify** at narrow + wide window widths. **Commit.** `ui(skills): responsive markdown preview pane`

### Task D4: Fix audit-log layout
- [ ] **Step 1 — Locate** the audit-log component.
- [ ] **Step 2 — Redesign** its container: constrain width, wrap/truncate long cells, scroll overflow, align columns. Match the design tokens (no raw colors).
- [ ] **Step 3 — Verify + Commit.** `ui(skills): fix audit log overflow + alignment`

### Task D5: URL-install dropdown — presence-gated options + project scope
- [ ] **Step 1 — Locate** where the dropdown options (claude/codex/openclaw/hermes) are built and whether presence is detected. Find the agent-dir detection (there is skill scan/detect code) and the existing project-scope vendor path (`skillWorkspaces` + `vendor`).
- [ ] **Step 2 — Gate by presence.** Build the agent-location options from detected-present agents only (drop OpenClaw when its dir/CLI is absent). Add a test for the option-builder pure function if one exists/can be extracted.
- [ ] **Step 3 — Add project-scope option.** Add an install target "프로젝트 scope": a sub-selector listing **registered projects** (reuse the project/workspace list), installing the URL-fetched skill into that project's `.claude/skills` / `.codex/skills` via the existing vendor command. No new backend table — reuse vendor infra.
- [ ] **Step 4 — Verify** dropdown hides absent agents and project install lands in the chosen repo. **Commit.** `feat(skills): presence-gated install targets + project-scope URL install`

---

## Workstream F — Hermes bridge removal (codex-heavy)

**Goal:** delete the Telegram messenger bridge completely; touch nothing under `hermes_agent/**`, `components/hermes/**`, `HermesView`, `HermesConnectionBlock`, `HermesPanelSettings`, panel shortcut.

**Files to DELETE:**
- `src/components/settings/HermesBridgeBlock.tsx`
- `src/lib/query/hermes.ts` (entire file — all hooks are bridge)
- `src-tauri/src/commands/hermes.rs` (entire file)
- `src-tauri/src/messenger.rs`
- `src-tauri/src/models/messenger.rs`

**Files to EDIT (remove bridge references only):**
- `src/components/SettingsView.tsx` — remove import (`:33`) + mount (`:393`)
- `src/lib/query/index.ts` — remove `hermes.ts` re-exports
- `src/lib/query/persist.ts` — remove bridge query keys
- `src/lib/hermesStartupGuard.test.ts` — remove bridge-specific cases (keep agent cases if any)
- `src-tauri/src/lib.rs` — remove command registrations for `set_hermes_bridge`, `hermes_bridge_status`, `disconnect_hermes`, `send_hermes_message`, `fetch_hermes_messages`, `detect_hermes_chat_id`, `list_hermes_messages`; remove `mod messenger;` and any `mod` for bridge
- `src-tauri/src/commands/mod.rs` — remove `pub mod hermes;` + re-exports
- `src-tauri/src/models/tokens.rs` — remove `TokenKind::HermesBridge` variant + its match arms
- `src-tauri/src/models.rs` — remove `messenger` re-export + bridge type re-exports (`HermesBridgeStatus`, `HermesFetchResult`, `HermesMessage`, `DetectedChat`)
- `src-tauri/src/error.rs` — remove `MessengerError`→`AppError` `From` impl + `MessengerError` enum if defined there
- DB: `src-tauri/migrations/00NN_drop_hermes_bridge.sql` (next free number) → `DROP TABLE IF EXISTS hermes_messages; DROP TABLE IF EXISTS hermes_bridge;`

- [ ] **Step 1 — codex exhaustive reference sweep.** Run codex to enumerate EVERY bridge/messenger reference and confirm each is bridge (not agent). Cross-check: `grep -rniE "hermes_bridge|HermesBridge|set_hermes_bridge|fetch_hermes|detect_hermes_chat|send_hermes_message|list_hermes_messages|messenger" src src-tauri --include=*.rs --include=*.ts --include=*.tsx`.
- [ ] **Step 2 — Delete the 5 files** listed above.
- [ ] **Step 3 — Edit the reference sites** listed above to remove bridge mentions. Verify `messenger.rs`/`models/messenger.rs` have no non-bridge consumers (verified: only `commands/hermes.rs`).
- [ ] **Step 4 — Add the DROP migration** with the next free migration number.
- [ ] **Step 5 — Regenerate bindings + build.** From `src-tauri/`: `cargo test` (regenerates `src/bindings.ts`, drops bridge types) then `cargo clippy --all-targets -- -D warnings` + `cargo fmt`. Expect bindings.ts to lose `HermesBridgeStatus`/`HermesFetchResult`/`HermesMessage`/`DetectedChat` + the 7 bridge commands.
- [ ] **Step 6 — FE build.** `pnpm typecheck` (catches dangling imports) + `pnpm lint` + `pnpm vitest run`.
- [ ] **Step 7 — Dangling guard.** Re-run the Step-1 grep → expect **zero** bridge hits. Confirm `git diff --stat` shows **no** changes under `src-tauri/src/hermes_agent/`, `src/components/hermes/`, `HermesView.tsx`, `HermesConnectionBlock.tsx`, `HermesPanelSettings.tsx`.
- [ ] **Step 8 — Commit.** `feat(hermes)!: remove Telegram messenger bridge (commands, messenger, settings block, tables)`

---

## Workstream E — Settings (do AFTER F so SettingsView is already trimmed)

### Task E1: Agent prompt collapsed by default
- [ ] **Step 1 — Locate** the agent-prompt block in settings (the component that renders the agent system prompt expanded).
- [ ] **Step 2 — Make it a disclosure.** Wrap the prompt content in a collapsed-by-default click-to-expand control (reuse an existing shadcn collapsible/accordion or `details`-style pattern already in the repo). Default closed.
- [ ] **Step 3 — Verify + Commit.** `ui(settings): collapse agent prompt by default (click to expand)`

### Task E2: Fix Hermes connection border-color violation
- [ ] **Step 1 — Locate** the exact offending node in the integrations/Hermes-connection area (design-tokens lint flags it). Run `pnpm lint` to get the precise file:line if the rule reports it.
- [ ] **Step 2 — Replace** the non-token border color with the themed token (`border-border` / `var(--border)`).
- [ ] **Step 3 — Verify** `pnpm lint` clean for the file. **Commit.** `fix(settings): use border token for Hermes connection card`

### Task E3: Move Hermes panel shortcut into central shortcut settings
- [ ] **Step 1 — Locate** the centralized keyboard-shortcut settings section/component.
- [ ] **Step 2 — Move** the Hermes toggle `HotkeyCapture` (currently in `HermesPanelSettings.tsx:35`) into the shortcut-settings section (keep the `hermesGetToggleHotkey`/`hermesSetToggleHotkey` wiring). Leave "패널 위치 리셋" in the Hermes-panel settings block.
- [ ] **Step 3 — Verify** the hotkey edits live in shortcut settings and still register. **Commit.** `ui(settings): move Hermes panel shortcut into central shortcut settings`

---

## Final verification (before declaring done)

- [ ] Full gates from `docs/reference/commands.md`: `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`; `pnpm typecheck` + `pnpm lint` + `pnpm vitest run`; bindings drift 0.
- [ ] `pnpm tauri dev` boots; smoke each touched surface where agent-feasible (native WKWebView click-smoke = user/cmux).
- [ ] **Critic pass (opus, separate context)** over the whole branch: INVARIANTS (`docs/areas/decision-rails.md`) not violated, bridge fully gone, agent panel untouched, news display-only. No self-approve.
- [ ] Update `docs/decisions.md` (one line: hot-news redefinition + bridge removal) and any touched area docs.
- [ ] Do NOT push — report branch state and await explicit push request.

## Self-review notes

- Spec coverage: A1,A2,B1,B2,B3,C1,C2,D1–D5,E1–E3,F all mapped to tasks. ✓
- Investigation-gated tasks (A1 garble confirm, B1 root cause, D* internals, E2 exact node) lead with a locate/reproduce step — intentional, not a placeholder, because executor reads the file before editing.
- Type consistency: bridge type names + command names listed identically in spec §F and plan F. ✓
- Order F-before-E recorded to avoid SettingsView edit collisions. ✓
