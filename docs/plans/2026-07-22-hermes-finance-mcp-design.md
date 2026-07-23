# Hermes Finance MCP and Bookkeeping Direction Design

Date: 2026-07-22

## Goal

Make income/expense explicit in the bookkeeping ledger and review queue, and make every in-app
Hermes session able to use Work Radar's diet and finance MCP tools without per-project manual MCP
configuration.

## Decisions

- Ledger and review tables gain a compact `구분` column with a textual `수입` or `지출` badge.
  Amount color remains a secondary cue, not the only cue.
- Every Hermes ACP session receives a `work-radar` stdio MCP descriptor built by Rust from the
  current executable and the app's resolved SQLite path. Project-bound Boule MCP descriptors remain
  additive.
- Finance is a domain-delegation exception like diet. Hermes may create and edit transactions,
  decide review status, soft-delete and restore rows, manage line items and budgets, and manage
  recurring rules and occurrences. The Hermes ACP permission card is the human gate.
- Deletion remains recoverable where the domain supports it: transactions use the existing trash
  path. Budget removal uses the existing application command contract.
- Existing Rust command inner functions remain the single behavior implementation. MCP handlers
  only validate closed inputs and call those functions; no new SQL or schema migration is added.

## MCP Surface

The existing read/capture tools remain. Add management tools for:

- transaction update, review-status decision, trash listing/move/restore, and line-item read/replace;
- budget listing with stable IDs, upsert, and removal;
- recurring rule creation/status changes plus occurrence listing, materialization, posting, and
  status changes. A posted occurrence is terminal so it cannot be detached and posted twice.

The existing `wr_bookkeeping_save_receipt` remains the creation path for agent-observed receipts.
It still enters the review queue, after which the new review-status tool may decide it when Hermes'
host permission has been granted.

## Safety

- All input structs are `deny_unknown_fields` and use bounded strings, counts, dates, enum parsing,
  and positive minor-unit amounts at the existing command boundary.
- No raw SQL, arbitrary file, shell, URL, token, or external payment capability is introduced.
- Finance writes are local SQLite only. External-service proposal/direct-write rules are unchanged.
- Tool-set lock, closed-schema guard, decision-rail allowlist, and stdio round-trip tests must change
  in lockstep with the documented delegation decision.

## Verification

- DOM regression tests prove both tables expose `구분` and visible `수입`/`지출` text.
- ACP configuration tests prove unbound sessions receive Work Radar MCP, project MCP remains
  additive, and the database path/caller marker are pinned.
- MCP tests prove the management tools mutate a temporary SQLite database through existing command
  contracts and keep the input schemas closed.
- A headless `--mcp-stdio` initialize/list/call round trip proves the actual binary surface.
- Tauri dev manual QA verifies ledger and review rows in the rendered application.
