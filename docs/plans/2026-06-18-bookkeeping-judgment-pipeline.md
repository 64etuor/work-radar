# Bookkeeping Judgment-Pipeline Plan (P0–P2)

> **For Claude:** REQUIRED SUB-SKILL: superpowers:executing-plans, task-by-task, TDD.
> Each phase = one concern = one migration (max). Verify + **separate critic** (no self-approve)
> at each phase boundary. Push only on explicit user request.

## Goal

Evolve bookkeeping from an amount-storage MVP into a **judgment pipeline** where the CFO Bot
(Hermes) extracts/judges receipt + email + OCR data and Work Radar safely **stores the judgment
+ evidence**: taxonomy-coded categories, income/expense, account, per-field confidence, review
reasons, duplicate pre-check, line items, and per-source sync cursors. Immediate enabling goal:
Hermes can ingest rows shaped like the user's export (날짜/자산/분류/소분류/내용/KRW/수입·지출/메모/화폐).

## Locked decisions (user, 2026-06-18)

1. **Taxonomy** = seeded reference table + code mapping. Store `category_code` + `subcategory_code`
   + preserved `raw_category` (e.g. `🪑 생활용품`). Unmapped → `미분류`. `category_alias` table maps
   merchant/label → code with confidence; aliases refine over time.
2. **Scope** = full P0–P2, phased across PRs.
3. **Income** = `direction` (income/expense). `monthly_summary` returns `totalExpense / totalIncome /
   net`; category chart = expense only.

## Division of work (parallel-agent-safety)

Rust core touches shared files (`models/bookkeeping.rs`, `commands/bookkeeping.rs`, `mcp/mod.rs`,
`bindings.ts`) → **serial implementer**. Genuinely disjoint, parallelizable: the CFO contract doc
(Phase H, docs-only) and frontend (Phase G, after bindings regen). No `isolation:"worktree"`.

## Sample-data → schema mapping (the "모자란 컬럼" target)

| Export | Target column (after this plan) |
|---|---|
| 날짜 `2026/06/18 11:17:52` | `spent_at` (date) + new `spent_at_time` (HH:MM:SS, nullable) |
| 자산 `하나은행` | new `account` |
| 분류 `🪑 생활용품` | new `raw_category` (preserved) + resolved `category_code`/`category` |
| 소분류 | new `subcategory` + `subcategory_code` |
| 내용 | `description` (exists) |
| KRW/금액 | `amount_minor` (exists) |
| 수입/지출 | new `direction` |
| 메모 | `note` (exists) |
| 화폐 | `currency` (exists) |

---

## Phase A — Schema foundation + income-aware summary  (migration 0053) ⟵ unblocks Hermes ingest

**Current-state note (critic BLOCKER-1):** `0052_bookkeeping_payment_recurring.sql` predates this
session (uncommitted WIP from the prior bookkeeping work — may already be applied to a dev DB, so
do NOT edit it). `0053_bookkeeping_judgment_fields.sql` is authored in THIS session and has not been
applied anywhere, so it is safe to edit. Migrations are immutable once applied (sqlx checksum).

**Files:** `migrations/0053_bookkeeping_judgment_fields.sql` (new), `models/bookkeeping.rs`,
`commands/bookkeeping.rs`, `db.rs` (migration-exists test if present).

**0053 — additive ALTERs only (no table rebuild):**
- `direction TEXT NOT NULL DEFAULT 'expense' CHECK (direction IN ('expense','income'))`
- `account TEXT`
- `subcategory TEXT`
- `category_code TEXT`        — soft ref to taxonomy (validated in Rust, no hard FK)
- `subcategory_code TEXT`
- `raw_category TEXT`         — original incoming label, preserved
- `spent_at_time TEXT CHECK (spent_at_time IS NULL OR length(spent_at_time) = 8)`  — HH:MM:SS
- `confidence REAL`           — overall 0..1, nullable (manual = NULL)
- `field_confidence_json TEXT NOT NULL DEFAULT '{}'`  — per-field map
- `review_reasons_json TEXT NOT NULL DEFAULT '[]'`    — [{code, detail}]
- `duplicate_of_transaction_id TEXT REFERENCES bookkeeping_transactions(id) ON DELETE SET NULL`
- `order_no TEXT`, `payment_no TEXT`  — strongest dedup keys (critic MAJOR-1); partial indexes each
- `confidence REAL CHECK (NULL OR 0..1)`
- index `(direction, spent_at DESC)`; partial indexes on `duplicate_of_transaction_id`, `order_no`,
  `payment_no` (each `WHERE ... IS NOT NULL`)

**Duplicate-state decision (avoid CHECK rebuild):** keep `review_status` enum unchanged
(`needs_review/approved/ignored`). A duplicate = `review_status='ignored'` **and**
`duplicate_of_transaction_id IS NOT NULL`. UI/queries treat that combination as "duplicate". A
dedicated enum state is deferred (would require a FK-aware table rebuild; revisit only if needed).

**Model:** extend `BookkeepingTransaction` + `CreateBookkeepingTransactionInput` with the new
fields. `direction` = new `BookkeepingDirection` enum (`Expense`,`Income`). `amount_minor` stays
`> 0` for both directions (direction tags sign; never store negatives). Keep `i32` (specta: no i64).

**Summary (critic MAJOR-2 + MINOR-1):** `BookkeepingMonthlySummary` gains `total_expense_minor`,
`total_income_minor`, `net_minor`, `duplicate_count`. Pinned semantics:
- `total_expense_minor = SUM(amount) WHERE direction='expense' AND review_status != 'ignored'`
- `total_income_minor = SUM(amount) WHERE direction='income' AND review_status != 'ignored'`
- `net_minor = income - expense` (**KRW-scoped** — net only meaningful single-currency; documented)
- category aggregation filters `direction='expense'` (income never appears as a category)
- `total_amount_minor` (legacy alias) **MUST equal `total_expense_minor`** (kept one release; FE
  cutover in Phase G), NOT the old all-rows sum
- `ignored_count` excludes duplicates (`duplicate_of_transaction_id IS NULL`); `duplicate_count`
  counts `review_status='ignored' AND duplicate_of_transaction_id IS NOT NULL`

**Income-row sentinel (critic MAJOR-4):** income rows have no expense taxonomy → `category_code=NULL`;
they keep a non-empty `category` (NOT NULL). The unmapped-sentinel unification (`uncategorized` →
`미분류`) lands in Phase B with the resolver, not Phase A.

**TDD:** migration-exists test; income row stored + summary splits expense/income/net + alias ==
expense (regression lock); category chart excludes income; duplicate vs ignored counts split;
judgment fields round-trip; malformed JSON/time/confidence rejected; manual create still works.

**Done:** `cargo test` + `clippy -D warnings` + `fmt --check`; bindings regen (drift = new
additive fields only). Critic pass.

## Phase B — Taxonomy + alias + override history  (migration 0054)

**Files:** `0054_bookkeeping_taxonomy.sql` (new), `models/bookkeeping.rs`, `commands/bookkeeping.rs`,
new `commands` for taxonomy read + a `resolve_category` helper, register in `lib.rs`.

**Tables:**
- `bookkeeping_category_taxonomy(code PK, parent_code NULL ref self, label, sort_order, active)` —
  seeded: 식비(외식/카페/배달/식료품), 교통(대중교통/택시/주유·충전), 쇼핑(생활용품/의류/전자기기),
  구독·SW, 의료·건강, 주거·관리비, 업무비, 미분류. (top-level have parent_code NULL; subs point up.)
- `bookkeeping_category_alias(id PK, pattern, match_kind CHECK(merchant|raw_label|domain),
  category_code, subcategory_code NULL, confidence REAL, source CHECK(seed|user|agent), created_at)`
- `bookkeeping_category_overrides(id PK, transaction_id ref, from_code, to_code, from_sub, to_sub,
  actor, reason, created_at)` — category override history.

**Resolver (Rust, pure + DB-alias):** `(raw_label, merchant) → (category_code, subcategory_code,
confidence)`. Exact taxonomy-label match → high; alias match → alias.confidence; else `미분류`/0.
Emoji/whitespace-tolerant normalization. Wired into create/upsert so `raw_category` is preserved and
codes resolved when caller omits them. The resolver **tolerates codes not yet in the taxonomy table**
(soft ref, no hard FK) so an in-flight Hermes write with a stale code doesn't fail (critic MINOR-3).
**Sentinel unify (critic MAJOR-4):** migrate the existing `"uncategorized"` default (gmail parser
`bookkeeping.rs:65`, MCP save `mcp/mod.rs`) to a single `미분류` sentinel here.

**IPC:** `bookkeeping_list_taxonomy()`, `bookkeeping_get_category_rules()` (taxonomy+aliases),
`bookkeeping_override_category(transaction_id, category_code, subcategory_code, reason)` → writes
override row + updates txn + audit.

**TDD:** seed idempotent; resolver maps `🪑 생활용품`→쇼핑/생활용품 via alias, unknown→미분류; override
writes history + audit. Critic.

## Phase C — Line items  (migration 0055)

**Files:** `0055_bookkeeping_line_items.sql`, model `BookkeepingLineItem`, save path, IPC list.
- `bookkeeping_transaction_line_items(id PK, transaction_id ref CASCADE, name, amount_minor,
  quantity INTEGER DEFAULT 1, category_code NULL, sort_order)` + index `(transaction_id, sort_order)`.
- Save accepts optional `line_items[]`; sum-check vs `amount_minor` is a **review reason**, not a hard
  reject (CFO judgment may legitimately differ). IPC `bookkeeping_list_line_items(transaction_id)`.
- **TDD:** items round-trip + cascade delete + sum-mismatch surfaces a review reason. Critic.

## Phase D — Duplicate API

**Files:** `commands/bookkeeping.rs`, models.
- `bookkeeping_find_duplicate_candidates(input: {project_id?, date, amount_minor, merchant?,
  order_no?, payment_no?, source_ref?})` → `[{id, score, reasons[]}]`. Fuzzy: exact source_ref →
  1.0; same amount + date within ±N days + merchant token overlap → graded; order/payment number
  exact → high. Bounded `LIMIT`.
- `bookkeeping_mark_duplicate(id, duplicate_of_transaction_id)` → sets `review_status='ignored'` +
  `duplicate_of` + audit. Validates the target exists and `id != target`.
- **TDD:** exact source_ref scores 1.0; amount+near-date+merchant graded; mark sets state+flag+audit;
  self-reference rejected. Critic.

## Phase E — Per-source sync cursor + bounded incremental polling  (migration 0056)

**Files:** `0056_bookkeeping_sync_cursor.sql`, `commands/bookkeeping.rs`, `gmail/*`.
- `bookkeeping_sync_cursors(source, scope_key, cursor_kind CHECK(gmail_history|internal_date),
  cursor_value, updated_at, PK(source, scope_key))`.
- Add to `bookkeeping_sync_jobs`: `scanned_count, imported_count, duplicate_count,
  review_needed_count, failed_count, cursor_before, cursor_after` (counts default 0). **Dedup note
  (critic NIT):** `BookkeepingGmailSyncResult` already carries `scanned/imported/failed` — the job row
  is the durable SSOT; the result struct is the per-call return. Document which is authoritative
  (job row) to avoid two count sources.
- Gmail: prefer incremental query `after:<last_internal_date>` (or historyId when available) instead
  of `newer_than:90d`; bounded page iteration (cap pages); persist `cursor_after` on success;
  failure leaves cursor unchanged → retried next tick. Counts recorded on the job row.
- **TDD:** first run no cursor → full bounded scan + persists cursor; second run uses cursor; failure
  preserves prior cursor; counts populated. Critic.

## Phase F — MCP surface (read tools + save_candidate widening)  (proposal-only invariants intact)

**Files:** `mcp/mod.rs`, schema-snapshot test.
- **Widen `wr_bookkeeping_save_receipt` IN PLACE** (decision pinned — critic ambiguity): add only
  **optional** new params (`direction, account, subcategory, raw_category, category_code,
  subcategory_code, line_items[], confidence, field_confidence, review_reasons[], spent_at_time,
  order_no, payment_no`) so an in-field Hermes sending the old field set still validates
  (additive-optional only; `deny_unknown_fields` makes EXTRA fields fail, new optional are
  backward-compatible). The CFO contract doc (Phase H) + Hermes prompt update in lockstep. Still
  Hermes-gated; still local SQLite write (no external_actions); `deny_unknown_fields` on EVERY nested
  struct (serde doesn't inherit it — `line_items[]`, `field_confidence`, `review_reasons[]` each get
  it); length caps; no raw email body / image / token fields (mcp-server-conventions §6/§7).
- **Read tools** (project-scoped, metadata/sanitized only — no raw bodies, no tokens):
  `wr_bookkeeping_list_recent_transactions`, `wr_bookkeeping_get_transaction`,
  `wr_bookkeeping_list_review_queue`, `wr_bookkeeping_monthly_summary`,
  `wr_bookkeeping_list_sync_jobs`, `wr_bookkeeping_get_category_rules`,
  `wr_bookkeeping_find_duplicate_candidates`, `wr_bookkeeping_mark_duplicate`.
- mark_duplicate is a **local review-queue write** (not an external service write) → Hermes-gated like
  save; non-Hermes callers are **refused** (there is no `ExternalAction` variant for a local review-
  queue write, so "proposal-only" does not apply — mirror `save_receipt`'s direct rejection at
  `mcp/mod.rs:570`). (critic skeptic note.)
- **Tool-set lock (critic MAJOR-3):** add (a) one `*_params_schema_is_closed_and_stable` test per new
  param struct **and every nested struct** (`line_items[]`, `field_confidence`, `review_reasons[]` —
  `deny_unknown_fields` doesn't inherit), and (b) a NEW test asserting the exact registered tool-name
  set (locking that no execute/approve/delete/network/sql tool ever appears). The existing per-struct
  tests do NOT lock the tool set.
- Tool list fixed at startup; update **schema-snapshot test** (§8). No execute/approve/delete; no
  network/shell/sql/path fields. Output = short structured JSON, no long echo of user content.
- **TDD:** headless stdio round-trip (save→list/get/summary, dup find/mark); non-Hermes refused for
  local writes; snapshot updated. Critic (MCP boundary is INVARIANT #1/#2 — careful review).

## Phase G — Frontend review UI + taxonomy picker

**Files:** `src/components/bookkeeping/*`, `src/lib/query/bookkeeping.ts`, `bindings.ts` (regen).
- Review row shows: per-field confidence, review reasons, duplicate candidates (with score/“why”),
  source ref (Gmail message id only — never raw body), account, direction, subcategory.
- Category picker driven by taxonomy (code→label), with `미분류` fallback + raw_category shown.
- Metrics: 지출/수입/순액 (from new summary fields); category chart = expense only.
- Raw email/body/image **not** surfaced (open-on-demand behind explicit permission = deferred).
- **Verify:** `pnpm typecheck/lint/vitest/build`; design-tokens guard. Critic.

## Phase H — CFO Bot hourly-polling contract doc (docs-only, parallelizable)

**File:** `docs/areas/bookkeeping-cfo-contract.md` (+ area-map row).
Documents: input sources; storage schema + field semantics; review criteria (low-confidence →
`needs_review`; sum-mismatch → review reason); category taxonomy + alias rules; duplicate pre-check
contract; **raw sensitive-data prohibition** (no raw email/body/image/token to Work Radar; only
sanitized summary + provenance ref); the save/read MCP tool surface; hourly orchestration loop
(cursor → fetch → dedup precheck → save candidate → human review).

---

## Cross-cutting invariants (decision-rails / mcp / data-layer)

- Schema changes **migrations only**, additive where possible; idempotent-seed test.
- MCP stays **proposal-only** except the documented Hermes-local-write exception; no token/raw-body
  fields; schema snapshot gates the surface.
- Specta: **no i64** in IPC types (counts clamp to u32/i32); `bindings.ts` drift = new additive only.
- `AppError` single envelope; `clippy -D warnings`; logs carry no PII/secret/raw body.
- No self-approve: each phase gets an independent `oh-my-claudecode:critic` pass before it's "done".

## Verification index (per `docs/reference/commands.md`)

Rust: `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`.
Front: `pnpm typecheck` + `pnpm lint` + `pnpm vitest run` + `pnpm build`. Record anything not run.
