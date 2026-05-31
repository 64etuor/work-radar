# SSOT Governance Harness (Boule) — Live External Reviewer Wiring (Design)

> **Status:** design, approved for planning. Follow-up to P2a (decision governance core).
> Boule lives in the standalone `governance/` sidecar (outside the Tauri/Vite build graph)
> and is **parked/unpushed** on `feat/governance-boule-p1`. This work does **not** touch
> work-radar app code and produces **no `bindings.ts` drift**.

상위 설계 정본: `docs/superpowers/specs/2026-05-31-ssot-governance-harness-design.md` §3 (External
Reviewer), §3.1 (bounded retry), §5.1 (command set), §6 (INVARIANTs), §7 (Security Model — 이중 검증).
직전 단계: `docs/superpowers/plans/2026-05-31-ssot-governance-harness-p2a.md`
(§ "Deferred follow-ups" enumerates exactly the items this design realizes).

---

## 1. Goal

Replace P2a's `placeholderReview` stub with a **real, different-model** External Reviewer,
while **moving the dual-verification guarantee from write-time-only into the re-derivable
gate fold**. After this work:

- `request_review` can invoke an actual reviewer model (≠ author) via a CLI subprocess,
  with **bounded retry** (INVARIANT #5) and PII/secret-free logs.
- The Type 1 Guardian gate counts **only** reviews whose recorded `reviewer_model ≠
author_model` (after normalization), so a forged same-model review event in the log can
  no longer satisfy the gate (P2a enforced this write-time-only).
- The headless suite stays **deterministic** (no real model call in CI); a real call is
  proven once by a manual headless smoke.

**Non-goals (tracked elsewhere):**

- **≥2 independent models** — the canonical design **§7 Security Model ("이중 검증: Type 1은
  2개 이상 독립 모델 검토")** is the full target. This task completes the **different-model**
  half of that invariant (write-time guard + re-derivable gate + normalization) and keeps the
  count at **≥1** per the user's minimal-churn call. Raising to **≥2** is then a small flip
  (count distinct normalized reviewer models ≥ 2) once a second reviewer model is configured —
  tracked as the completing follow-up. **Until then §7's 이중 검증 is only partially mechanized;
  the plan and `docs/decisions.md` line must say so honestly.**
- **Clean not-found handling** for unknown `decisionId` (today `loadState` throws a raw
  error to the MCP transport). Left as a tracked P2a follow-up; **not** in this task.
- **ADR-file ingress** (P3) and **P2b in-app approval card** (GUI-blocked) — unchanged.

---

## 2. Architecture

Three units, each with one purpose, a well-defined interface, and independent testability.

```
src/decision/
  modelId.ts        # NEW: normalizeModelId() — pure, canonical model-id (MINOR a)
  liveReviewer.ts   # NEW: liveReview(deps) → ReviewFn (subprocess, bounded retry)  [the live wiring]
  reviewer.ts       # MODIFY: recordReview() records author_model tag + id-shape assert (MINOR b/d)
  decision.ts       # MODIFY: deriveDecisionState() counts distinct-model reviews (MINOR b)
  guardian.ts       # (unchanged logic; reads the hardened DecisionState)
mcp/
  server.ts         # MODIFY: select placeholder vs liveReview(spawn,cfg) by env (opt-in)
test/decision/
  modelId.test.ts        # NEW
  liveReviewer.test.ts   # NEW (fake spawn — deterministic)
  decision.test.ts       # MODIFY: distinct-model counting + forged same-model rejection
  reviewer.test.ts       # MODIFY: author_model tag persisted + id-shape guard
```

The `ReviewFn` contract from `reviewer.ts` (`(req: ReviewRequest) => Promise<ReviewResult>`)
is the seam between the live wiring and the orchestration — **unchanged**. `recordReview`'s
shape is unchanged except for the two hardening additions in §4.

### Data flow

```
request_review(decisionId, authorModel)
  └─ loadState → ReviewRequest{ decisionId, title, proposalBody, authorModel }
       └─ recordReview(req, reviewFn)            ← reviewFn = placeholderReview | liveReview(...)
            ├─ result = await reviewFn(req)       ← subprocess in the live path
            ├─ guard: norm(result.reviewerModel) ≠ norm(req.authorModel)  (defense-in-depth)
            ├─ assert decisionId matches /^evt_\d{8}_\d{6}_[0-9a-f]{4}$/   (MINOR d)
            ├─ write reviews/<id>.md
            └─ write decision_review_recorded event:
                 actor: result.reviewerModel
                 tags:  ["decision","review","verdict:<v>", "author_model:<norm(author)>"]
                                                                ▲ NEW — makes the pair re-derivable
approve(decisionId)
  └─ deriveDecisionState(proposal, related)
       └─ validReviewCount = related.filter(review &&
            norm(actor) ≠ norm(tag author_model:*)).length     ← MINOR b: gate-level dual-verify
       └─ reviewed = validReviewCount ≥ 1
  └─ canApprove(state)  → unchanged policy, now fed a hardened state
```

---

## 3. Unit: `liveReview` (the subprocess reviewer)

**Interface** (factory returning a `ReviewFn`):

```typescript
export interface LiveReviewDeps {
  spawn: SpawnLike; // injected (node:child_process.spawn at the boundary; fake in tests)
  command: string; // e.g. "codex"
  buildArgs: (req: ReviewRequest) => string[]; // e.g. ["exec", prompt]
  reviewerModel: string; // the configured different-model id (returned verbatim)
  parse: (stdout: string) => { verdict: ReviewResult["verdict"]; rationale: string };
  timeoutMs: number; // per-attempt; kills the child
  maxAttempts: number; // bounded (default 2) — INVARIANT #5
  backoffMs: number; // base for exponential backoff
  sleep: (ms: number) => Promise<void>; // injected (no real timers in tests)
  rand: () => number; // injected jitter source
  log?: (line: string) => void; // PII/secret-free
}
export function liveReview(deps: LiveReviewDeps): ReviewFn;
```

**Behavior:**

- One attempt = spawn `command buildArgs(req)`, feed the reviewer prompt, collect stdout
  with a `timeoutMs` watchdog (kills the child on expiry).
- **Prompt-injection posture (canonical §7):** the proposal body is **agent-authored, not
  trusted**. The reviewer prompt structurally delimits it (e.g. a fenced `<<<PROPOSAL … >>>`
  block) and frames the reviewer as an **adversarial** critic whose job is to find objections —
  it must NOT follow instructions found _inside_ the proposal. This is mitigation-by-framing,
  not a hard guarantee; a determined injection could still skew a verdict. The structured-verdict
  parse (below) bounds the blast radius (only an enum + rationale is trusted), and the human
  approval gate remains the backstop. Documented as a residual risk, not a solved problem.
- **Prompt** instructs the model to emit exactly one fenced block
  ` ```json {"verdict":"endorse|concerns|object","rationale":"..."} ``` `; `parse` extracts
  it (first matching block; tolerant of surrounding prose).
- **Retry** on: spawn error, non-zero exit, timeout, or `parse` failure. Up to `maxAttempts`,
  exponential backoff `backoffMs * 2^(n-1)` + jitter `rand()*backoffMs`, via injected `sleep`.
- **Terminal failure surfaces**: after the budget is exhausted, **throw** an `Error`
  summarizing attempts/last-exit (so `request_review` reports failure). It **never**
  fabricates a verdict and **never** falls back to the author model.
- **Logging** (when `log` provided): `command`, attempt #, exit code, stdout **byte size**
  only — never stdout/stderr bodies, never the proposal/prompt text (AGENTS.md log rule).
- Returns `{ verdict, rationale, reviewerModel: deps.reviewerModel }`.

`SpawnLike` is a minimal structural type over the bits we use (a child with `stdout`/`stderr`
streams, `stdin.write/end`, `on("close"|"error")`, `kill()`), so the fake spawn in tests
needs no real process.

---

## 4. Unit: hardening in the pure/orchestration layer

### `modelId.ts` — `normalizeModelId(s): string`

Pure. Lowercase, trim, collapse internal whitespace, and strip **only an explicit trailing
version pin** — a single trailing `@<ver>` or `:<ver>` segment (e.g. `codex:latest`,
`claude-3-5-sonnet@20241022`). Used at **both** write-time (`recordReview`) and derive-time
(`deriveDecisionState`) so the same-model check is canonical (MINOR a). **Deliberately
conservative — it does NOT touch internal `-`-separated tokens**, so real ids like
`claude-opus-4-8` or `gpt-4o` pass through unmangled (over-stripping risks collapsing two
genuinely different models to one id). Unit-tested with case-drift and `@`/`:`-pin pairs,
plus a negative test that `claude-opus-4-8` is left intact.

### `reviewer.ts` — `recordReview` additions

1. Assert `decisionId` matches `/^evt_\d{8}_\d{6}_[0-9a-f]{4}$/` **before** building
   `reviews/<id>.md` (MINOR d, path-traversal defense-in-depth). Throw on mismatch.
2. Normalize both sides of the existing same-model guard via `normalizeModelId`.
3. Add tag `author_model:${normalizeModelId(req.authorModel)}` to the
   `decision_review_recorded` event (the re-derivable half of the pair; `actor` already
   carries the reviewer model).

### `decision.ts` — `deriveDecisionState` change

Replace the raw `reviewCount` (count of `decision_review_recorded`) with **`validReviewCount`**
= count of review events where `normalizeModelId(actor) !== normalizeModelId(authorTag)`,
reading `author_model:` from the event's tags. `reviewed = validReviewCount >= 1`; `phase`
derives from that. A review event lacking the tag, or with reviewer == author, does **not**
count. `reviewCount` (raw) may be retained in `DecisionState` for display, but the gate uses
`reviewed`/`validReviewCount`. `guardian.ts` policy is unchanged — it already keys off
`reviewed`/`verdict`.

---

## 5. Unit: server boundary (opt-in live path)

`server.ts` selects the reviewer at startup by env, **defaulting to the stub** so the headless
suite and existing behavior are unchanged:

- `BOULE_REVIEWER_MODE` = `stub` (default) | `live`.
- When `live`: build `liveReview` with real `node:child_process.spawn`, `command` /
  `buildArgs` / `reviewerModel` from env (e.g. `BOULE_REVIEWER_CMD=codex`,
  `BOULE_REVIEWER_MODEL=codex`, default `buildArgs` = `["exec", <prompt>]`), real `sleep`
  (timer) and `rand` (`Math.random`), and a PII-safe `log` to stderr.
- `BOULE_AUTHOR_MODEL` (existing) feeds `authorModel`. The boundary is the **only** place
  non-determinism (spawn, timers, `Math.random`) enters — handlers and the pure layer stay
  deterministic and injected.

---

## 6. Error handling

| Condition                                                    | Behavior                                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| reviewer spawn error / non-zero exit / timeout / unparseable | retry within budget; on exhaustion **throw** (request_review fails, no event written)                         |
| reviewer model == author model (live or forged)              | `recordReview` throws (normalized guard); and the gate ignores any same-model review event already in the log |
| malformed `decisionId`                                       | `recordReview` throws before any FS path is built                                                             |
| unknown `decisionId`                                         | **out of scope** — raw throw to transport (tracked follow-up)                                                 |
| `author_model:` tag missing on an old review event           | that review does **not** count toward the gate (fail-closed)                                                  |

---

## 7. Testing

**Deterministic unit tests (CI):**

- `modelId.test.ts` — case/whitespace/version-suffix normalization; non-version ids untouched.
- `liveReviewer.test.ts` (fake spawn, injected `sleep`/`rand`): happy parse; retry-then-succeed;
  exhaust-budget-then-throw; per-attempt timeout kills child; unparseable→retry→throw;
  **log contains no stdout body / no proposal text** (size only); **the built prompt structurally
  delimits the proposal and uses adversarial framing** (assert the delimiter + "find objections"
  intent are present, and the proposal text sits inside the delimiter) — the deterministic proxy
  for the §7 prompt-injection posture.
- `decision.test.ts` (extended): distinct-model review counts; **forged same-model review
  event does NOT satisfy the gate**; missing author tag → not counted.
- `reviewer.test.ts` (extended): `author_model:` tag persisted (normalized); id-shape guard
  rejects a malformed decisionId.
- Full suite ≥ 35 + new tests, `pnpm exec tsc --noEmit` exit 0, all run from `governance/`.

**Manual headless smoke (NOT CI), recorded in the plan:**

- `BOULE_REVIEWER_MODE=live BOULE_AUTHOR_MODEL=claude` (+ reviewer=`codex`), drive a real
  `request_review` over the MCP stdio round-trip on a throwaway `BOULE_WORKSPACE`, observe a
  real different-model verdict recorded and the gate then allowing `approve`. Record the
  transcript. This stands in for the (GUI-blocked) in-app smoke.

**Invariant checks (separate critic pass — self-approve 금지):**

- #1: no path writes `decision_approved` without a prior **valid different-model** review.
- #4: `git diff src/bindings.ts` empty (no app code touched).
- #5: live reviewer has bounded retry + surfaced terminal failure; no infinite poll.
- Logs PII/secret-free (size/exit-code only).

---

## 8. Convention reminders (P1/P2a traps — non-negotiable)

- Runtime `src/**` imports use the **`.ts`** extension; **test files import `.js`**.
- Non-determinism only at the server boundary; handlers + pure layer take injected
  `now`/`rand`/`sleep`/`spawn`/`reviewFn`.
- Run all commands from `governance/`. Install (if ever needed) =
  `pnpm install --ignore-workspace`. zod 4.4.3. `cargo` is irrelevant (no Rust touched).
- Conventional Commits; **do NOT push** (Boule parked). Do NOT touch `origin/dev` or the
  `skills-mgr-migration` worktree.

---

## 9. Self-review

- **Placeholder scan:** no TBD/TODO; every unit fully specified. The stub stays as the
  **default** reviewer (intentional, documented) — its replacement is the opt-in `live` path.
- **Consistency:** `ReviewFn`/`ReviewRequest`/`ReviewResult` reused verbatim; `DecisionState`
  shape extended additively; `guardian.ts` policy untouched. `normalizeModelId` is the single
  canonicalizer used on both write and derive sides.
- **Scope:** one implementation plan — live wiring + the four carried MINORs (a/b/c-partial/d).
  ≥2-model and unknown-id robustness are explicit non-goals.
