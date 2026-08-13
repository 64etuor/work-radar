# Hermes Finance MCP Implementation Plan

> 2026-08-13 보안 정정으로 `WORK_RADAR_MCP_CALLER=hermes` 주입과 외부 서비스 direct-write 분기는
> 폐기됐다. 이 문서는 당시 구현 계획의 스냅샷이며 현재 실행 계약은
> `docs/areas/mcp-server-conventions.md`를 따른다.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show transaction direction in both bookkeeping tables and give in-app Hermes sessions a
working, fully delegated local finance and diet MCP surface.

**Architecture:** Reuse the existing bookkeeping row/table components and command inner functions.
Compose a built-in Work Radar MCP descriptor with optional project Boule descriptors at Hermes
session creation, then register closed-schema finance management handlers on the static MCP router.

**Tech Stack:** React 19, TypeScript, Vitest/happy-dom, Rust, Tauri 2, rmcp, sqlx/SQLite.

---

### Task 1: Direction column regression

**Files:**

- Modify: `src/components/bookkeeping/cards/TransactionReadRow.dom.test.tsx`
- Modify: `src/components/bookkeeping/cards/ReviewQueueCard.dom.test.tsx`
- Modify: `src/components/bookkeeping/cards/TransactionReadRow.tsx`
- Modify: `src/components/bookkeeping/cards/ReviewReadRow.tsx`
- Modify: `src/components/bookkeeping/cards/ApprovedTransactionsCard.tsx`
- Modify: `src/components/bookkeeping/cards/ReviewQueueCard.tsx`

1. Add failing DOM assertions for `구분`, `수입`, and `지출` in both tables.
2. Run the two Vitest files and confirm the assertions fail because the visible labels are absent.
3. Add the compact direction cells/headers and adjust review group `colSpan`.
4. Re-run the two tests and confirm they pass.

### Task 2: Built-in Work Radar MCP injection

**Files:**

- Modify: `src-tauri/src/hermes_agent/acp_client.rs`
- Modify: `src-tauri/src/commands/hermes_agent.rs`

1. Add failing unit tests for an unbound session descriptor containing the current Work Radar
   executable, `--mcp-stdio`, `WORK_RADAR_MCP_CALLER=hermes`, and `WORK_RADAR_DEV_DB`.
2. Add a pure descriptor constructor and make project Boule descriptors additive.
3. Pass the app-data-resolved DB path from `ensure_session`; do not derive it from Hermes `HOME`.
4. Run the focused Hermes ACP tests.

### Task 3: Finance management MCP surface

**Files:**

- Create: `src-tauri/src/mcp/tools/bookkeeping_transactions.rs`
- Create: `src-tauri/src/mcp/tools/bookkeeping_transactions/types.rs`
- Create: `src-tauri/src/mcp/tools/bookkeeping_budgets.rs`
- Create: `src-tauri/src/mcp/tools/bookkeeping_recurring.rs`
- Create: `src-tauri/src/commands/bookkeeping/recurring_rules.rs`
- Modify: `src-tauri/src/mcp/tools/mod.rs`
- Modify: `src-tauri/src/mcp/mod.rs`
- Modify: `src-tauri/src/mcp/surface_tests.rs`

1. Extend the locked tool-set test first and confirm it fails.
2. Add closed parameter/DTO types and handlers that reuse bookkeeping transaction, line-item,
   budget, and recurring inner functions.
3. Add focused temporary-DB tests covering update/review/trash/restore, budget list/set/remove,
   recurring rule lifecycle, and terminal posted-occurrence behavior.
4. Run MCP surface, schema, and bookkeeping management tests.

### Task 4: Contract updates and runtime verification

**Files:**

- Modify: `docs/areas/bookkeeping-cfo-contract.md`
- Modify: `docs/areas/mcp-server-conventions.md`
- Modify: `docs/decisions.md`

1. Record the 2026-07-22 user decision granting finance-domain authority through host approval.
2. Update the finance tool inventory and remove stale Hermes-only local-write wording.
3. Run formatting, focused and full frontend/Rust gates, and bindings drift verification.
4. Drive a real stdio MCP initialize/list/call sequence against the built binary.
5. Run `pnpm tauri dev` and manually verify direction labels on ledger and review rows.
