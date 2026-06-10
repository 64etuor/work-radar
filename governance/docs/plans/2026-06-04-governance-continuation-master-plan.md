# Governance Continuation Master Plan

> **SUPERSEDED (2026-06-10):** this 2026-06-04 queue was overtaken by
> `2026-06-07-boule-v3-live-autonomy-master-plan.md` and
> `2026-06-08-autonomous-coding-master-plan.md`. Kept as historical record — do not
> execute this queue; see `governance/docs/INDEX.md` for the live entry point.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Continue Boule governance work after the P4/P5/P6 Slice 1 landing by taking the next local-implementable residuals in a fixed order.

**Architecture:** Treat commits as checkpoints, not stop conditions. Prefer local, deterministic, markdown/PGlite-backed slices first; record live cmux, GUI, credentials, PR approval, deploy, and long-running scheduler work as external residuals until the user explicitly runs or authorizes those surfaces.

**Tech Stack:** TypeScript, Vitest, gray-matter, PGlite, Governance MCP server, existing `governance/docs/INDEX.md` and v3 master design.

---

## Execution Order

Run this queue top-to-bottom. After each slice:

1. Use TDD: RED -> implementation -> GREEN.
2. Run full governance verification:

   ```bash
   cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run
   ```

3. From repo root, verify no app drift:

   ```bash
   git diff --stat -- src/bindings.ts src-tauri/migrations
   ```

4. Run critic/code-review.
5. Commit the checkpoint.
6. Re-read `governance/docs/INDEX.md` and continue to the next local-implementable row.

Stop only for an explicit user stop, repeated blocker, or work requiring push/merge/delete/deploy/live GUI/cmux/user credentials/human approval.

## Slice 1: P6 Stale Pattern/Event Policy

**Status:** next recommended local slice.

**Goal:** Extend P6 beyond hypothesis archiving with a deterministic stale-policy reader/classifier for pattern/event retention, without deleting or moving L0/L1 files in this slice.

**Files:**

- Modify or create: `governance/src/archive/policy.ts`
- Modify or create: `governance/test/archive/policy.test.ts`
- Modify: `governance/src/archive/pruner.ts` only if sharing types is justified.
- Modify: `governance/src/mcp/server.ts` only for read-only status/proposal surface.
- Modify: `governance/docs/INDEX.md`

**Constraints:**

- No L0 event deletion.
- No pattern deletion/move in Slice 1.
- No scheduler/daemon.
- No `decision_*`, ADR, decision-rails, or principle writes.

**Done Criteria:**

- Tests classify stale patterns/events deterministically by configured age/count policy.
- MCP surface, if added, is read-only or proposal-only.
- `archive_prune` behavior remains hypothesis-only unless a new explicit proposal tool is added.
- Full verification and critic pass.

## Slice 2: P5 Meta Observer Draft Hardening

**Status:** local-implementable after Slice 1.

**Goal:** Make `meta_observe` output more review-ready while keeping it strictly propose-only.

**Files:**

- Modify: `governance/src/meta/observer.ts`
- Modify: `governance/test/meta/observer.test.ts`
- Modify: `governance/test/mcp/meta.test.ts`
- Modify: `governance/docs/INDEX.md`

**Constraints:**

- Do not write `docs/areas/decision-rails.md`, ADRs, or `docs/decisions.md`.
- Do not create PRs automatically.
- Preserve the "External residual" section for human-reviewed PR conversion.

**Done Criteria:**

- Draft includes stable source links/ids, grouped evidence, limitations, and exact external residual.
- Static MCP block tests still prove no verdict/write surface.
- Full verification and critic pass.

## Slice 3: Phase F Incremental Graph Upsert

**Status:** local-implementable candidate; higher blast radius than P6/P5.

**Goal:** Add a deterministic incremental/index-upsert path on top of current PGlite graph index without introducing real Postgres credentials or pgvector embeddings.

**Files:**

- Modify: `governance/src/graph/store.ts`
- Modify: `governance/src/graph/ingest.ts`
- Modify or create: `governance/test/graph/incremental.test.ts`
- Modify: `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md`
- Modify: `governance/docs/INDEX.md`

**Constraints:**

- PGlite only.
- No real Postgres server.
- No keychain credentials.
- No pgvector embeddings in this slice unless a separate plan is written and accepted.

**Done Criteria:**

- Incremental upsert yields the same checksum/projection as full rebuild.
- Existing rebuild equivalence tests stay green.
- Full verification and critic pass.

## Slice 4: Phase I/H Live Smoke Preflight and Runbook Hardening

**Status:** local-implementable only as preflight/runbook; actual live cmux/GUI smoke remains user-run.

**Goal:** Add deterministic preflight checks and clearer runbook output for the existing live residuals.

**Files:**

- Modify: `governance/docs/plans/2026-06-03-boule-v3-phase-i-narrow-auto.md`
- Modify: `governance/docs/plans/2026-06-03-boule-v3-phase-h-control-room-ui.md`
- Modify or create test/code only if a pure config/preflight helper is added.
- Modify: `governance/docs/INDEX.md`

**Constraints:**

- Do not run live cmux/GUI without user action.
- Do not push/merge/deploy.
- Do not require credentials.

**Done Criteria:**

- Next operator can run live smoke from the runbook with explicit env vars, expected output, and failure triage.
- Any added preflight is pure/local and covered by tests.

## External Residual Queue

These remain outside local autonomous implementation unless the user explicitly authorizes the required surface:

- Human-reviewed PR converting P5 draft into L3/L4 changes.
- Live `BOULE_AUTO_MODE=type2` + `BOULE_CONDUCTOR_MODE=live` cmux smoke.
- Control Room GUI smoke in Tauri/WKWebView.
- Real Postgres server/keyring credential wiring.
- pgvector embeddings.
- Long-running archive/search scheduling.
