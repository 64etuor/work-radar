# P6 Archive Pruner Slice 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first local P6 archive pruner: safely move terminal or expired L2 hypothesis markdown from `hypotheses/testing` to `hypotheses/archived`.

**Architecture:** Keep Slice 1 hypothesis-only and deterministic. Add a pure planner that classifies archive candidates, then one IO shell that validates ids, creates `archived/`, writes the archived copy, and removes the testing copy only after the archived write succeeds. Add an MCP run/read surface that reports moves; do not touch events, patterns, decisions, ADRs, or principles.

**Tech Stack:** TypeScript, gray-matter, Vitest, existing hypothesis parser/writer patterns.

**Spec:** v1 design `governance/docs/design/2026-05-31-ssot-governance-harness-design.md` §3 Archive Pruner and §8 P6. Full P6 includes long-term stale events/patterns and search-size policy; Slice 1 only closes the now-local expired/terminal hypothesis archive loop.

**Continuation rule:** A commit is a checkpoint, not a stop condition. After this slice passes full verification and critic ACCEPT/ACCEPT-with-minors, re-read `governance/docs/INDEX.md` and continue to the next local-implementable governance slice. Stop only for an explicit user stop, a repeated blocker, or work that requires push/merge/delete/deploy/live GUI/cmux/user credentials.

---

## Scope

Slice 1 archives only files under `governance/workspace/hypotheses/testing/*.md`.

Archive when:

- `status` is `verified`, `refuted`, or `archived`, or
- `expires` is before `today`.

Do not archive active `testing` hypotheses that have not expired. Do not prune patterns/events in Slice 1.
Boundary: `expires === today` is kept; only dates lexicographically `< today` archive.

## Files

Created:

- `governance/src/archive/pruner.ts`
- `governance/test/archive/pruner.test.ts`
- `governance/test/mcp/archive.test.ts`

Modified:

- `governance/src/mcp/server.ts`
- `governance/docs/INDEX.md`

## Task 1: Pure Archive Plan

**Files:**

- Create: `governance/src/archive/pruner.ts`
- Test: `governance/test/archive/pruner.test.ts`

**Step 1: Write the failing tests**

Test that:

- `shouldArchiveHypothesis` returns true for `verified`, `refuted`, `archived`, and expired `testing`.
- it returns false for non-expired `testing`.
- it returns false when `expires === today` and true when `expires` is one day before `today`.
- unsafe ids are rejected before IO.

**Step 2: Run RED**

Run:

```bash
cd governance && pnpm exec vitest run test/archive/pruner.test.ts
```

Expected: FAIL, module not found.

**Step 3: Implement pure core**

Add:

- `shouldArchiveHypothesis(record, today)`
- `assertSafeArchiveId(id)`

Use the existing `isTerminalHypothesisStatus` helper and strict `YYYY-MM-DD` comparison for `expires`.

**Step 4: Run GREEN**

Run:

```bash
cd governance && pnpm exec vitest run test/archive/pruner.test.ts
```

Expected: PASS.

## Task 2: IO Pruner and MCP Surface

**Files:**

- Modify/Create: `governance/src/archive/pruner.ts`
- Modify: `governance/src/mcp/server.ts`
- Test: `governance/test/mcp/archive.test.ts`

**Step 1: Write failing tests**

Use a temp workspace. Seed:

- one `testing` hypothesis that is `refuted`
- one `testing` hypothesis that is expired
- one non-expired `testing` hypothesis

Assert:

- `runArchivePruner(workspace, today)` moves only the first two files to `hypotheses/archived`.
- re-running is idempotent.
- server registers `archive_prune` and `archive_status`.
- the P6 block contains no approval, choose, decision, ADR, principle, event, or pattern write tools.

**Step 2: Run RED**

Run:

```bash
cd governance && pnpm exec vitest run test/mcp/archive.test.ts
```

Expected: FAIL until IO/MCP is implemented.

**Step 3: Implement IO + MCP**

Add:

- `runArchivePruner(workspaceDir, today)`
- `archiveStatus(workspaceDir)`
- MCP tools:
  - `archive_prune`: one bounded local pass
  - `archive_status`: read-only counts

IO rule: write archived copy first, then unlink testing file. Skip malformed files.
Copy raw file bytes into `archived/`; parse only for classification. If `archived/<id>.md` already exists, leave it unchanged and then unlink the testing duplicate so reruns converge without overwriting an older archived artifact. `archive_prune` derives `today` at the MCP boundary from `nowFn().toISOString().slice(0, 10)`.

**Step 4: Run GREEN**

Run:

```bash
cd governance && pnpm exec vitest run test/mcp/archive.test.ts
```

Expected: PASS.

## Task 3: Full Verification, Critic, Commit

**Step 1: Full governance gates**

Run:

```bash
cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run
```

Expected: 0 type errors, full suite green.

**Step 2: Drift gate**

Run from repo root:

```bash
git diff --stat -- src/bindings.ts src-tauri/migrations
```

Expected: empty.

**Step 3: Update docs**

Update `governance/docs/INDEX.md` P6 row with observed test count and deferred pattern/event pruning.

**Step 4: Separate critic**

Run an external critic against the diff and v1 P6 requirements. Required verdict before marking Slice 1 done: ACCEPT or ACCEPT-with-minors, 0 blockers.

**Step 5: Commit checkpoint**

Commit the completed slice:

```bash
git add governance/src/archive governance/test/archive governance/test/mcp/archive.test.ts governance/src/mcp/server.ts governance/docs/INDEX.md
git commit -m "feat(governance): add P6 archive pruner slice"
```

Do not push, merge, delete, deploy, or open a PR.

## Deferred / External Residual

- Pattern/event stale policy is deferred.
- Search-size metrics and long-running schedule are deferred.
- Any live GUI/cmux surfacing is deferred.
