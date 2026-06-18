# Bookkeeping MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the first local bookkeeping slice: manual entries, review queue, monthly/category summaries, audit log, and sanitized sync failure surfacing.

**Architecture:** SQLite remains the local SSOT. Rust owns validation, persistence, audit writes, and sync-error sanitization; the renderer only calls typed specta IPC through TanStack Query. OCR and CSV import remain deferred adapters that will insert into the same review queue. Gmail read now uses the Google OAuth token in Rust, resolves label names to label IDs, fetches bounded candidates, and upserts parsed receipts into the review queue.

**Tech Stack:** Tauri 2, Rust, sqlx SQLite migrations, specta/tauri-specta bindings, React, TanStack Query, Tailwind tokens.

---

### Task 1: Schema

**Files:**

- Create: `src-tauri/migrations/0051_bookkeeping_mvp.sql`
- Modify: `src-tauri/src/db.rs`

**Steps:**

1. Write a failing migration test asserting `bookkeeping_transactions`, `bookkeeping_audit_log`, and `bookkeeping_sync_jobs` exist.
2. Run the focused Rust test and confirm it fails.
3. Add migration `0051_bookkeeping_mvp.sql` with CHECK-constrained enums and indexes.
4. Re-run the focused test and confirm it passes.

### Task 2: Rust Domain + IPC

**Files:**

- Create: `src-tauri/src/models/bookkeeping.rs`
- Create: `src-tauri/src/commands/bookkeeping.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Steps:**

1. Write Rust tests for manual create, review update audit, summary aggregation, and sync error scrubbing.
2. Run focused tests and confirm they fail.
3. Implement minimal commands and helpers.
4. Register commands in the tauri-specta builder.
5. Run `cargo test` to regenerate `src/bindings.ts`.

### Task 3: Frontend View

**Files:**

- Create: `src/lib/query/bookkeeping.ts`
- Create: `src/components/bookkeeping/BookkeepingView.tsx`
- Create: `src/components/bookkeeping/BookkeepingView.css`
- Modify: `src/lib/query/index.ts`
- Modify: `src/store.ts`
- Modify: `src/App.tsx`
- Modify: `src/lib/nav.ts`

**Steps:**

1. Add query hooks for transaction list, create, review update, summary, audit, and sync jobs.
2. Add a dense app-shell bookkeeping view with manual form, review queue, summary, audit, and sync failures.
3. Wire the view into navigation, command palette, and route rendering.

### Task 4: Verification

**Commands:**

- `rtk proxy cargo fmt --manifest-path src-tauri/Cargo.toml --check`
- `rtk proxy cargo test --manifest-path src-tauri/Cargo.toml`
- `rtk proxy cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`

Record any command that cannot run, with the actual reason.

### Task 5: Gmail Receipt Sync Adapter

**Files:**

- Create: `src-tauri/src/gmail/read.rs`
- Modify: `src-tauri/src/gmail/{mod,http}.rs`
- Modify: `src-tauri/src/calendar/oauth.rs`
- Modify: `src-tauri/src/commands/bookkeeping.rs`
- Modify: `src/lib/query/bookkeeping.ts`
- Modify: `src/components/bookkeeping/BookkeepingView.tsx`

**Steps:**

1. Extend Google OAuth scope with `gmail.readonly`.
2. Add a bounded Gmail read provider for labels, message ids, and message bodies.
3. Resolve user-facing label names to Gmail label ids.
4. Parse fetched candidates through the existing bookkeeping receipt parser.
5. Record sanitized per-message failures and a sync completion marker.
