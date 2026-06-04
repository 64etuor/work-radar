# P5 Meta Observer Slice 1 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first local P5 Meta Observer surface: fold verified L2 hypotheses into a deterministic principle-proposal draft that can later become a human-reviewed PR, without writing L3/L4 files.

**Architecture:** Keep Slice 1 strictly propose-only. Add pure code that reads hypothesis summaries, selects verified evidence, and renders a markdown draft with explicit source links and an external residual for the actual PR/human approval step. Add one MCP read/run surface that returns the draft as text only; it must not write `decision_*`, `docs/areas/decision-rails.md`, ADRs, or `docs/decisions.md`.

**Tech Stack:** TypeScript, Vitest, existing hypothesis readers and Governance MCP server.

**Spec:** v1 design `governance/docs/design/2026-05-31-ssot-governance-harness-design.md` §3 Meta Observer and §8 P5. Full P5 done criterion requires a human-approved INVARIANT change; Slice 1 deliberately stops before PR creation and records that as an external residual.

**Continuation rule:** A commit is a checkpoint, not a stop condition. After this slice passes full verification and critic ACCEPT/ACCEPT-with-minors, re-read `governance/docs/INDEX.md` and continue to the next local-implementable governance slice. Stop only for an explicit user stop, a repeated blocker, or work that requires push/merge/delete/deploy/live GUI/cmux/user credentials.

---

## Scope

Slice 1 supports only `commit_scope_hotspot_persists` hypotheses with `status: "verified"`.

It does not edit `docs/areas/decision-rails.md`, open PRs, write ADRs, write `docs/decisions.md`, call external models, or mint decision verdict events.

## Files

Created:

- `governance/src/meta/types.ts`
- `governance/src/meta/observer.ts`
- `governance/test/meta/observer.test.ts`
- `governance/test/mcp/meta.test.ts`

Modified:

- `governance/src/mcp/server.ts`
- `governance/docs/INDEX.md`

## Task 1: Meta Observer Pure Draft

**Files:**

- Create: `governance/src/meta/types.ts`
- Create: `governance/src/meta/observer.ts`
- Test: `governance/test/meta/observer.test.ts`

**Step 1: Write the failing tests**

Test that:

- no verified hypotheses returns `hasProposal: false` with an explicit reason.
- verified `commit_scope_hotspot_persists` hypotheses render a deterministic markdown draft.
- the draft contains source hypothesis ids, scope, threshold/baseline, and an "External residual" section for PR/human approval.
- multiple verified scopes render as one combined draft with one `## Scope: <scope>` section per scope, sorted by scope then source id.

**Step 2: Run RED**

Run:

```bash
cd governance && pnpm exec vitest run test/meta/observer.test.ts
```

Expected: FAIL, module not found.

**Step 3: Implement**

Add:

- `MetaObservationInput`
- `MetaObservationResult`
- `buildMetaObservation(input)`

The implementation filters to verified hypotheses only, groups by scope, and renders one draft proposal:

- title: `Principle proposal draft: recurring commit-scope hotspots`
- one combined markdown draft, with deterministic per-scope sections
- source ids sorted lexicographically
- no filesystem writes
- no `decision_*` text in the API name or write path

**Step 4: Run GREEN**

Run:

```bash
cd governance && pnpm exec vitest run test/meta/observer.test.ts
```

Expected: PASS.

## Task 2: MCP Read/Run Surface

**Files:**

- Modify: `governance/src/mcp/server.ts`
- Test: `governance/test/mcp/meta.test.ts`

**Step 1: Write failing tests**

Add tests that:

- seed verified/refuted hypothesis markdown and assert the Meta Observer returns a draft only for verified records.
- statically assert the server registers `meta_observe`.
- statically assert the P5 block does not register approval, rejection, choose, ADR, decision log, or principle write tools. Delimit this block from the stable `// ── P5: Meta Observer` anchor to the existing `const AUTHOR_MODEL` anchor.
- statically assert `src/meta/observer.ts` does not import `node:fs`, `node:fs/promises`, or write APIs.

**Step 2: Run RED**

Run:

```bash
cd governance && pnpm exec vitest run test/mcp/meta.test.ts
```

Expected: FAIL until `meta_observe` is registered.

**Step 3: Implement MCP tool**

Register:

- `meta_observe`: one on-demand bounded local pass, returns `{ hasProposal, reason?, markdown? }` as text.

Use `listHypotheses(WORKSPACE)` as the read source. Do not add any write dependency.
Add a stable `// ── P5: Meta Observer` comment immediately before the tool so the static no-verdict/no-write-surface test has a durable block boundary.

**Step 4: Run GREEN**

Run:

```bash
cd governance && pnpm exec vitest run test/mcp/meta.test.ts
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

Update `governance/docs/INDEX.md` P5 row with observed test count and note that PR/human approval remains an external residual.

**Step 4: Separate critic**

Run an external critic against the diff and v1 P5 requirements. Required verdict before marking Slice 1 done: ACCEPT or ACCEPT-with-minors, 0 blockers.

**Step 5: Commit checkpoint**

Commit the completed slice:

```bash
git add governance/src/meta governance/test/meta governance/test/mcp/meta.test.ts governance/src/mcp/server.ts governance/docs/INDEX.md
git commit -m "feat(governance): add P5 meta observer slice"
```

Do not push, merge, delete, deploy, or open a PR.

## Deferred / External Residual

- Actual `decision-rails.md` edits require a human-approved PR and are not local-only.
- Meta Observer scheduling is deferred.
- Model-assisted synthesis is deferred.
