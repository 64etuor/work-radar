# Work Radar 가계부 — Definitive Completeness Implementation Plan

> Status: proposal (planning-only). Synthesized by the lead from two independent expert plans
> (Codex + Claude) produced via `/omc-teams`, then reconciled against the **live code at `dev`**.
> Author pass ≠ review pass: this document is gated by a separate `oh-my-claudecode:critic` pass
> before execution. Push only on explicit user request.
>
> Supersedes the open items implied by the older inventory in
> `docs/plans/2026-06-18-bookkeeping-judgment-pipeline.md` (Phases A–H) and
> `docs/superpowers/specs/2026-06-19-bookkeeping-review-edit-delete-design.md` (Phase G), which are
> **already landed** (see §0).

**Review status (2026-06-24):** independent `oh-my-claudecode:critic` pass = **YES-WITH-NITS** (0 blockers).
Two MAJORs folded in below: (BK-4) bulk-category is best-effort per-item, not one shared tx, because
`override_bookkeeping_category_inner` opens its own tx; (BK-8) reinforcement upserts on the **existing**
`UNIQUE(match_kind, pattern)` (no new triple-unique). Nits (BK-2 field names, BK-3 label-keep, BK-6
`amount_minor`) and the budget-`spent` semantics decision (counts `needs_review`, matching the existing
summary predicate) are reflected in the relevant phases.

---

## 0. Verified current reality (the linchpin — corrects a stale inventory)

The planning brief carried a stale "~60% frontend, edit form/category picker/trash MISSING, four open
bugs" snapshot. **Both planners flagged it, and the lead verified against current `dev` code by
file:line.** The truth:

| Brief claimed                      | Verified in code (`dev`, 2026-06-24)                                                                                                                                                | Status                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| edit form MISSING                  | `TransactionEditForm` `BookkeepingView.tsx:1600` (edits every field)                                                                                                                | **Built**                               |
| category picker MISSING            | `CategorySelect:1503` + `TaxonomyEditFields:1949` (code→label, `__none__`, raw fallback)                                                                                            | **Built**                               |
| trash/restore UI MISSING           | `ApprovedTransactionsCard:962`, `TrashTransactionsCard:1012` + delete/restore hooks                                                                                                 | **Built**                               |
| confidence/reason badges MISSING   | `TransactionMetadata` renders `신뢰도 %` + reason badges + duplicate badge                                                                                                          | **Built**                               |
| bug: approved list unfiltered      | `list_bookkeeping_transactions` SQL `AND deleted_at IS NULL` at `commands/bookkeeping.rs:1109` (+1431/1459/1481)                                                                    | **Fixed**                               |
| bug: re-ingest resets state        | `upsert_…_from_ingest_inner` does not touch `review_status`/`deleted_at`; judgment fields `COALESCE`; regression test `reingest_upsert_preserves_deleted_at_and_review_status:3074` | **Fixed + tested**                      |
| bug: category patch bypasses audit | `update_…_inner` computes `category_changed:1262` → routes through `override_bookkeeping_category_inner:1826` (override row + audit)                                                | **Fixed**                               |
| Phase E cursor sync not wired      | `sync_…_with_provider` reads per-project cursor and builds `after:<cursor>` when no query is pinned; persists on success                                                            | **Wired (backend)** — one FE nit, below |

**Net:** Backend ≈ 100% (7 migrations `0051→0057`; 28 IPC commands; taxonomy/alias/override; line items;
duplicate scoring; sync cursors; audit; 7 Hermes-gated MCP tools). Frontend ≈ 90% (review queue, manual
entry, Gmail sync, recurring, monthly summary, full edit form, taxonomy picker, trash/restore,
confidence/reason badges — all shipped). Money is integer `amount_minor` + ISO `currency` +
`direction` enum.

So "most complete implementation" does **not** mean re-building Phase G. It means: (Track A) close the
few genuine residual gaps in the shipped surface, then (Track B) add the capabilities mature
personal-finance products have — **without** violating the 7 INVARIANTS and preferring the smallest
local change that reaches completeness.

### Genuine residual gaps (verified)

1. **Line-item _editing_ UI missing.** Backend `set_bookkeeping_line_items` / `list_bookkeeping_line_items`
   - the `line_item_sum_mismatch` review reason exist; **no FE component reads/writes splits** (grep
     confirms no FE line-item wiring).
2. **Duplicate candidates not surfaced for resolution.** `find_bookkeeping_duplicate_candidates` exists
   and a duplicate _badge_ shows, but the review row never calls the finder to show score/reason/link
   to the suspected original.
3. **Durable Gmail cursor is inert in normal use.** `emptyGmailSyncDraft().query = "newer_than:90d"`
   (`BookkeepingView.tsx:282`); an explicit query wins over the cursor branch server-side, so the
   correct incremental cursor is never exercised by default.

---

## 1. Scope, goals, non-goals

### Goals

Take 가계부 from "judgment pipeline that stores + reviews" to a **best-in-class, local-first personal
finance product**: finish the review/edit surface (splits, duplicate resolution), make incremental sync
honest, then add budgets, export/interop, reporting, a categorization learning loop, and multi-currency

- light reconciliation — each as one shippable, verifiable concern.

### Non-goals (explicit)

- **No double-entry / chart-of-accounts / debit-credit balancing rewrite.** 가계부 is single-entry by
  design (income/expense `direction`, `amount_minor > 0`). Double-entry rigor is **out of scope**; we add
  only the lightweight statement-balance reconciliation a single-entry app needs (§4 BK-9). A fuller
  accounts/transfers/cleared model is an **ADR-gated escalation** (§Track C), not the default.
- **No bank aggregation / Open Banking / Plaid.** Ingestion stays Gmail + manual + (future) CSV/OCR via
  the existing Rust connectors. No new external network surface.
- **No new auto-decision automation** (INVARIANT #1). Auto-categorization stays a _hint_; a human always
  confirms. Imported rows always enter `needs_review`.
- **No raw-evidence surfacing** (email body / receipt image) in the renderer (CFO contract §1).
- **No renderer-side tokens or network calls.** Tokens stay in the OS keychain; external I/O stays in Rust.
- **No FX-rate network fetch** in the first multi-currency phase (display/segmentation only).
- **No Hermes/Stream-B changes** (cron cadence, MCP cursor get/set tools) — user-driven.

### In scope

Tracks A (BK-1…BK-3) and B (BK-4…BK-9). Track C is explicitly deferred (ADR-gated).

---

## 2. Gap analysis — current vs best-in-class (prioritized)

| Pri | Gap                                                                | Best-in-class reference                               | Phase |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------- | ----- |
| P0  | Line-item split view/edit UI (backend ready)                       | YNAB/Monarch/Actual split transactions                | BK-1  |
| P0  | Duplicate candidate not surfaced for resolution                    | bank-sync dedup UX; mark-duplicate + original link    | BK-2  |
| P0  | Gmail cursor shadowed by FE default query                          | idempotent incremental ingestion (cursor, not window) | BK-3  |
| P1  | No keyboard triage / bulk actions / search-filter on inbox         | YNAB bulk-edit; inbox triage model                    | BK-4  |
| P1  | No export / interop (CSV / QIF / OFX)                              | OFX `FITID`; QIF categories; GnuCash interop          | BK-5  |
| P1  | No budgets / envelopes / month rollover                            | YNAB zero-based; Actual envelope                      | BK-6  |
| P2  | No trends / cash-flow / category-over-time reporting               | Monarch/Copilot reporting                             | BK-7  |
| P2  | Categorization alias-only; no learning loop / low-confidence-first | ML categorization w/ override feedback loop           | BK-8  |
| P2  | Single-currency net only; no light reconciliation                  | Money pattern multi-currency; statement reconcile     | BK-9  |

---

## 3. Architectural patterns to reuse (keeps every phase "smallest local change")

- **IPC:** every command is `#[tauri::command] #[specta::specta] pub async fn … -> Result<T, AppError>`;
  inner logic lives in `…_inner(db: &Db, …)` free fns that the command wraps and that unit tests call
  against a temp DB (existing pattern throughout `commands/bookkeeping.rs`). `cargo test` regenerates
  `src/bindings.ts` (drift = CI gate). **No `i64`** in IPC types → `i32` / `String`; PK ids are `String`.
  Register new commands in `lib.rs` + `src-tauri/capabilities/default.json`.
- **DB:** migrations-only, additive, numbered after `0057`, immutable once applied (sqlx checksum), with
  an idempotent-seed test (news `0019` precedent); soft-delete via `deleted_at`; local SQLite is SSOT;
  short insert/update tx, validation outside the tx.
- **MCP:** Hermes-gated; `#[serde(deny_unknown_fields)]` on every struct incl. nested; tool set locked by
  `registered_tool_set_is_locked` + per-schema snapshot tests; no token/raw-body/network fields; short
  structured JSON out. **Default: no MCP change.**
- **Frontend:** `BookkeepingView.tsx` cards + `src/lib/query/bookkeeping.ts` hooks + `["bookkeeping"]`
  prefix invalidation; shadcn primitives (Input/Select/Button/Textarea/Badge/Card); DESIGN.md Cohere-white
  - `typo-*` tokens (**design-tokens gate is TSX-only** — no hardcoded colors/fonts); React Query
    optimistic updates where a phase calls for it; any new Dialog/Popover/Select honors the Esc/overlay-stack
    contract (cmux Esc smoke).

---

## 4. Phased roadmap

> **Done-criteria are observable commands** (verification SSOT = `docs/reference/commands.md`):
> Rust = `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`;
> Front = `pnpm typecheck` + `pnpm lint` + `pnpm vitest run` + `pnpm build`;
> structural = `git diff --exit-code src/bindings.ts` (drift gate) + design-tokens gate;
> integration = `pnpm tauri dev` boot. **Native WKWebView live smoke = user/cmux** (agents cannot drive
> WKWebView). Each phase ends with an independent `oh-my-claudecode:critic` pass (no self-approve).
> Each phase = **one PR = one concern = ≤1 migration**.

### Phase 0 (pre-flight, not a PR) — re-verify & lock residual coverage

Before any phase: re-verify §0 against `dev` HEAD (the repo moves under sessions). The four shipped fixes
already have a Rust regression test for re-ingest (`:3074`); add the two cheap **frontend** bucket tests
if absent (approved excludes deleted/ignored; trash shows deleted+ignored). This captures Codex's
"prove-before-closing" instinct without a redundant re-test phase. If a fix turns out _not_ present on
HEAD, fold its closure into the relevant phase below.

### BK-1 — Line-item split editing UI (no migration, **zero bindings drift**)

Finishes the shipped surface; backend split CRUD already exists.

- **Deliverables:** editable splits sub-form inside `TransactionEditForm`: list existing items,
  add/remove/reorder (name, amount_minor, quantity, optional `category_code`), a live sum-vs-`amount_minor`
  indicator mirroring the server's `line_item_sum_mismatch` reason; save via `set_bookkeeping_line_items`;
  read via `list_bookkeeping_line_items`. Sum mismatch is a soft review reason, **not** a hard error. Cap
  the splits list (e.g. ≤100 rows) to avoid an unbounded self-DoS.
- **Files:** `src/components/bookkeeping/BookkeepingView.tsx` (new `LineItemEditor` + wire into
  `TransactionEditForm`); `src/lib/query/bookkeeping.ts` (`useBookkeepingLineItems`,
  `useSetBookkeepingLineItems`). No Rust change → no drift.
- **Done:** FE gate green; vitest covers the sum-mismatch indicator + add/remove (pure helper extracted);
  `bindings.ts` unchanged; design-tokens gate green. Live smoke (edit split, watch mismatch badge) = user.

### BK-2 — Duplicate-candidate resolution in the review row (no migration, **zero drift**)

- **Deliverables:** in `TransactionEditForm` (review bucket), a "중복 의심" affordance that **on expand**
  (not per-row, to avoid N DB calls) calls `find_bookkeeping_duplicate_candidates({spent_at, amount_minor,
merchant, source, order_no, payment_no, source_ref, project_id, exclude_transaction_id})` (field names
  per `models/bookkeeping.rs:441` — `spent_at`, not `date`; includes optional `source`) and lists candidates
  with **score + reason chips + a link to the original**; a `중복으로 표시` action wires the existing
  `mark_bookkeeping_duplicate(id, duplicate_of)` (→ `ignored` + `duplicate_of` + audit). Surface
  automatically when `review_reasons` contains `possible_duplicate`.
- **Files:** `BookkeepingView.tsx` (`DuplicateCandidates` panel); `src/lib/query/bookkeeping.ts`
  (`useFindBookkeepingDuplicateCandidates` as an on-demand/lazy queryFn, `useMarkBookkeepingDuplicate`).
  No Rust change → no drift.
- **Done:** vitest covers candidate render + that mark-duplicate invalidates `["bookkeeping"]`; FE gate
  green; `bindings.ts` unchanged. Live smoke (mark dup → row moves to trash as 중복·무시) = user.

### BK-3 — Make the durable Gmail cursor the default path (no migration, ~zero drift)

Backend is correct; the FE default `newer_than:90d` shadows it.

- **Deliverables:** ship `emptyGmailSyncDraft().query = ""` (empty → cursor branch) **while keeping the
  `labels: "가계부"` default** — both the client guard (`BookkeepingView.tsx:528`) and the server guard
  (`bookkeeping.rs:691`) reject a sync that has neither a label nor a query, so the label must stay to
  drive the cursor path. Add a **"전체 다시 스캔(90일)"** escape button that sets `newer_than:90d` for one
  run; show the active cursor (`list_bookkeeping_sync_cursors`) read-only ("마지막 동기화 지점: …"). Add a
  one-line Rust doc comment at `commands/bookkeeping.rs:~722` documenting that an explicit query
  intentionally overrides the cursor (no server behavior change).
- **Files:** `BookkeepingView.tsx` (`GmailSyncCard`, `emptyGmailSyncDraft`); `src/lib/query/bookkeeping.ts`
  (`useBookkeepingSyncCursors`); tiny comment in `commands/bookkeeping.rs`.
- **Done:** FE gate green; vitest: empty query omits `query` in the mutation payload (cursor path);
  "전체 다시 스캔" sets `newer_than:90d`. If the comment is the only Rust change, `fmt`/`clippy` green &
  `bindings.ts` unchanged. Live smoke (two consecutive syncs only scan forward) = user.

### BK-4 — Inbox-style triage: keyboard + bulk actions + search/filter (optional migration 0058)

- **Deliverables:**
  - **Keyboard-first triage** on the 검토 queue: `j/k` move selection, `e` 확정(approve), `x` soft-delete,
    `c` focus category, `/` focus search, `?` help — **gated to the bookkeeping view** (reuse the repo
    hotkey discipline + overlay/Esc contract; never steal global hotkeys).
  - **Bulk actions:** multi-select → bulk approve / bulk soft-delete / bulk set-category via a selection
    bar (reuse the existing multi-select batch-bar pattern).
  - **Search/filter:** client-side filter over the loaded queue (merchant/category/amount/date-range/
    `review_reason`); add server FTS **only if** the queue grows unbounded (see 0058).
  - **Bulk IPC:** `bulk_update_bookkeeping_review_status(ids: Vec<String>, status)` and
    `bulk_set_bookkeeping_category(ids, category_code, subcategory_code, reason)`. Bulk **status** updates
    may share one tx (plain UPDATEs, mirroring the line-item loop at `commands/bookkeeping.rs:~2005` via
    `&mut *tx`). Bulk **category** updates are **best-effort per-item** — call
    `override_bookkeeping_category_inner` once per id (it takes `db: &Db` and opens its own tx + audit row
    at `:1837`, so it cannot join a caller's tx), returning `Vec<BulkItemResult>` exactly like
    `skills/apply.rs::apply_batch_core`. This keeps the override-audit path intact (INVARIANT-safe). `i32` counts.
  - **(Optional) migration 0058** only if a server FTS index is justified by profiling:
    ```sql
    -- 0058_bookkeeping_fts.sql (additive; mirror signals_fts external-content pattern)
    CREATE VIRTUAL TABLE bookkeeping_tx_fts USING fts5(
      merchant, description, note, account,
      content='bookkeeping_transactions', content_rowid='rowid');
    -- + AFTER INSERT/UPDATE/DELETE sync triggers (data-layer-conventions §FTS5) + backfill
    ```
    Prefer client-side filter first; if FTS is added it is **its own PR** (do not bundle with keyboard/bulk).
- **Files:** `BookkeepingView.tsx` (selection state, `useBookkeepingTriageKeys`), new hooks,
  `commands/bookkeeping.rs` (bulk inner fns + commands), `lib.rs`, capabilities, optional `migrations/0058_*.sql`.
- **Done:** Rust `cargo test` (bulk partial-failure vector; audit-per-item; category→override routing),
  clippy/fmt green, `bindings.ts` drift = new additive commands/types only. FE: typecheck/lint green;
  vitest for keyboard reducer + selection + filter predicate (pure fns); `vitest`/`build` green; cmux Esc
  smoke if any overlay added. Live smoke (j/k/e/x, bulk approve) = user.

### BK-5 — Export / interop: CSV + QIF + OFX (no migration)

Local-first → export is read-only Rust, no network. (Import is a deferred follow-up, §Track C.)

- **Deliverables:** Rust serializers returning a string/bytes payload the FE writes via the Tauri
  dialog/fs:
  - `export_bookkeeping_csv(input) -> String` (UTF-8 BOM for Excel/Korean; headers mirror the in-app
    columns: 날짜/시각/자산/분류/소분류/내용/수입·지출/금액/화폐/메모/가맹점/source/sourceRef).
  - `export_bookkeeping_qif(input) -> String` (`!Type:Cash`/`!Type:Bank`; QIF uniquely carries
    categories via `L`-tags → preserves taxonomy code+label; splits → `S/E/$`).
  - `export_bookkeeping_ofx(input) -> String` (OFX 1.x SGML `STMTTRN`; `TRNTYPE` from `direction`,
    `DTPOSTED` from `spent_at`(+time), `TRNAMT` signed by direction, `FITID = sha256(source‖source_ref‖id)`,
    `NAME`/`MEMO` sanitized). The stable `FITID` is **forward-insurance** for a future import round-trip
    (import is deferred to Track C); BK-5 ships export only, so no round-trip dedup is expected yet.
  - One `format_minor(amount_minor, currency)` boundary helper (per-currency exponent KRW=0/USD=2;
    banker's rounding **only at display**, never in storage).
- **Files:** new `src-tauri/src/bookkeeping_export.rs` (pure std-only serializers — domain layer per
  ipc-conventions); `commands/bookkeeping.rs` (3 thin wrappers + range/project filter query); `lib.rs`;
  capabilities; `BookkeepingView.tsx` export menu + hooks; write via the Tauri dialog plugin (no new
  network capability).
- **Done:** Rust `cargo test` golden-file tests per format (fixed input → exact bytes; FITID stability;
  KRW exp-0 vs USD exp-2; split rows; income sign), clippy/fmt; bindings additive. FE gate green. Live
  smoke (export opens in Excel/GnuCash) = user.

### BK-6 — Budgets / envelopes with month rollover (migration 0059)

Single-entry-compatible: a budget is a per-category monthly target, not a ledger posting.

- **Schema 0059 (additive):**
  ```sql
  -- 0059_bookkeeping_budgets.sql
  CREATE TABLE bookkeeping_budgets (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,   -- NULL = all-projects
    month TEXT NOT NULL,                                         -- 'YYYY-MM'
    category_code TEXT NOT NULL,                                 -- soft ref to taxonomy (no hard FK)
    limit_minor INTEGER NOT NULL CHECK (limit_minor >= 0),
    currency TEXT NOT NULL DEFAULT 'KRW',
    rollover INTEGER NOT NULL DEFAULT 0 CHECK (rollover IN (0,1)),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE UNIQUE INDEX bookkeeping_budgets_scope_idx
    ON bookkeeping_budgets(COALESCE(project_id,''), month, category_code);
  ```
- **IPC:** `set_bookkeeping_budget` (upsert by scope), `list_bookkeeping_budgets(month, project_id?)`,
  `delete_bookkeeping_budget(id)`, `bookkeeping_budget_status(month, project_id?) -> [{category_code,
label, limit_minor, spent_minor, remaining_minor, rollover_in_minor, pct}]` (spent = `SUM(amount_minor)
WHERE direction='expense' AND review_status!='ignored' AND deleted_at IS NULL` per category;
  `rollover_in` from the prior month's leftover when `rollover=1`). Counts/amounts `i32`; net KRW-scoped.
  - **Semantics decision (auditable):** `spent` deliberately uses the same row predicate as monthly
    expense reporting — `review_status != 'ignored' AND direction='expense' AND deleted_at IS NULL` —
    which **includes `needs_review` rows**. Unlike `bookkeeping_monthly_summary`, budget status buckets
    spend by `category_code` because budgets are keyed by taxonomy code, not display label. So budget
    inclusion agrees with the summary, while the grouping key is intentionally `category_code`. This adopts
    Claude's predicate over Codex's "approved-only" proposal; surface it in the budget UI so users aren't
    surprised.
- **FE:** a 예산 card per category (limit, spent bar, remaining, over-budget state in DESIGN tokens),
  inline set/edit, rollover toggle; in the right rail next to `CategorySummaryCard`.
- **Files:** `migrations/0059_*.sql`, `models/bookkeeping.rs` (`BookkeepingBudget`, `BudgetStatus`),
  `commands/bookkeeping.rs` (+inner fns), `lib.rs`, capabilities; `BookkeepingView.tsx` (`BudgetCard`), hooks.
- **Done:** Rust idempotent-migration test; `cargo test` (upsert by scope; status math
  expense-only/excludes ignored+deleted; rollover; over-budget), clippy/fmt; bindings additive. FE gate +
  vitest for budget-bar math (pure). Live smoke = user.

### BK-7 — Reporting: trends, cash-flow, category-over-time (no migration)

Read-only aggregation commands + a reports surface.

- **IPC:** `bookkeeping_category_trend({project_id?, from_month, to_month, category_code?}) -> [{month,
category_code, label, expense_minor}]`; `bookkeeping_cashflow({project_id?, from_month, to_month}) ->
[{month, income_minor, expense_minor, net_minor}]` — pure SQL aggregation, **bounded** month range
  (cap ≤24 months), expense-only category chart, empty months zero-filled, KRW-net documented.
- **FE:** a 리포트 section (token-styled bars/sparklines; reuse an existing chart primitive if present,
  else a minimal token-styled bar — **no heavy chart dependency without a DESIGN consult**).
- **Files:** `commands/bookkeeping.rs` (+inner fns), `models/bookkeeping.rs`, `lib.rs`, capabilities;
  `BookkeepingView.tsx` (`ReportsSection`), hooks.
- **Done:** Rust `cargo test` (per-month buckets; cash-flow net; range clamp; zero-fill), clippy/fmt;
  bindings additive. FE gate + vitest for the series-shaping pure fn. Live smoke = user.

### BK-8 — Categorization learning loop + low-confidence-first triage (migration 0060)

ML/feedback best practice, made INVARIANT-safe: **deterministic alias reinforcement, not an ML model.**
Stays a _hint_ — the human still confirms.

- **Deliverables:**
  - **Learning loop:** when a user overrides a category (`override_bookkeeping_category_inner`), promote
    a `bookkeeping_category_alias` row (`source='user'`, `match_kind` from the row's merchant or
    `raw_category`, higher confidence), **upserting/strengthening** an existing alias rather than
    duplicating (auditable, no model).
  - **Migration 0060 (additive):** add only the reinforcement columns. Reuse the **existing**
    `UNIQUE(match_kind, pattern)` on `bookkeeping_category_alias` (`migrations/0054:25`) as the upsert
    conflict target — do **not** add a new triple-unique (it would permit two categories per
    (pattern, kind) and defeat dedup).
    ```sql
    -- 0060_bookkeeping_alias_learning.sql
    ALTER TABLE bookkeeping_category_alias ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE bookkeeping_category_alias ADD COLUMN last_used_at TEXT;
    ```
    Reinforcement upsert targets the existing key:
    `INSERT … ON CONFLICT(match_kind, pattern) DO UPDATE SET category_code=excluded.category_code,
confidence=max(confidence, excluded.confidence), hit_count=hit_count+1, last_used_at=…`.
  - **Low-confidence-first:** optional `order_by='confidence_asc'` on the review-queue query so the inbox
    surfaces least-confident / most-flagged rows first (default order unchanged for back-compat).
  - **(Optional) confidence on resolve:** write alias-derived confidence into `field_confidence_json.category`
    so the existing confidence badge reflects categorization certainty.
- **Files:** `migrations/0060_*.sql`, `commands/bookkeeping.rs` (reinforce-on-override; queue order param;
  resolver confidence write), `models/bookkeeping.rs`, tests; FE queue sort toggle in `BookkeepingView.tsx`.
- **Done:** Rust `cargo test` (override → alias reinforced not duplicated; next ingest of same merchant
  resolves to the learned code w/ higher confidence; `order_by` confidence_asc; idempotent migration),
  clippy/fmt; bindings additive. FE gate + vitest for sort toggle. Live smoke = user.
- **INVARIANT #1 care:** the learned alias only sets the `suggestedCategory`/`category_code` _hint_ on
  ingest; rows still enter `needs_review`; never flips `review_status`. Assert in tests + document in the
  CFO contract (`docs/areas/bookkeeping-cfo-contract.md`) in the same PR.

### BK-9 — Multi-currency segmentation + light reconciliation (migration 0061)

Money-pattern multi-currency + single-entry reconciliation. **No FX fetch** (segment/display only);
reconciliation = a statement-balance assertion, not double-entry postings.

- **Deliverables:**
  - **Per-currency summary:** add `by_currency: [{currency, expense_minor, income_minor, net_minor}]` to
    `bookkeeping_monthly_summary` (additive → bindings additive). FE shows per-currency rows when >1
    currency is present (never sum a net across currencies).
  - **Light reconciliation (migration 0061, additive):**
    ```sql
    -- 0061_bookkeeping_reconciliation.sql
    CREATE TABLE bookkeeping_reconciliations (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      account TEXT NOT NULL,                 -- matches transactions.account (free-text today)
      statement_date TEXT NOT NULL,          -- 'YYYY-MM-DD'
      statement_balance_minor INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'KRW',
      reconciled_at TEXT,                    -- NULL until user confirms
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    ```
    `bookkeeping_reconcile_account(input) -> {computed_balance_minor, statement_balance_minor,
difference_minor, matched, unmatched_count}` computes the running balance from non-deleted,
    non-ignored rows for an account up to a date and reports the delta; the user confirms (sets
    `reconciled_at`). Discrepancies are resolved by **adding a manual adjusting transaction** (compensating
    entry) — reconciliation **never rewrites posted rows** (preserves audit).
- **Files:** `migrations/0061_*.sql`, `models/bookkeeping.rs`, `commands/bookkeeping.rs`, `lib.rs`,
  capabilities; `BookkeepingView.tsx` (per-currency rows + a 정산 panel), hooks.
- **Done:** Rust `cargo test` (by_currency split; reconcile delta math; reconciled_at set; idempotent
  migration), clippy/fmt; bindings additive. FE gate + vitest. Live smoke = user.

---

## Track C — ADR-gated escalations (deferred; only on explicit user request)

These are structurally bigger or need a recorded decision (`docs/adr/`). They are **not** in the committed
roadmap; listed so the plan is complete and the deferrals are intentional.

- **Full accounts + transfers + cleared/reconciled lifecycle** (Codex's richer model): `bookkeeping_accounts`
  as first-class entities, `account_id`/`transfer_group_id`/`clearing_status`/`reconciled_at` on
  transactions, transfer modeling that doesn't double-count, statement reconciliation against an account.
  This edges toward double-entry semantics → **needs an ADR** (supersedes BK-9's light model if accepted).
- **CSV / QIF / OFX _import_** (round-trip): preview + column mapping + duplicate scoring + idempotent
  commit to `needs_review`; OFX `FITID` dedup on re-import; optional `bookkeeping_import_batches` staging
  tables. Pairs with BK-5 export.
- **FX-rate fetching** for cross-currency reporting: Rust + keychain + bounded retry; rates as decimal
  strings; **needs an ADR** (new network surface).
- **Separate `bookkeeping_category_rules` table** (Codex Phase 9) if BK-8's alias reinforcement proves
  insufficient (managed suggested/active/disabled rules with provenance) — heavier; adopt only if needed.
- **Encryption-at-rest** (SQLCipher / platform encrypted app-data): **needs an ADR**; migration path must
  preserve the existing DB with a tested restore.

---

## 5. Data-layer changes (additive, numbered after 0057)

| Migration                             | Phase | Shape                                                                                                 | Invariant notes                                              |
| ------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `0058_bookkeeping_fts.sql` (optional) | BK-4  | FTS5 external-content vtable + sync triggers + backfill                                               | only if client filter insufficient; mirror `signals_fts`     |
| `0059_bookkeeping_budgets.sql`        | BK-6  | `bookkeeping_budgets` + unique scope index                                                            | additive; soft ref taxonomy (no hard FK)                     |
| `0060_bookkeeping_alias_learning.sql` | BK-8  | `category_alias` += `hit_count`,`last_used_at` (upsert on **existing** `UNIQUE(match_kind, pattern)`) | additive; existing-wins; no auto-decision; **no new unique** |
| `0061_bookkeeping_reconciliation.sql` | BK-9  | `bookkeeping_reconciliations`                                                                         | additive; assertion only, never rewrites rows                |

All: idempotent-seed test; immutable once applied (sqlx checksum); **one migration per PR**; no table
rebuilds; no destructive ALTER. Renumber to the next free integer at implementation time if another track
lands a migration first. `amount_minor`/counts stay integer minor units; IPC never exports `i64`.

## 6. IPC / MCP changes

**New Tauri commands** (tauri-specta; bindings regen via `cargo test`; drift = additive only):

- BK-4: `bulk_update_bookkeeping_review_status`, `bulk_set_bookkeeping_category`
- BK-5: `export_bookkeeping_csv` / `_qif` / `_ofx`
- BK-6: `set_bookkeeping_budget`, `list_bookkeeping_budgets`, `delete_bookkeeping_budget`, `bookkeeping_budget_status`
- BK-7: `bookkeeping_category_trend`, `bookkeeping_cashflow`
- BK-9: `bookkeeping_reconcile_account` (+ additive `by_currency` on `bookkeeping_monthly_summary`)
- BK-1 / BK-2 / BK-3 add **no** commands (consume existing) → **no drift**.

All: `Result<_, AppError>`; PK ids `String`; counts `i32`; register in `lib.rs` + `capabilities/default.json`.

**MCP surface — default: no change.** Every new command is GUI/IPC read or local write; none belongs on
the Hermes proposal surface, and the tool set is locked. If the user later wants Hermes to _report_
budgets/cash-flow in its digest, a **read-only** `wr_bookkeeping_budget_status` / `wr_bookkeeping_cashflow`
may be added — metadata-only, project-scoped, clamped, `deny_unknown_fields`, no bodies/tokens — as **its
own PR** with the per-schema snapshot + tool-set-lock test + CFO-contract update. **No new write/execute
tool** (proposal-only boundary intact). `bindings.ts` drift gate + `mcp_tool_schema_snapshot` stay the
structural guards.

## 7. Frontend / UX plan

- **Information architecture (extends today's 3-bucket layout):** keep 검토(inbox) / 확정 거래(ledger) /
  휴지통; add 예산(BK-6), 리포트(BK-7), 정산(BK-9) surfaces and an export menu in the page header (BK-5);
  검토 gains keyboard triage + bulk bar + search/filter (BK-4) and least-confident-first sort (BK-8);
  splits + duplicate-resolution live inside `TransactionEditForm` (BK-1/BK-2).
- **States:** every list keeps an `EmptyState`; loading via query `isPending`; errors via
  `pushMutationError` → `IpcError` (traceId preserved). Over-budget / sum-mismatch / unreconciled use
  DESIGN-token state colors (no hardcoded hex — design-tokens gate is TSX).
- **DESIGN.md adherence:** Cohere white editorial; shadcn primitives; `typo-*` utilities; new
  Dialog/Popover/Select honor the Esc/overlay-stack contract (cmux Esc smoke); token-styled charts only.
- **Accessibility:** keyboard triage has a discoverable `?` help; selection uses `role="group"` +
  `aria-selected`; bulk bar reachable by keyboard; inputs keep `htmlFor`/`id` pairing (existing `Field`).
- **Optimistic updates + invalidation:** keep `["bookkeeping"]` prefix invalidation; approve/delete/bulk
  use React Query optimistic update (snapshot → mutate → rollback on error) so triage feels instant;
  summary/trash/budget keys invalidate on settle.

## 8. Testing strategy per layer

- **Rust unit/integration (`cargo test` vs temp DB via `…_inner` fns):** bulk partial-failure vectors +
  per-item audit + category→override routing (BK-4); export golden bytes incl. FITID stability, KRW exp-0,
  split rows, income sign (BK-5); budget upsert-by-scope + expense-only/exclude-ignored status + rollover
  (BK-6); trend/cash-flow bucketing + range clamp + zero-fill (BK-7); alias reinforcement (no-dup) +
  learned-resolve + queue order (BK-8); by_currency split + reconcile delta (BK-9); idempotent-seed test
  per migration.
- **Frontend unit (vitest on extracted pure fns):** line-item sum indicator; duplicate-candidate render;
  empty-query→cursor payload; keyboard reducer + selection + filter predicate; budget-bar math;
  series-shaping; sort toggle. Keep logic in pure helpers so it's DOM-free testable.
- **Integration/structural:** `git diff --exit-code src/bindings.ts` (drift), design-tokens gate,
  `pnpm build`, `pnpm tauri dev` boot; cmux Esc smoke whenever an overlay/menu is added.
- **MCP:** unchanged by default → existing headless stdio round-trip + `mcp_tool_schema_snapshot` +
  `registered_tool_set_is_locked` stay green (proves no surface drift). A new read tool adds its per-schema
  snapshot + updates the lock test.
- **Live smoke (native WKWebView) = user/cmux** every phase (agents can't drive WKWebView).
- **Observed-evidence rule:** done-criteria checkboxes are filled by _running_ the command and pasting
  output; "could not run" ≠ "passed" (AGENTS §Verification).

## 9. INVARIANT compliance (decision-rails.md — all 7)

1. **결정 레일은 사람만.** ✅ BK-8 learning loop only sets a category _hint_; rows still enter
   `needs_review`; no auto-approve/auto-classify. Bulk actions (BK-4) are explicit user actions. **Care:**
   alias reinforcement must never flip `review_status` — assert in tests + document in the CFO contract.
2. **모든 외부 변경은 Acceptance 게이트.** ✅ Every new feature is a **local SQLite** action (budgets,
   export-to-local-file, reconciliation, triage). No new external-service write → no MCP execute/approve
   path. Export writes a local file via the Tauri dialog (user-chosen path = the human decision), not a
   network send.
3. **신호는 dedup upsert.** ✅ Budgets/aliases/reconciliations upsert by stable scope keys
   (`COALESCE(project,'')+month+category`; `(pattern,match_kind,code)`; `account+statement_date`); export
   `FITID` = stable content hash for downstream dedup. Existing ingest dedup unchanged.
4. **매트릭스는 결정 큐(알림 미러 아님).** ✅ Nothing here escalates into the matrix; bookkeeping stays its
   own surface (no auto-escalation, no ambient-status mirroring).
5. **에이전트 잡은 bounded.** ✅ No new agent jobs. Export/aggregation are bounded synchronous DB reads;
   month ranges clamped (BK-7); Gmail sync keeps bounded pagination (BK-3 only changes the _query default_,
   not the bound). No infinite poll.
6. **코드 작업은 격리.** Runtime features N/A; the _implementer_ agents follow `parallel-agent-safety.md`
   — **serial implementer on the shared `commands/bookkeeping.rs` / `models/bookkeeping.rs` / `bindings.ts`**;
   no `isolation:"worktree"` parallel writers on the shared Rust core.
7. **SSOT 분리.** ✅ Local SQLite stays the SSOT; exports are a read projection (not a second source); no
   Notion involvement. Keychain-only tokens unchanged (no new token surface; Gmail uses the existing Rust
   connector). No PII/secret in logs (status+size only).

## 10. Risks, rollback, deferrals

- **Risk — stale-inventory drift (the big one).** Re-implementing shipped work. Mitigation: §0 grounds
  every claim in file:line; the implementer re-verifies against `dev` HEAD before each phase (the repo
  moves under sessions).
- **Risk — bindings drift surprises.** BK-1/2/3 must produce **zero** `bindings.ts` drift; if drift
  appears, a stray type leaked — stop and review.
- **Risk — design-tokens gate (TSX-only).** New cards must use tokens; hardcoded color/font fails the gate.
- **Risk — FTS migration (BK-4 optional).** External-content FTS needs correct sync triggers + backfill;
  mirror `signals_fts` exactly + a body/title match test; prefer client-side filter and skip unless
  profiling demands it.
- **Risk — multi-currency net.** Net across currencies is meaningless; segment by currency, document
  KRW-scoped net, never sum across.
- **Rollback:** every migration is additive (new table or nullable column) → rollback = ignore it (no data
  loss). FE phases are local to `BookkeepingView.tsx`/`bookkeeping.ts`. MCP surface unchanged → Hermes
  contract unaffected by default.
- **Intentional deferrals:** see §Track C (full accounts/transfers, import round-trip, FX fetch,
  category-rules table, encryption-at-rest); plus receipt-image/email-body open-on-demand;
  Hermes-side cursor MCP get/set + cadence; bank aggregation; double-entry ledger (explicit non-goal — new
  ADR required).

---

## Appendix A — Best-practices research (cited) and how each informed the plan

- **A1. Money — integer minor units (Money pattern).** Store money as integers in the smallest currency
  unit; never float; round only at boundaries. Confirms 가계부's `amount_minor`(i32)+`currency`+`direction`;
  adds the BK-5 `format_minor` boundary helper; forbids i64 in IPC. — Martin Fowler (Money, P of EAA);
  Modern Treasury "Floats Don't Work for Storing Cents"; Stripe & Square currency docs; ISO 4217.
- **A2. Single- vs double-entry; reconciliation.** Single-entry = one record per transaction (checkbook
  model); double-entry adds chart-of-accounts + debit=credit. Keeps 가계부 single-entry (non-goal) and adds
  only BK-9 balance-assertion reconciliation; full accounts model = ADR (Track C). — Pilot "Double- vs
  Single-Entry"; Modern Treasury "How to Scale a Ledger, Part V"; GnuCash double-entry docs.
- **A3. Categorization — rules + learning loop + confidence.** Blend rules, learning from past
  categorization, and user adjustments (≈50 corrections lift accuracy); score confidence; keep data local.
  → BK-8 deterministic alias reinforcement + low-confidence-first + confidence-on-resolve (no ML model;
  INVARIANT-#1-safe). — DocuClipper; Neontri (ML categorization); Stripe transaction categorization.
- **A4. Idempotent ingestion + dedup.** Idempotency keys collapse retries; dedup on stable business keys
  with bounded windows; handle pending→posted/refunds. Confirms `source_ref` upsert + existing-wins
  re-ingest; BK-3 makes the durable cursor (not a 90-day window) the default; BK-5 FITID dedup. — Plaid
  `/transactions/sync` + transaction states; Airbyte idempotency; STRV "DB Transactions, Lost Updates &
  Idempotency".
- **A5. Export / interop — CSV / QIF / OFX.** OFX = XML/SGML interchange with `FITID` re-import dedup; QIF
  uniquely carries categories/tags; GnuCash prefers QIF/OFX. → BK-5 emits all three. — OFX format guides;
  GnuCash import docs; ofxstatement.
- **A6. Budgets — envelope / zero-based + rollover.** Assign every unit of income a purpose; rollover
  leftover; align with recurring bills. → BK-6 per-category budgets + rollover (spent excludes
  ignored/deleted); existing `bookkeeping_recurring_*` feeds the view. — Actual Budget envelope docs;
  YNAB; U.S. Bank "Types of budgets".
- **A7. Reporting — trends, cash-flow, category-over-time.** Mature apps forecast cash flow and show
  category trends. → BK-7 bounded `category_trend` + `cashflow` + a token-styled reports surface. — Monarch
  vs YNAB; Copilot reporting.
- **A8. Data integrity — append-only audit, compensating entries, soft-delete.** Ledgers favor append-only
  audit; corrections are new dated entries, not silent rewrites. Confirms soft-delete + audit + override
  history; BK-9 documents reconciliation never rewrites posted rows (adjusting entry); BK-4/BK-8 keep
  per-item audit. — Modern Treasury "Ledger Database"; QuickBooks audit log; immutable-audit-trail writeups.
- **A9. Review/triage UX — inbox, bulk edit, splits, optimistic UI.** YNAB multi-select bulk edits + split
  transactions; Monarch fast optimistic UI. → BK-1 (splits), BK-2 (dup resolution), BK-4 (keyboard triage +
  bulk + filter) + optimistic React Query. — YNAB edit/delete & approving-transactions; Monarch vs YNAB UX.

## Appendix B — Phase → migration → command → component quick index

| Phase                        | Migration      | New IPC                                                                  | Key files/components                                                                              |
| ---------------------------- | -------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| BK-1 splits UI               | —              | (none)                                                                   | `LineItemEditor` in `BookkeepingView.tsx`; `useBookkeepingLineItems`/`useSetBookkeepingLineItems` |
| BK-2 dup resolve             | —              | (none)                                                                   | `DuplicateCandidates`; `useFindBookkeepingDuplicateCandidates`/`useMarkBookkeepingDuplicate`      |
| BK-3 cursor default          | —              | (none)                                                                   | `GmailSyncCard`/`emptyGmailSyncDraft`; `useBookkeepingSyncCursors`                                |
| BK-4 triage/bulk             | 0058 (opt FTS) | `bulk_update_bookkeeping_review_status`, `bulk_set_bookkeeping_category` | selection state, `useBookkeepingTriageKeys`, batch bar                                            |
| BK-5 export                  | —              | `export_bookkeeping_{csv,qif,ofx}`                                       | `bookkeeping_export.rs`; export menu                                                              |
| BK-6 budgets                 | 0059           | `set/list/delete_bookkeeping_budget`, `bookkeeping_budget_status`        | `BudgetCard`                                                                                      |
| BK-7 reporting               | —              | `bookkeeping_category_trend`, `bookkeeping_cashflow`                     | `ReportsSection`                                                                                  |
| BK-8 learning loop           | 0060           | (extends override + queue order)                                         | queue sort toggle                                                                                 |
| BK-9 multicurrency+reconcile | 0061           | `bookkeeping_reconcile_account` (+`by_currency` on summary)              | per-currency rows, 정산 panel                                                                     |

---

**Provenance:** synthesized from `/tmp/bk-plan-codex.md` (Codex) + `/tmp/bk-plan-claude.md` (Claude),
reconciled against `dev` by direct file:line verification (§0). Planning-only; no code changed.
