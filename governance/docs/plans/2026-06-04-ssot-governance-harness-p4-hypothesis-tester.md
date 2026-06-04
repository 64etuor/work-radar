# P4 Hypothesis Tester Slice 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first L2 hypothesis loop: propose testable hypotheses from curated L1 patterns, run a deterministic local tester, and mark at least one hypothesis `verified` or `refuted` with an auditable markdown trail.

**Architecture:** Keep L2 as markdown-first under `governance/workspace/hypotheses/{testing,archived}`. Add pure parsing/fold/guard code plus one IO shell that reads curated patterns and writes hypothesis markdown; no `decision_*` or L4 writes. The tester is intentionally deterministic in Slice 1: it evaluates commit-scope hotspot hypotheses against the current L0 corpus and records `verified`/`refuted` status in the hypothesis file frontmatter.

**Tech Stack:** TypeScript, gray-matter, Vitest, existing governance event reader and pattern readers.

**Spec:** v1 design `governance/docs/design/2026-05-31-ssot-governance-harness-design.md` §2.1, §3, §8 P4. P4 done criterion: at least one hypothesis is verified/refuted and can feed later decision/principle work.

---

## Scope

Slice 1 supports only the existing L1 pattern kind: `commit_scope_hotspot`.

It does not update `decision-rails.md`, open PRs, call external models, run a daemon, or write `decision_*` events. P5 Meta Observer owns principles evolution later.

## Files

Created:

- `governance/src/hypotheses/types.ts`
- `governance/src/hypotheses/hypothesis.ts`
- `governance/src/hypotheses/write.ts`
- `governance/src/hypotheses/tester.ts`
- `governance/test/hypotheses/hypothesis.test.ts`
- `governance/test/hypotheses/write.test.ts`
- `governance/test/hypotheses/tester.test.ts`

Modified:

- `governance/src/mcp/server.ts`
- `governance/docs/INDEX.md`

## Task 1: Hypothesis Types and Fold

**Files:**

- Create: `governance/src/hypotheses/types.ts`
- Create: `governance/src/hypotheses/hypothesis.ts`
- Test: `governance/test/hypotheses/hypothesis.test.ts`

**Step 1: Write the failing tests**

Test that a markdown hypothesis with frontmatter:

- `id`
- `from_pattern`
- `kind`
- `scope`
- `status`
- `test_method`
- `baseline`
- `threshold`
- `expires`

parses to a `HypothesisRecord`, and that `isTerminalHypothesisStatus("verified"|"refuted"|"archived")` is true while `"testing"` is false.

**Step 2: Run RED**

Run:

```bash
cd governance && pnpm exec vitest run test/hypotheses/hypothesis.test.ts
```

Expected: FAIL, module not found.

**Step 3: Implement**

Add:

- `HypothesisStatus = "testing" | "verified" | "refuted" | "archived"`
- `HypothesisKind = "commit_scope_hotspot_persists"`
- `HypothesisRecord`
- `parseHypothesisMarkdown(raw)`
- `isTerminalHypothesisStatus(status)`

Fail closed on malformed frontmatter by throwing a clear `Error`.

**Step 4: Run GREEN**

Run:

```bash
cd governance && pnpm exec vitest run test/hypotheses/hypothesis.test.ts
```

Expected: PASS.

## Task 2: Markdown Writer

**Files:**

- Create: `governance/src/hypotheses/write.ts`
- Test: `governance/test/hypotheses/write.test.ts`

**Step 1: Write the failing tests**

Use a temp workspace. Assert:

- `serializeHypothesis(record)` writes deterministic YAML + markdown.
- `makeWriteHypothesis(workspaceDir)(record)` writes only under `hypotheses/testing/<id>.md`.
- Running the writer twice with identical content returns `written` then `skipped`.

**Step 2: Run RED**

Run:

```bash
cd governance && pnpm exec vitest run test/hypotheses/write.test.ts
```

Expected: FAIL, module not found.

**Step 3: Implement**

Mirror `patterns/write.ts`:

- Use `gray-matter`.
- Use `mkdir(..., { recursive: true })`.
- Compare existing file content before overwrite.
- Return `"written" | "skipped"`.

Do not write active/archived dirs in Slice 1.

**Step 4: Run GREEN**

Run:

```bash
cd governance && pnpm exec vitest run test/hypotheses/write.test.ts
```

Expected: PASS.

## Task 3: Deterministic Hypothesis Tester

**Files:**

- Create: `governance/src/hypotheses/tester.ts`
- Test: `governance/test/hypotheses/tester.test.ts`

**Step 1: Write failing pure tests**

Given a `commit_scope_hotspot` pattern `{ scope: "governance", evidence_count: 5 }`, generate one testing hypothesis:

- `kind: "commit_scope_hotspot_persists"`
- `from_pattern: <pattern id>`
- `baseline: 5`
- `threshold: 5`
- `status: "testing"`

Given current L0 commit events:

- if the same scope appears `>= threshold`, `evaluateHypothesis` returns `verified`
- if below threshold, returns `refuted`

**Step 2: Run RED**

Run:

```bash
cd governance && pnpm exec vitest run test/hypotheses/tester.test.ts
```

Expected: FAIL, module not found.

**Step 3: Implement pure core**

Add:

- `hypothesisId(patternId)` deterministic id, e.g. `hyp_<sha8(patternId)>`
- `hypothesisFromPattern(pattern, opts)`
- `evaluateHypothesis(hypothesis, events)`

Reuse `parseScope` for commit body scope extraction. Do not inspect non-commit events.

**Step 4: Add IO shell**

Add `runHypothesisTester(deps)`:

- read all events
- read candidate/active patterns
- write new testing hypotheses for supported patterns
- evaluate existing testing hypotheses
- write updated markdown with `verified` or `refuted`

Best effort per hypothesis. No external calls.

**Step 5: Run GREEN**

Run:

```bash
cd governance && pnpm exec vitest run test/hypotheses/tester.test.ts
```

Expected: PASS.

## Task 4: MCP Read/Run Surface

**Files:**

- Modify: `governance/src/mcp/server.ts`
- Test: add `governance/test/mcp/hypotheses.test.ts`

**Step 1: Write failing tests**

Add tests mirroring `test/mcp/patterns.test.ts`:

- Tool surface contains `run_hypothesis_tester`.
- Tool surface contains read-only `hypotheses`.
- Executor role still does not expose verdict tools; P4 tools write only hypotheses markdown and no `decision_*`.

**Step 2: Run RED**

Run:

```bash
cd governance && pnpm exec vitest run test/mcp/hypotheses.test.ts
```

Expected: FAIL until tools are registered.

**Step 3: Implement MCP tools**

Register:

- `run_hypothesis_tester`: one on-demand bounded pass, returns `{ proposed, verified, refuted, skipped }` as text.
- `hypotheses`: read-only list of testing/terminal hypotheses.

Do not add approval/decision/principle tools.

**Step 4: Run GREEN**

Run:

```bash
cd governance && pnpm exec vitest run test/mcp/hypotheses.test.ts
```

Expected: PASS.

## Task 5: Full Verification, Docs, Critic

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

Update `governance/docs/INDEX.md` P4 row with observed test count and status only after gates pass.

**Step 4: Separate critic**

Run an external critic against the diff and v1 P4 requirements. Required verdict before marking P4 done: ACCEPT or ACCEPT-with-minors, 0 blockers.

**Step 5: Commit**

Commit locally only:

```bash
git add governance/src/hypotheses governance/test/hypotheses governance/test/mcp/hypotheses.test.ts governance/src/mcp/server.ts governance/docs/INDEX.md
git commit -m "feat(governance): add P4 hypothesis tester slice"
```

## Deferred

- Model-assisted hypothesis generation.
- Time-windowed evaluation over 30/60/90-day outcomes.
- `decision-rails.md` or ADR PR proposals; P5 owns that.
- Archive pruning of stale/expired hypotheses; P6 owns that.
