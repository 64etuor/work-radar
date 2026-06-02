# Review Quorum (§7 ≥2 distinct-model) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete governance design §7 — make the decision gate require a configurable
**quorum of distinct independent reviewer models** (default 1, opt-in to ≥2), and let one
`request_review` run a list of reviewer models to satisfy it.

**Architecture:** A pure fold (`deriveDecisionState`) counts *distinct normalized reviewer
models* (not events) and compares to an injected `quorum`. The server boundary parses
`BOULE_REVIEW_QUORUM` and a `BOULE_REVIEWER_MODELS` list, builds one reviewer closure per
model, and `requestReview` runs them in a batch — recording successes, reporting per-model
failures/skips, never aborting the batch. Default quorum 1 + singular-env fallback keep all
existing behavior, the stub round-trip, and CI unchanged.

**Tech Stack:** Node 20 + TypeScript (ESM, `--experimental-strip-types`), vitest 2, zod 4,
`@modelcontextprotocol/sdk`. Governance is a standalone sidecar **outside** the Tauri/Vite
build graph.

**Spec:** `governance/docs/design/2026-06-01-ssot-governance-harness-review-quorum-design.md`

---

## Critical conventions (read before any task)

- **All commands run from `governance/`.** Test: `pnpm test` (= `vitest run`). Types:
  `pnpm exec tsc --noEmit`.
- **Runtime `src/**` imports use the `.ts` extension** (e.g. `from "./modelId.ts"`).
  **Test files import the `.js` extension** (e.g. `from "../../src/decision/decision.js"`).
  This is intentional (strip-types resolver) — match the file you're editing.
- **`writeEvent` is `wx` (fail-if-exists) with a second-resolution filename**
  (`src/event/writeEvent.ts:13`), and `generateId` stamps to the second
  (`src/event/id.ts:22`). Two events written with the *same* `now` collide on both id and
  filename. The batch in Task 3 **offsets `now` by `i` seconds per iteration** — do not
  remove that offset.
- **Commit from the repo root**, not `governance/`. Prefix `export PATH="$HOME/.cargo/bin:$PATH"`
  (husky pre-commit runs `cargo fmt` + root `tsc`). If the frontend-ownership / classname /
  prettier gates are irrelevant to a docs/governance-only change and pass by hand, a
  `--no-verify` commit is acceptable per project memory.
- **Do NOT push.** Repo-wide directive: push only on explicit user request.
- **Run the type check after every code task** — strip-types means a bad import or signature
  won't fail until tsc runs.

---

## File structure

- **Modify** `src/decision/decision.ts` — `deriveDecisionState` gains a `quorum` param;
  count becomes a distinct-normalized-model `Set`.
- **Modify** `src/decision/reviewer.ts` — add `ReviewerEntry` type + batch result types
  (`RequestReviewResult`, `ReviewFailure`, `ReviewSkip`).
- **Modify** `src/decision/handlers.ts` — `loadState` + `approve`/`conflicts`/`why` thread
  `quorum`; `requestReview` takes `ReviewerEntry[]` and runs the batch.
- **Modify** `src/mcp/server.ts` — parse `BOULE_REVIEW_QUORUM` + `BOULE_REVIEWER_MODELS`,
  `buildReviewers()` returns `ReviewerEntry[]`, `request_review`/`approve`/`conflicts`/`why`
  pass the quorum and the batch result.
- **Modify** `test/decision/decision.test.ts` — distinct-count + quorum cases.
- **Modify** `test/decision/handlers.test.ts` — batch success/partial-fail/skip/quorum cases.
- **Create** `src/mcp/config.ts` — pure `parseQuorum` + `parseReviewerModels` helpers
  (unit-testable without spawning a server).
- **Create** `test/mcp/config.test.ts` — config-parse tests.

---

## Task 1: Gate counts distinct models + honors a quorum param

**Files:**
- Modify: `src/decision/decision.ts`
- Test: `test/decision/decision.test.ts`

- [ ] **Step 1: Add the failing tests** — append these inside the `describe("deriveDecisionState", …)` block in `test/decision/decision.test.ts`, before the closing `});`:

```ts
  it("counts DISTINCT reviewer models, not events (two same-model reviews → 1)", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: ["author_model:claude"] }),
      evt("decision_review_recorded", { source: "reviewer", actor: "Codex:latest", tags: ["author_model:claude"] }),
    ]);
    expect(s.reviewCount).toBe(1); // codex == Codex:latest after normalize
  });

  it("counts two DISTINCT models as 2", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: ["author_model:claude"] }),
      evt("decision_review_recorded", { source: "reviewer", actor: "gemini", tags: ["author_model:claude"] }),
    ]);
    expect(s.reviewCount).toBe(2);
  });

  it("quorum 2: one distinct review stays 'proposed' (not reviewed)", () => {
    const s = deriveDecisionState(
      proposal,
      [evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: ["author_model:claude"] })],
      2,
    );
    expect(s.phase).toBe("proposed");
    expect(s.reviewed).toBe(false);
    expect(s.reviewCount).toBe(1);
  });

  it("quorum 2: two distinct reviews → 'reviewed'", () => {
    const s = deriveDecisionState(
      proposal,
      [
        evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: ["author_model:claude"] }),
        evt("decision_review_recorded", { source: "reviewer", actor: "gemini", tags: ["author_model:claude"] }),
      ],
      2,
    );
    expect(s.phase).toBe("reviewed");
    expect(s.reviewed).toBe(true);
    expect(s.reviewCount).toBe(2);
  });

  it("default quorum is 1 (omitted arg behaves as today)", () => {
    const s = deriveDecisionState(proposal, [
      evt("decision_review_recorded", { source: "reviewer", actor: "codex", tags: ["author_model:claude"] }),
    ]);
    expect(s.reviewed).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `pnpm test -- decision.test`
Expected: the new `reviewCount).toBe(1)` (dedup) and `quorum 2` cases FAIL (current code counts events and ignores a 3rd arg). The pre-existing cases still pass.

- [ ] **Step 3: Implement distinct-count + quorum** in `src/decision/decision.ts`. Replace the `deriveDecisionState` signature line and the `reviewCount` block. New signature + body:

```ts
export function deriveDecisionState(
  proposal: GovEvent,
  related: GovEvent[],
  quorum = 1,
): DecisionState {
  const decisionId = proposal.frontmatter.id;
  const title = proposal.body.split("\n", 1)[0]?.trim() || decisionId;
  // §7: count DISTINCT normalized reviewer models (not events). A review qualifies only
  // when its recorded reviewer model ≠ author_model (normalized); a forged same-model
  // event, or one missing the author tag, does not satisfy the gate (fail-closed).
  const distinctModels = new Set<string>();
  for (const e of related) {
    if (e.frontmatter.type !== "decision_review_recorded") continue;
    const author = reviewAuthorModel(e);
    if (author === null) continue; // fail-closed
    const reviewer = normalizeModelId(e.frontmatter.actor);
    if (reviewer !== normalizeModelId(author)) distinctModels.add(reviewer);
  }
  const reviewCount = distinctModels.size;
  const rejected = related.some((e) => e.frontmatter.type === "decision_rejected");
  const approved = related.some((e) => e.frontmatter.type === "decision_approved");

  let phase: DecisionPhase;
  let verdict: DecisionState["verdict"];
  if (rejected) {
    phase = "rejected";
    verdict = "rejected";
  } else if (approved) {
    phase = "approved";
    verdict = "approved";
  } else if (reviewCount >= quorum) {
    phase = "reviewed";
    verdict = null;
  } else {
    phase = "proposed";
    verdict = null;
  }
  return { decisionId, title, phase, reviewCount, reviewed: reviewCount >= quorum, verdict };
}
```

(Leave the `reviewAuthorModel` helper and imports above unchanged.)

- [ ] **Step 4: Run the tests + type check**

Run: `pnpm test -- decision.test && pnpm exec tsc --noEmit`
Expected: all `decision.test` cases PASS; tsc exit 0.

- [ ] **Step 5: Commit** (from repo root)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/decision/decision.ts governance/test/decision/decision.test.ts
git commit -m "feat(governance): gate counts distinct reviewer models + quorum param (default 1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Thread quorum through the guardian call sites

**Files:**
- Modify: `src/decision/handlers.ts`
- Test: `test/decision/handlers.test.ts`

- [ ] **Step 1: Add the failing test** — append inside `describe("decision handlers", …)` in `test/decision/handlers.test.ts`:

```ts
  it("quorum 2: approve REFUSES after a single distinct review (gate held)", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    await requestReview(dir, { decisionId: id, authorModel: "claude" }, [{ model: "codex", fn: reviewer }], at(1), 0.2);
    const r = await approve(dir, { decisionId: id }, at(5), 0.5, 2); // quorum=2
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/external review/i);
  });
```

(Note: this test also depends on Task 3's `requestReview(... [{model,fn}] ...)` batch
signature. If running tasks strictly in order, expect this file to not compile until Task 3
lands — that is fine; the subagent runner should implement Task 2 and Task 3 together if it
gates on a green build. The `approve(..., quorum)` 5th param is what Task 2 adds.)

- [ ] **Step 2: Add an optional `quorum` param to `loadState`, `approve`, `conflicts`, `why`** in `src/decision/handlers.ts`.

`loadState`:

```ts
async function loadState(
  workspaceDir: string,
  decisionId: string,
  quorum = 1,
): Promise<{ state: DecisionState; proposal: GovEvent }> {
  const grp = eventsForDecision(await readAllEvents(workspaceDir), decisionId);
  if (!grp.proposal) throw new Error(`unknown decision: ${decisionId}`);
  return { state: deriveDecisionState(grp.proposal, grp.related, quorum), proposal: grp.proposal };
}
```

`approve` — add a trailing `quorum = 1` param and forward it:

```ts
export async function approve(
  workspaceDir: string,
  input: { decisionId: string },
  now: Date,
  rand: number,
  quorum = 1,
): Promise<GateResult> {
  const { state } = await loadState(workspaceDir, input.decisionId, quorum);
  const gate = canApprove(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  // …unchanged event-write body…
}
```

`conflicts` — add `quorum = 1` and pass it into the per-proposal `deriveDecisionState`:

```ts
export async function conflicts(workspaceDir: string, quorum = 1): Promise<PendingDecision[]> {
  const all = await readAllEvents(workspaceDir);
  const out: PendingDecision[] = [];
  for (const proposal of proposalsOf(all)) {
    const grp = eventsForDecision(all, proposal.frontmatter.id);
    const s = deriveDecisionState(proposal, grp.related, quorum);
    if (s.phase === "proposed" || s.phase === "reviewed") {
      out.push({ decisionId: s.decisionId, title: s.title, phase: s.phase, gate: gateLabel(s) });
    }
  }
  return out;
}
```

`why` — add `quorum = 1` and forward to `loadState`'s inline `deriveDecisionState`. Since `why`
builds its own group, update it to pass quorum:

```ts
export async function why(
  workspaceDir: string,
  input: { decisionId: string },
  quorum = 1,
): Promise<DecisionTrail> {
  const grp = eventsForDecision(await readAllEvents(workspaceDir), input.decisionId);
  if (!grp.proposal) throw new Error(`unknown decision: ${input.decisionId}`);
  const s = deriveDecisionState(grp.proposal, grp.related, quorum);
  // …unchanged chain-build body…
}
```

(`history` stays `export const history = why;` — it inherits the new param.)

- [ ] **Step 3: Run the type check** (the full handlers test needs Task 3 too)

Run: `pnpm exec tsc --noEmit`
Expected: exit 0 (the `quorum` params are all defaulted, so no existing caller breaks).

- [ ] **Step 4: Commit** (combine with Task 3's commit if the runner gates on a green test build; otherwise commit now)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/decision/handlers.ts governance/test/decision/handlers.test.ts
git commit -m "feat(governance): thread review quorum through approve/conflicts/why gate paths

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Batch reviewer — `requestReview` runs a list of models

**Files:**
- Modify: `src/decision/reviewer.ts` (add types)
- Modify: `src/decision/handlers.ts` (`requestReview` batch)
- Test: `test/decision/handlers.test.ts`

- [ ] **Step 1: Add the failing batch tests** — append inside `describe("decision handlers", …)` in `test/decision/handlers.test.ts`. Add these reviewer fns near the top-level `reviewer` const (after line 15):

```ts
const codexFn: ReviewFn = async () => ({ verdict: "concerns", rationale: "c", reviewerModel: "codex" });
const geminiFn: ReviewFn = async () => ({ verdict: "endorse", rationale: "g", reviewerModel: "gemini" });
const boomFn: ReviewFn = async () => { throw new Error("model unavailable"); };
```

Then the cases:

```ts
  it("batch: two distinct models recorded → quorum 2 gate opens", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    const res = await requestReview(
      dir,
      { decisionId: id, authorModel: "claude" },
      [{ model: "codex", fn: codexFn }, { model: "gemini", fn: geminiFn }],
      at(1), 0.2,
    );
    expect(res.recorded.length).toBe(2);
    expect(res.failures.length).toBe(0);
    expect(res.skipped.length).toBe(0);
    const r = await approve(dir, { decisionId: id }, at(10), 0.9, 2); // quorum 2
    expect(r.ok).toBe(true);
  });

  it("batch: partial failure records the success and reports the failure", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    const res = await requestReview(
      dir,
      { decisionId: id, authorModel: "claude" },
      [{ model: "codex", fn: codexFn }, { model: "gemini", fn: boomFn }],
      at(1), 0.2,
    );
    expect(res.recorded.length).toBe(1);
    expect(res.failures.length).toBe(1);
    expect(res.failures[0].reviewerModel).toBe("gemini");
    expect(res.failures[0].error).toMatch(/unavailable|exhausted|model/i);
    const r = await approve(dir, { decisionId: id }, at(10), 0.9, 2); // quorum 2 unmet
    expect(r.ok).toBe(false);
  });

  it("batch: a reviewer equal to the author is SKIPPED, not aborted", async () => {
    const { id } = await proposeDecision(dir, { title: "Adopt X", body: "why" }, at(0), 0.1);
    const res = await requestReview(
      dir,
      { decisionId: id, authorModel: "claude" },
      [{ model: "claude", fn: codexFn }, { model: "codex", fn: codexFn }],
      at(1), 0.2,
    );
    expect(res.skipped.length).toBe(1);
    expect(res.skipped[0].reviewerModel).toBe("claude");
    expect(res.recorded.length).toBe(1); // codex still recorded
  });
```

Update the **existing** happy-path + conflicts + why tests that call `requestReview(... reviewer ...)` to the new batch signature `requestReview(... [{ model: "codex", fn: reviewer }] ...)`. The three call sites are the existing tests at the current lines 32, 48, 58. After editing they read e.g.:

```ts
    const rev = await requestReview(dir, { decisionId: id, authorModel: "claude" }, [{ model: "codex", fn: reviewer }], at(1), 0.2);
    expect(rev.recorded[0].verdict).toBe("concerns");
```

(the happy-path assertion changes from `rev.verdict` to `rev.recorded[0].verdict`).

- [ ] **Step 2: Run to confirm failure**

Run: `pnpm test -- handlers.test`
Expected: compile/type errors or assertion failures referencing `requestReview` arity / `res.recorded` (batch not implemented yet).

- [ ] **Step 3: Add batch types to `src/decision/reviewer.ts`** — append after the existing `RecordReviewResult` interface:

```ts
/** A named reviewer: the model label + its injected ReviewFn closure. */
export interface ReviewerEntry {
  model: string;
  fn: ReviewFn;
}

export interface ReviewFailure {
  reviewerModel: string;
  error: string;
}

export interface ReviewSkip {
  reviewerModel: string;
  reason: string;
}

/** Aggregate outcome of running a reviewer batch for one decision. */
export interface RequestReviewResult {
  recorded: RecordReviewResult[];
  failures: ReviewFailure[];
  skipped: ReviewSkip[];
}
```

- [ ] **Step 4: Rewrite `requestReview` in `src/decision/handlers.ts`** to take `ReviewerEntry[]` and run the batch. Replace the existing `ReviewInput` interface + `requestReview` function:

```ts
export interface ReviewInput { decisionId: string; authorModel: string; }

/** /request_review — run a batch of External Reviewers (one per distinct model) for a
 *  decision. Records each success as a linked review event; a reviewer equal to the author
 *  is SKIPPED, a reviewer whose bounded retry is exhausted is reported as a FAILURE — the
 *  batch never aborts. The quorum/distinct-model gate (deriveDecisionState) decides whether
 *  enough independent models reviewed. now is offset per reviewer to keep event ids/files
 *  unique (writeEvent is fail-if-exists at second resolution). */
export async function requestReview(
  workspaceDir: string,
  input: ReviewInput,
  reviewers: ReviewerEntry[],
  now: Date,
  rand: number,
): Promise<RequestReviewResult> {
  const { state, proposal } = await loadState(workspaceDir, input.decisionId);
  if (state.verdict) throw new Error(`decision already ${state.verdict}; cannot review`);

  const recorded: RecordReviewResult[] = [];
  const failures: ReviewFailure[] = [];
  const skipped: ReviewSkip[] = [];

  for (let i = 0; i < reviewers.length; i++) {
    const { model, fn } = reviewers[i];
    // pre-skip a reviewer that is the same model as the author (different-model invariant)
    if (normalizeModelId(model) === normalizeModelId(input.authorModel)) {
      skipped.push({ reviewerModel: model, reason: "same model as author" });
      continue;
    }
    const at = new Date(now.getTime() + i * 1000); // unique stamp → unique id + filename
    try {
      const r = await recordReview(
        workspaceDir,
        { decisionId: input.decisionId, title: state.title, proposalBody: proposal.body, authorModel: input.authorModel },
        fn, at, rand,
      );
      recorded.push(r);
    } catch (err) {
      failures.push({ reviewerModel: model, error: (err as Error).message });
    }
  }
  return { recorded, failures, skipped };
}
```

Add `normalizeModelId` + the new types to the imports at the top of `handlers.ts`:

```ts
import { recordReview, type RecordReviewResult, type ReviewerEntry, type RequestReviewResult, type ReviewFailure, type ReviewSkip } from "./reviewer.ts";
import { normalizeModelId } from "./modelId.ts";
```

(Remove the old `import { recordReview, type ReviewFn } from "./reviewer.ts";` line — `ReviewFn`
is no longer referenced in handlers.)

- [ ] **Step 5: Run tests + type check**

Run: `pnpm test -- handlers.test && pnpm exec tsc --noEmit`
Expected: all handlers cases PASS; tsc exit 0.

- [ ] **Step 6: Commit** (from repo root)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/decision/reviewer.ts governance/src/decision/handlers.ts governance/test/decision/handlers.test.ts
git commit -m "feat(governance): request_review runs a reviewer batch (record/skip/fail per model)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Config parse helpers (quorum + reviewer-models list)

**Files:**
- Create: `src/mcp/config.ts`
- Create: `test/mcp/config.test.ts`

- [ ] **Step 1: Write the failing test** — `test/mcp/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseQuorum, parseReviewerModels } from "../../src/mcp/config.js";

describe("parseQuorum", () => {
  it("parses a positive integer", () => {
    expect(parseQuorum("2")).toBe(2);
    expect(parseQuorum("3")).toBe(3);
  });
  it("clamps junk / <1 / undefined to the safe default 1 (never weakens the gate)", () => {
    for (const v of [undefined, "", "abc", "0", "-1", "1.9"]) {
      expect(parseQuorum(v)).toBe(1);
    }
  });
});

describe("parseReviewerModels", () => {
  it("splits, trims, drops empties, dedupes by normalized id", () => {
    expect(parseReviewerModels("codex, gemini ,Codex:latest", "fallback")).toEqual(["codex", "gemini"]);
  });
  it("falls back to the singular model when the list is unset/empty", () => {
    expect(parseReviewerModels(undefined, "external-stub")).toEqual(["external-stub"]);
    expect(parseReviewerModels("  ,  ", "external-stub")).toEqual(["external-stub"]);
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `pnpm test -- config.test`
Expected: FAIL — `src/mcp/config.ts` does not exist.

- [ ] **Step 3: Implement `src/mcp/config.ts`**

```ts
import { normalizeModelId } from "../decision/modelId.ts";

/** Parse BOULE_REVIEW_QUORUM into a positive integer. Junk / <1 / unset → 1.
 *  Fail-closed: an unparseable quorum must never silently LOWER the bar below 1. */
export function parseQuorum(raw: string | undefined): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Parse BOULE_REVIEWER_MODELS (comma list) → trimmed, non-empty, deduped-by-normalized-id
 *  model labels (first spelling of each normalized id wins). Falls back to [fallback] when
 *  the list is unset or empty. */
export function parseReviewerModels(raw: string | undefined, fallback: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const label = part.trim();
    if (!label) continue;
    const key = normalizeModelId(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.length > 0 ? out : [fallback];
}
```

- [ ] **Step 4: Run tests + type check**

Run: `pnpm test -- config.test && pnpm exec tsc --noEmit`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit** (from repo root)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/mcp/config.ts governance/test/mcp/config.test.ts
git commit -m "feat(governance): pure BOULE_REVIEW_QUORUM + BOULE_REVIEWER_MODELS parse helpers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Wire the server boundary (quorum + reviewer list + batch surface)

**Files:**
- Modify: `src/mcp/server.ts`

No new automated test (server.ts is the imperative boundary; logic lives in the unit-tested
helpers). Verification is `tsc` + a manual headless MCP round-trip.

- [ ] **Step 1: Import the helpers + types** — add to the top imports of `src/mcp/server.ts`:

```ts
import { parseQuorum, parseReviewerModels } from "./config.ts";
import type { ReviewerEntry } from "../decision/reviewer.ts";
```

- [ ] **Step 2: Parse quorum + reviewer list near the existing `AUTHOR_MODEL`/`REVIEWER_MODEL` block** (replace lines 58–59 region and the `buildReviewer` function). Keep `placeholderReview` but make it model-parameterized:

```ts
const AUTHOR_MODEL = process.env.BOULE_AUTHOR_MODEL ?? "claude";
const REVIEWER_MODEL = process.env.BOULE_REVIEWER_MODEL ?? "external-stub";
const QUORUM = parseQuorum(process.env.BOULE_REVIEW_QUORUM);
const REVIEWER_MODELS = parseReviewerModels(process.env.BOULE_REVIEWER_MODELS, REVIEWER_MODEL);

function placeholderReviewFor(model: string): ReviewFn {
  return async (req) => ({
    verdict: "concerns",
    rationale: `[placeholder reviewer — set BOULE_REVIEWER_MODE=live to wire a real model] reviewed "${req.title}".`,
    reviewerModel: model,
  });
}

function liveReviewFor(model: string): ReviewFn {
  const command = process.env.BOULE_REVIEWER_CMD ?? "codex";
  const argsTemplate = (process.env.BOULE_REVIEWER_ARGS ?? "exec").split(" ").filter(Boolean);
  const realSpawn: SpawnLike = (cmd, args) => nodeSpawn(cmd, args) as unknown as ChildLike;
  return liveReview({
    spawn: realSpawn,
    command,
    buildArgs: () => argsTemplate, // prompt fed via stdin, not argv
    buildPrompt: defaultReviewPrompt,
    reviewerModel: model,
    parse: parseVerdict,
    timeoutMs: Number(process.env.BOULE_REVIEWER_TIMEOUT_MS ?? 120000),
    maxAttempts: Number(process.env.BOULE_REVIEWER_MAX_ATTEMPTS ?? 2),
    backoffMs: 500,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    setTimer: (cb, ms) => {
      const t = setTimeout(cb, ms);
      return () => clearTimeout(t);
    },
    rand: Math.random,
    log: (line) => process.stderr.write(`${line}\n`), // PII-safe (size/attempt/exit only)
  });
}

// 비결정(서브프로세스/타이머/Math.random)은 이 경계에서만 주입. 기본 = stub(결정적·CI 무변경).
// BOULE_REVIEWER_MODE=live 일 때만 작성자와 다른 모델 CLI를 bounded retry로 호출.
// 모든 모델은 같은 CMD를 공유하고 reviewerModel 라벨로 구분(per-model CMD override는 범위 밖).
function buildReviewers(): ReviewerEntry[] {
  const live = process.env.BOULE_REVIEWER_MODE === "live";
  return REVIEWER_MODELS.map((model) => ({
    model,
    fn: live ? liveReviewFor(model) : placeholderReviewFor(model),
  }));
}

const reviewers = buildReviewers();
```

(Delete the old `placeholderReview` const and `buildReviewer`/`const reviewFn = buildReviewer();`.)

- [ ] **Step 3: Update the `request_review` tool handler** (lines 109–119 region) to run the batch and report outcomes:

```ts
server.registerTool(
  "request_review",
  {
    description: "결정에 대해 External Reviewer(다른 모델) 적대적 검토를 기록 (모델 리스트 일괄)",
    inputSchema: { decisionId: z.string() },
  },
  async ({ decisionId }) => {
    const r = await requestReview(WORKSPACE, { decisionId, authorModel: AUTHOR_MODEL }, reviewers, nowFn(), randFn());
    const parts = [`recorded: ${r.recorded.length}/${reviewers.length} (quorum ${QUORUM})`];
    if (r.skipped.length) parts.push(`skipped: ${r.skipped.map((s) => s.reviewerModel).join(",")}`);
    if (r.failures.length) parts.push(`failed: ${r.failures.map((f) => f.reviewerModel).join(",")}`);
    return { content: [{ type: "text", text: parts.join(" | ") }] };
  },
);
```

- [ ] **Step 4: Pass `QUORUM` to the gate-reading tools** — update the `approve`, `conflicts`, and `why`/`history` handlers to forward the quorum:

`approve` call → `await approve(WORKSPACE, { decisionId }, nowFn(), randFn(), QUORUM)`.
`conflicts` call → `await conflicts(WORKSPACE, QUORUM)`.
`why` call → `await why(WORKSPACE, { decisionId }, QUORUM)`.
`history` call → `await history(WORKSPACE, { decisionId }, QUORUM)`.

(`reject` does not depend on quorum — leave it.)

- [ ] **Step 5: Type check + full test suite**

Run: `pnpm exec tsc --noEmit && pnpm test`
Expected: tsc exit 0; full suite green (original 59 + the new gate/handlers/config cases).

- [ ] **Step 6: Headless MCP round-trip (stub, default quorum 1 — proves no regression)**

Run from `governance/`:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"propose_decision","arguments":{"title":"Smoke quorum","body":"b"}}}' \
  | node --experimental-strip-types src/mcp/server.ts 2>/dev/null | tail -1
```

Expected: a JSON result whose text contains `decision proposed: evt_…`. (Full propose→review→approve round-trip with a captured id is exercised by the handlers test; this just confirms the server still boots and serves with the new wiring.)

- [ ] **Step 7: Confirm bindings drift is empty** (governance is outside the Tauri graph; this must always be empty)

Run from repo root: `git diff -- src/bindings.ts`
Expected: no output.

- [ ] **Step 8: Commit** (from repo root)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add governance/src/mcp/server.ts
git commit -m "feat(governance): wire BOULE_REVIEW_QUORUM + BOULE_REVIEWER_MODELS batch at server boundary

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Document the decision + update spec status

**Files:**
- Modify: `docs/decisions.md` (append one line)
- Modify: `governance/docs/design/2026-06-01-ssot-governance-harness-review-quorum-design.md` (status)

- [ ] **Step 1: Append a breadcrumb to `docs/decisions.md`** (match the existing one-line append style; check the last few lines first and mirror their format). Content:

> Boule §7 review quorum: gate now counts DISTINCT normalized reviewer models (not events) and compares to a configurable `BOULE_REVIEW_QUORUM` (default 1 — ≥2 is opt-in, preserves the 2026-06-01 "keep ≥1" decision). `BOULE_REVIEWER_MODELS` lets one `request_review` run a batch (record successes, skip author-equal models, report failures; fail-closed if quorum unmet). Transport channels (Telegram/Slack) stay a Hermes-bridge concern, out of the MCP gate.

- [ ] **Step 2: Flip the spec `Status:` line** from `design / approved (pending spec review)` to `implemented`.

- [ ] **Step 3: Final full verification**

Run from `governance/`: `pnpm test && pnpm exec tsc --noEmit`
Expected: full suite green; tsc exit 0.

- [ ] **Step 4: Commit** (from repo root)

```bash
export PATH="$HOME/.cargo/bin:$PATH"
git add docs/decisions.md governance/docs/design/2026-06-01-ssot-governance-harness-review-quorum-design.md
git commit -m "docs(governance): record §7 review-quorum decision + mark spec implemented

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done criteria (verify with observed output, not prose)

- [ ] Gate counts distinct normalized reviewer models; two same-model reviews → `reviewCount === 1`.
- [ ] `deriveDecisionState(.., quorum)` honors the threshold; default (omitted) === 1.
- [ ] `BOULE_REVIEW_QUORUM` parsed fail-closed (junk/<1/unset → 1).
- [ ] `request_review` runs `BOULE_REVIEWER_MODELS` as a batch: records successes, skips
      author-equal models, reports failures, never aborts.
- [ ] Quorum unmet → `approve` REFUSED (fail-closed); INVARIANT #1 preserved.
- [ ] `pnpm test` green (original 59 + new cases); `pnpm exec tsc --noEmit` exit 0.
- [ ] `git diff -- src/bindings.ts` empty.
- [ ] **Separate reviewer/critic pass** (not self-approve) confirms no INVARIANT regression
      before calling this done.

## Out of scope (do not implement here)

- Parallel reviewer fan-out, round-robin rotation, per-model CMD overrides.
- Real codex LIVE smoke (separate "sandboxed LIVE smoke" candidate).
- In-app GUI / specta bindings; transport-channel (Slack/Telegram) actor provenance.
