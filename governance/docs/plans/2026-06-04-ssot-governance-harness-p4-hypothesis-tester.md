# P4 Hypothesis Tester Slice 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first L2 hypothesis loop: propose testable hypotheses from curated L1 patterns, run a deterministic local tester, and mark at least one hypothesis `verified` or `refuted` with an auditable markdown trail.

**Architecture:** Keep L2 as markdown-first under `governance/workspace/hypotheses/{testing,archived}`. Add pure parsing/fold/guard code plus one IO shell that reads curated patterns and writes hypothesis markdown; no `decision_*` or L4 writes. The tester is intentionally deterministic in Slice 1: it evaluates commit-scope hotspot hypotheses against the current L0 corpus and records `verified`/`refuted` status in the hypothesis file frontmatter.

**Tech Stack:** TypeScript, gray-matter, Vitest, existing governance event reader and pattern readers.

**Spec:** v1 design `governance/docs/design/2026-05-31-ssot-governance-harness-design.md` §2.1, §3, §8 P4. P4 done criterion: at least one hypothesis is verified/refuted and can feed later decision/principle work.

**Continuation rule:** A commit is a checkpoint, not a stop condition. After this slice passes full
verification and critic ACCEPT, immediately continue to the next local-implementable governance slice
from `governance/docs/INDEX.md`. If that next slice has no implementation plan, write the plan, run a
short plan critic if the slice changes automation/security/decision boundaries, then execute it in the
same session. Stop only for an explicit user stop, a repeated blocker, or work that requires push/merge/
deploy/live GUI/cmux/user credentials.

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

## Task 5: Full Verification, Docs, Critic, Commit

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

**Step 5: Commit checkpoint**

Commit the completed slice:

```bash
git add governance/src/hypotheses governance/test/hypotheses governance/test/mcp/hypotheses.test.ts governance/src/mcp/server.ts governance/docs/INDEX.md
git commit -m "feat(governance): add P4 hypothesis tester slice"
```

This commit is required and allowed. Do not treat it as the end of the goal.

## Task 6: Continue Immediately to the Next Slice

**Purpose:** Prevent the previous failure mode where the agent stopped after a successful critic/commit
or after writing the next plan.

**Step 1: Re-read the current index**

Run:

```bash
sed -n '1,140p' governance/docs/INDEX.md
```

Pick the next row that is both:

- not DONE, and
- local-implementable without push/merge/deploy/live GUI/cmux/user credentials.

Expected after P4 Slice 1: likely P5 Meta Observer or P6 Archive Pruner, unless P4 follow-up is the next
documented critical path.

**Step 2: If the next slice has no plan, create it and keep going**

Create the next plan under `governance/docs/plans/YYYY-MM-DD-<topic>.md` and link it from
`governance/docs/INDEX.md`.

Required plan properties:

- TDD tasks with RED/GREEN commands.
- Full verification command.
- Critic requirement if automation/security/decision-rail behavior changes.
- A **Continuation rule** equivalent to this section.

Commit the plan:

```bash
git add governance/docs/INDEX.md governance/docs/plans/<new-plan>.md
git commit -m "docs(governance): plan <next slice>"
```

Then immediately execute that plan. Do not stop at the planning commit.

**Step 3: If the next slice already has a plan, execute it**

Use `superpowers:executing-plans`. Follow the plan task-by-task:

- write failing tests first,
- verify RED,
- implement minimal code,
- verify GREEN,
- run full suite,
- run critic if required,
- commit,
- return to Task 6 Step 1.

**Step 4: Stop conditions**

Stop only when one of these is true:

- the user explicitly says stop/pause/status-only,
- three consecutive attempts hit the same blocker,
- the remaining next action requires push/merge/delete/deploy/live GUI/cmux/user credentials,
- the index has no remaining local-implementable slice.

When stopping, report the exact blocker or external residual and the last successful commit hash.

## Deferred

- Model-assisted hypothesis generation.
- Time-windowed evaluation over 30/60/90-day outcomes.
- `decision-rails.md` or ADR PR proposals; P5 owns that.
- Archive pruning of stale/expired hypotheses; P6 owns that.
