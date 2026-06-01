# Boule governance — §7 ≥2 distinct-model review quorum (design)

- **Date:** 2026-06-01
- **Branch:** `feat/governance-boule-p1`
- **Status:** design / approved (pending spec review)
- **Builds on:** `2026-05-31-ssot-governance-harness-live-reviewer-design.md` (live External Reviewer wiring, DONE @ `08d20cd`)
- **Area:** `governance/` Node/TS sidecar (outside the Tauri/Vite build graph)

## Problem

The canonical governance design §7 calls for **dual verification by ≥2 independent
models** before a Type 1 (irreversible) decision can be approved. The current gate
(`deriveDecisionState`, `decision.ts:45`) mechanizes only **≥1** distinct-model review:

```ts
} else if (reviewCount >= 1) {        // §7 is only PARTIALLY mechanized
```

and `reviewCount` is the _count of qualifying review events_ — two reviews by the
**same** model would both count, which is not what "≥2 independent models" means.

Separately, the live reviewer path wires exactly **one** reviewer model
(`BOULE_REVIEWER_MODEL`, `server.ts:59,72`). Even if the gate were raised, approval
would deadlock because a single model can never produce 2 _distinct_ models.

This change completes §7: a configurable **quorum of distinct independent reviewer
models**, plus a live path that can produce them. Per the 2026-06-01 user decision,
the threshold stays **≥1 by default** (opt-in to ≥2) so existing behavior, the stub
round-trip, and CI are unchanged.

## Decisions (from brainstorming)

1. **Quorum is configurable; default 1.** `BOULE_REVIEW_QUORUM` raises it. §7 ≥2 is
   opt-in. Backward compatible with the 2026-06-01 "keep ≥1" decision.
2. **Count distinct normalized reviewer models, not events.** Two reviews by the same
   model dedupe to 1. This is the substantive correctness fix for "≥2 independent".
3. **Multi-model = a model list; one `request_review` runs each model once.**
   `BOULE_REVIEWER_MODELS` (comma list) → N reviewer closures → N review events in a
   single `request_review`. A single call can satisfy quorum.
4. **Partial failure = record successes, report failures.** A model that fails its
   bounded retry is surfaced as a terminal failure in the result; successful reviews
   are still recorded. If quorum is unmet, the gate stays **fail-closed** (approve
   refused). Consistent with the bounded-retry / surfaced-terminal-failure invariant.

## Architecture

Four small, independently testable changes. The pure fold and the live wiring stay
separated by the same injection seam as today (handlers stay pure; non-determinism
lives only at the server boundary).

### 1. Gate: distinct-model count + quorum parameter (`decision.ts`)

`deriveDecisionState(proposal, related, quorum = 1)`:

- Replace the event **count** with a `Set<string>` of `normalizeModelId(actor)` over
  events that pass the existing independence predicate (type
  `decision_review_recorded`, `author_model` tag present, `normalize(actor) !==
normalize(author_model)`). `reviewCount = set.size`.
- `reviewed = reviewCount >= quorum`; the `else if (reviewCount >= quorum)` branch
  replaces the hardcoded `>= 1`.
- `quorum` defaults to `1` → every existing caller and test is unchanged unless it
  opts in.

`DecisionState` keeps `reviewCount` (now = distinct-model count). No new field needed
for correctness; `quorum` is an input, not stored state.

### 2. Quorum config at the boundary (`server.ts`)

- Parse `BOULE_REVIEW_QUORUM`: `Math.max(1, Math.floor(Number(...)))`, with
  `NaN → 1` (fail-closed clamp to the safe default; an unparseable quorum must never
  silently _lower_ the bar, and never go below 1).
- Thread `quorum` into the call sites that derive state for gating —
  `loadState` in `decision/handlers.ts` so `approve`/`conflicts`/`why` all see the
  same threshold. `loadState` gains a `quorum` param (default 1); `handlers.ts`
  functions accept and forward it; `server.ts` passes the parsed value.

### 3. Multi-model reviewer list (`server.ts` + `handlers.ts` + `reviewer.ts`)

- New `BOULE_REVIEWER_MODELS` (comma-separated). Resolution order:
  1. If set → split, trim, drop empties, **dedupe by `normalizeModelId`**.
  2. Else fall back to the single `BOULE_REVIEWER_MODEL` (back-compat).
- `buildReviewer()` → `buildReviewers(): ReviewerEntry[]` where each entry is
  `{ model: string; fn: ReviewFn }`. In **live** mode, one `liveReview(...)` closure
  per model (each pinned `reviewerModel`, sharing command/args/timeout config; a
  per-model `BOULE_REVIEWER_CMD_<model>` override is **out of scope** — all models use
  the same command for now, distinguished by `reviewerModel` label). In **stub** mode,
  the list collapses to the single placeholder entry (one model) — quorum >1 with the
  stub will correctly fail-closed, which is the honest outcome.
- `handlers.ts` `requestReview` accepts `reviewFns: ReviewFn[]` (was a single
  `reviewFn`). It loops, calling `recordReview` per fn, collecting:
  `{ recorded: RecordReviewResult[]; failures: {error}[]; skipped: {reason}[] }`.
  - **author == reviewer** is no longer a hard throw inside `recordReview` for the
    batch path: `recordReview` keeps its guard (defense-in-depth for single use), but
    the batch catches that specific rejection and records it as `skipped` rather than
    aborting the whole batch. (Implementation: catch per-fn; classify the
    author==reviewer error as `skipped`, all other errors as `failures`.)
  - Each `recordReview` already enforces the different-model invariant and writes the
    `author_model` tag, so duplicate-model dedup at the gate is automatic.

### 4. MCP `request_review` surface (`server.ts`)

- Pass `reviewFns` (the list) instead of the single fn.
- Result text reports `recorded: N`, and if any, `failed: [...]` / `skipped: [...]`,
  so a human sees partial outcomes. Still one tool call.

## Data flow

```
propose
  → request_review            (one call)
      → for each reviewer model m in list:
          recordReview(m)     → liveReview(m) bounded-retry → decision_review_recorded
                                (actor=m, tag author_model:<author>)
          on author==reviewer → skipped
          on terminal failure → failures
  → deriveDecisionState(proposal, related, quorum)
      reviewCount = | { normalize(actor) : qualifying review events } |   (distinct)
      reviewed    = reviewCount >= quorum
  → canApprove: refuses unless reviewed (fail-closed if quorum unmet)
```

INVARIANT #1 (self-approve / automation-into-decision-rail) is preserved and
strengthened: more independent verification required, never less. The human approve
gate is unchanged (still required after review).

## Error handling

- Quorum parse: unparseable/`<1`/`NaN` → clamp to 1 (never silently weaken).
- Per-model: bounded retry inside `liveReview` (unchanged); exhausted → that model is
  a `failure`, batch continues.
- author==reviewer in the batch → `skipped` (not a batch abort).
- Empty reviewer list (mis-config) → `request_review` records nothing and reports it;
  gate stays at `proposed`; approve refused. No crash.
- All logs remain PII/secret-free (model id + counts only; no response bodies).

## Testing (vitest; injected `ReviewFn`s — no real subprocess)

Gate (`decision.test.ts`):

- Two events, **same** normalized model → `reviewCount === 1` (dedup); with `quorum 2`
  → `phase === "proposed"`, `reviewed === false`.
- Two **distinct** models → `reviewCount === 2`; `quorum 2` → `phase === "reviewed"`.
- `quorum` parameter honored (1 vs 2 vs 3 boundary).
- Existing fail-closed cases preserved: missing `author_model` tag not counted;
  `author == reviewer` not counted; normalization still applied.
- Default quorum (no arg) === 1 → all current tests pass unchanged.

Batch (`handlers` or a new `requestReview` test):

- 2 distinct models both succeed → 2 recorded, 0 failures, quorum-2 gate opens.
- 1 succeeds, 1 throws → 1 recorded, 1 failure; quorum-2 gate stays closed.
- 1 model == author → 1 skipped; reported, batch not aborted.
- Reviewer list dedup: `["codex","Codex"]` → 1 entry.

Boundary (`server.ts` config parse — pure helper, unit-tested):

- `BOULE_REVIEW_QUORUM` parse: `"2"→2`, `""/"abc"/"0"/"-1"→1`.
- `BOULE_REVIEWER_MODELS` parse + dedup; fallback to singular when unset.

Regression: full `pnpm test` green; `tsc --noEmit` exit 0; `git diff -- src/bindings.ts`
empty (governance is outside the Tauri binding graph, so always empty — assert it).

## Out of scope (YAGNI)

- Parallel reviewer fan-out (sequential is sufficient at quorum 2–3).
- Round-robin / stateful reviewer rotation.
- Per-model command/args overrides (`BOULE_REVIEWER_CMD_<model>`).
- Real codex LIVE smoke (tracked separately as the "sandboxed LIVE smoke" candidate).
- In-app GUI / specta bindings (governance sidecar has no bindings surface).

## Risks / rollback

- **Risk:** raising quorum without configuring a 2nd model deadlocks approval. Mitigated
  by default quorum 1 + honest fail-closed + `request_review` reporting skipped/failed
  models so the misconfig is visible. Rollback = unset `BOULE_REVIEW_QUORUM` (back to
  ≥1) or revert the commit; pure-fold default keeps old behavior.
- **Risk:** signature change to `deriveDecisionState`/`requestReview` ripples to
  callers. Mitigated by defaulted params (quorum=1) and a small, enumerated call-site
  list (guardian path via `loadState`; server `request_review`).

```

```
