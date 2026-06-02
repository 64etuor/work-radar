# SSOT Governance Harness — Per-model Reviewer CMD Override (design)

**Date:** 2026-06-01
**Branch:** `feat/governance-boule-p1` (parked, unpushed)
**Scope:** governance sidecar only (`governance/src/mcp/**`). No app / Rust / migration / `bindings.ts` changes.
**Follows:** [review-quorum](2026-05-31-ssot-governance-harness-review-quorum-design.md) /
[live-reviewer](2026-05-31-ssot-governance-harness-live-reviewer-design.md).

## Problem

`liveReviewFor(model)` (`governance/src/mcp/server.ts`) reads a **single** shared
`BOULE_REVIEWER_CMD` (default `codex`) and a single `BOULE_REVIEWER_ARGS`. The `model`
parameter only becomes the `reviewerModel` **label** on the result.

Consequence: `BOULE_REVIEWER_MODELS=codex,gemini` produces two `ReviewerEntry` rows with
distinct labels, but **both are answered by the same binary**. The §7 review-quorum count
(`deriveDecisionState` counts distinct `normalizeModelId(actor)`) is satisfied by labels
that do not correspond to distinct reviewers — a **fake quorum**. The seam comment at
`server.ts:101` even records "per-model CMD override는 범위 밖" — this design removes that
limitation.

## Goal

Let each reviewer model label resolve its **own** CLI command + args, so a `≥2`
distinct-model live quorum (e.g. `codex` + `claude`) is genuine. Surface — but do not
block on — configurations where two labels still collapse to the same reviewer.

## Design

### 1. Config scheme — per-model env vars with fallback chain

Resolution for a model label, most-specific wins:

```
command:  BOULE_REVIEWER_CMD_<SUFFIX>   ?? BOULE_REVIEWER_CMD  ?? "codex"
args:     BOULE_REVIEWER_ARGS_<SUFFIX>  ?? BOULE_REVIEWER_ARGS        (→ parseReviewerArgs → safe read-only default)
```

- `<SUFFIX>` = the model label upper-cased with each non-`[A-Z0-9]` run collapsed to a
  single `_`, leading/trailing `_` trimmed. Examples: `gemini`→`GEMINI`,
  `claude-opus-4-8`→`CLAUDE_OPUS_4_8`, `gpt-4o`→`GPT_4O`.
- This is a **distinct** transform from `normalizeModelId` (lowercase, for same-model
  _comparison_). It is named `reviewerEnvSuffix` so the two are never confused.
- The existing globals remain the fallback, so today's single-model live setups keep
  working with no config change.
- `args` still routes through `parseReviewerArgs`, so the safe `exec --sandbox read-only
--skip-git-repo-check --ephemeral` default applies **per model** when neither the
  per-model nor the global args var is set.

Genuine-quorum example:
`BOULE_REVIEWER_MODELS=codex,claude` + `BOULE_REVIEWER_CMD_CODEX=codex` +
`BOULE_REVIEWER_CMD_CLAUDE=claude` → two labels, two real binaries.

### 2. Genuine-quorum advisory (warn-but-continue)

A reviewer's **identity** is a stable key over its resolved `(command, args)`. When
`BOULE_REVIEWER_MODE=live` **and** `quorum ≥ 2`:

1. Count **distinct identities** across the configured `REVIEWER_MODELS`.
2. If that count `< quorum` (≥2 labels collapse to the same binary+args), emit **one**
   loud stderr warning naming the colliding model **labels**, then **serve normally**.
3. The same collision, when it touches the active reviewers, also appends a short
   `⚠ fake-quorum: <labels> share a reviewer command` note to the `request_review`
   tool's returned text — landing right where the operator already reads the
   distinct-model count, so warn-but-continue is not silently missed.

Rationale for warn-but-continue (operator chose this over fail-closed): the operator
keeps control; the collision is made loud in two places rather than fatal.

**PII-safe:** warnings print model **labels + counts only** — never `args` content.

**Stub mode never warns:** placeholders spawn nothing, so command-collision is
meaningless there. The advisory is `live`-only.

### 3. Components

**`governance/src/mcp/config.ts`** — new pure helpers (take an `env` record; never mutate
or read `process.env` directly, so they unit-test without global state):

- `reviewerEnvSuffix(model: string): string`
- `resolveReviewerCommand(model: string, env: Record<string, string | undefined>): { command: string; args: string[] }`
- `reviewerIdentity(resolved: { command: string; args: string[] }): string`
- `quorumCollisionWarning(models: string[], env: Record<string, string | undefined>, quorum: number): string | null`

**`governance/src/mcp/server.ts`**:

- `liveReviewFor(model)` swaps the shared `BOULE_REVIEWER_CMD` / `BOULE_REVIEWER_ARGS`
  reads for `resolveReviewerCommand(model, process.env)`. The rest of the `liveReview({…})`
  wiring (spawn, timeout, retry, parse, log) is unchanged.
- After `buildReviewers()`: when live + `quorum ≥ 2`, compute
  `quorumCollisionWarning(REVIEWER_MODELS, process.env, QUORUM)` and, if non-null, write it
  to stderr (same PII-safe `process.stderr.write` channel as live-reviewer logs).
- `request_review` handler appends the fake-quorum note when the collision affects the
  active reviewers.
- Delete the now-stale `server.ts:101` comment.

### 4. Data flow

```
env ──reviewerEnvSuffix──▶ BOULE_REVIEWER_CMD_<SUFFIX> / ARGS_<SUFFIX>
                              │ (fallback) BOULE_REVIEWER_CMD / ARGS → parseReviewerArgs
                              ▼
            resolveReviewerCommand(model, env) → { command, args }
                              │
            liveReviewFor(model) → liveReview({ command, buildArgs:()=>args, … })
                              │
       buildReviewers() → ReviewerEntry[] ──▶ requestReview (batch, unchanged)

           reviewerIdentity ──▶ quorumCollisionWarning ──▶ stderr (startup) + request_review note
```

### 5. Error handling

- Malformed / missing per-model vars → fall through the chain to the global, then to the
  safe default. No throw on config (consistent with `parseReviewerArgs` /
  `parseQuorum` non-throwing posture).
- Collision is an **advisory**, never an error (operator decision).
- `requestReview`'s existing per-reviewer best-effort behaviour (record / skip
  author==reviewer / capture failures, non-blocking) is untouched.

### 6. Testing

All new logic is pure → `governance/test/mcp/config.test.ts` additions:

- `reviewerEnvSuffix`: lowercase→upper, dashed (`claude-opus-4-8`), dotted, leading/trailing
  separators trimmed.
- `resolveReviewerCommand`: per-model override wins; falls back to global; falls back to
  default `codex` + safe read-only args; per-model args honored verbatim; safe-args default
  applies when only the model is named.
- `reviewerIdentity`: stable for equal (cmd,args); distinct command **or** distinct args →
  distinct identity.
- `quorumCollisionWarning`: collision present (returns labels), all-distinct → `null`,
  distinct-count `< quorum` triggers, `quorum = 1` → `null`, names only labels (no args).

No new subprocess tests — the `liveReview` seam is already covered; only _which_ (cmd,args)
feed it changed.

### 7. Verification

- `cd governance && pnpm test` — expect 78 prior + new cases all green.
- `cd governance && pnpm exec tsc --noEmit` — 0 errors.
- No app gates needed (no Rust / FE / migration / `bindings.ts` touch); state that
  explicitly rather than claiming they passed.
- Final **separate reviewer pass** (no self-approve, per AGENTS.md) before "done".
- **No push** (standing directive — Boule stays parked).

## Invariant check (decision-rails)

- **#5 bounded retry only** — unchanged; `liveReview` retry/backoff untouched.
- **Logs PII/secret-free** — warnings print labels + counts only; args never logged.
- **No automation on decision rails (#1/#2)** — no job spawn; this only configures _which_
  reviewer CLI answers, the human approve gate is unchanged.
- No migration, no `bindings.ts` drift, no app behavior change.

## Out of scope / deferred

- Driving an actual `codex` + `claude` live two-model smoke (needs both CLIs authed +
  throwaway cwd) — recipe-documented follow-up, not part of this change.
- Per-model timeout / max-attempts overrides (YAGNI; globals suffice).
- Fail-closed quorum enforcement (operator explicitly chose warn-but-continue).
