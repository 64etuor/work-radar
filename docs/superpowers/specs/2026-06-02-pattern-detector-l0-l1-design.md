# SSOT Governance Harness — P3 Slice 2b: Pattern Detector L0→L1 (commit scope hotspots)

- **Date**: 2026-06-02
- **Status**: design (approved, pre-plan)
- **Branch**: `feat/governance-boule-p1` (PARKED, unpushed — commit only, never push without explicit request)
- **Parent design**: `docs/superpowers/specs/2026-05-31-ssot-governance-harness-design.md` (§2.1 pattern format, §3 Pattern Detector agent, §4.2 adaptation loop, §8 P3)
- **Sibling slices**: `2026-06-01-…-decision-ingress-design.md` (P3 Slice 1, read-only L3/L4 ingress) · `2026-06-01-…-l0-harvest-design.md` (P3 Slice 2a, fills the L0 corpus this slice reads)

## 1. Problem & Context

The master pipeline is **L0 Events → L1 Patterns → L2 Hypotheses**. Slice 2a filled L0 (an
on-demand idempotent harvest of repo activity; the corpus is now ~869 events: 548
`commit_recorded`, 309 `decision_recorded`, a handful of decision events). `workspace/patterns/{active,archived}/`
exist but are **empty** — nothing compresses repeated L0 observations into L1 patterns yet.

This slice builds the **first cut of the Pattern Detector**: scan the L0 corpus and emit
**candidate** L1 patterns for one pattern kind — _commit scope hotspots_. It deliberately does
**not** build pgvector, embeddings, similarity clustering, cron scheduling, or the Hermes
notification leg. It mirrors the prior P3 slices' no-dependency, headless-testable, pure-core
posture, and is a structural twin of `src/harvest/`.

### 1.1 Decisions locked during brainstorming

1. **Persist candidates** (not detect-only): the detector writes candidate pattern files into the
   tracked `patterns/` tree. The candidate→active flip is a separate human action.
2. **Deterministic structural grouping** as the detection method — no model, no embeddings.
   Pure function in / pure function out → byte-stable, reproducible, trivially testable. pgvector
   stays deferred (corpus-scale-driven).
3. **Activation gate = manual edit + read-only MCP view.** The detector writes candidates; a
   read-only MCP command lets a human inspect them; activation is the human moving the file to
   `active/` and committing. The git commit _is_ the gate. No richer activation UX (MCP
   `activate`, Hermes tap) in this slice.
4. **One pattern kind: commit scope hotspots.** Tightest slice, most meaningful "subsystem churn"
   signal, cleanly feeds a later Hypothesis Tester. Extensible to other keys later.
5. **No cron this slice** — on-demand `detect` only (honors INVARIANT #5: no infinite poll;
   honors the parked/local posture). Scheduling is a later slice, like harvest.

## 2. Module boundary & data flow

New `governance/src/patterns/`, a structural twin of `src/harvest/`:

| File        | Purity          | Responsibility                                                                                                                 |
| ----------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `scope.ts`  | pure            | `parseScope(subject) → string \| null` — conventional-commit `type(scope): …` parser                                           |
| `detect.ts` | pure            | `detectPatterns(events, curatedKeys, opts) → CandidatePattern[]` — the whole detection algorithm, no I/O                       |
| `write.ts`  | impure boundary | `makeWritePattern(workspaceDir)` (idempotent candidate writer) + `loadCuratedKeys(workspaceDir)` (reads `active/`+`archived/`) |
| `types.ts`  | —               | `CandidatePattern`, `PatternKind`                                                                                              |

**Flow** (wired by the `detect` MCP command, exactly as `harvest` wires its pure core to
`makeWriteOne`):

```
readAllEvents(ws)  →  detectPatterns(events, curatedKeys, opts)  →  makeWritePattern(ws) per pattern
   (Slice 2a I/O)          (pure, deterministic)                        (idempotent: written | skipped)
```

`loadCuratedKeys(ws)` reads `patterns/active/` + `patterns/archived/` frontmatter and returns the
set of `(kind, canonicalKey)` already curated by a human, fed into `detectPatterns` for dedup.

## 3. Detection logic (pure, deterministic)

`detectPatterns(events, curatedKeys, opts)`:

1. Filter to `event.frontmatter.type === "commit_recorded"`.
2. For each, `parseScope(body)` using regex `^(\w+)(?:\(([^)]+)\))?(!)?:` over the first line —
   take the scope capture group. **Commits with no parseable scope are dropped** — this includes a
   bare `fix:` (no parentheses) **and an empty/whitespace-only `feat():` scope** — and counted (the
   `detect` result reports `droppedNoScope` — no silent caps).
3. **Normalize** each surviving scope to its **canonical key**: `canonicalKey = scope.trim().toLowerCase()`
   (trim **then** lowercase; an empty result is impossible here because empty scopes were already
   dropped in step 2). Group events by `canonicalKey` (case/whitespace variants of the same scope
   merge rather than split). This same normalization is applied when reading `active/`/`archived/`
   so curated-pair matching is exact.
4. For each group with `evidence_count ≥ minEvidence`:
   - skip if `(kind="commit_scope_hotspot", canonicalKey)` ∈ `curatedKeys` (already curated by a
     human in `active/` or `archived/` — the detector never resurrects a curated or dismissed scope);
   - else emit `CandidatePattern { kind: "commit_scope_hotspot", scope: canonicalKey, evidenceCount, confidence, evidenceEventIds }`.
   - `confidence = min(1, evidenceCount / confFull)`, **clamped to 1 and rounded to 2 decimals** —
     a transparent, documented function of the count (not a magic constant). Rounding keeps the
     frontmatter byte-stable so idempotent re-runs don't churn on float noise.
5. Return sorted by `scope` (stable, byte-deterministic ordering). Pure in / pure out.

**Config knobs** (env, fail-closed clamps — mirrors `BOULE_REVIEW_QUORUM` in `src/mcp/config.ts`):

- `BOULE_PATTERN_MIN_EVIDENCE` — `minEvidence`, default **5**, clamp ≥ 1.
- `BOULE_PATTERN_CONF_FULL` — `confFull` (count at which confidence saturates to 1.0), default **50**, clamp ≥ 1.

Decision (non-commit) events carry no structural grouping key yet (`tags` empty, `actor` is
`system`), so they contribute no patterns in this slice — noted explicitly, not silently ignored.

## 4. Pattern file schema, layout & idempotency

> **INVARIANT — detector write-path:** the detector may create or overwrite files **only** under
> `patterns/candidates/`. It must **never** write, move, or delete anything under `patterns/active/`
> or `patterns/archived/` (those are human-owned), nor any path outside `patterns/candidates/`. This
> is narrower than the master design's "writes `patterns/` only" and is enforced in `makeWritePattern`
> (it joins paths under a fixed `candidates/` base) and asserted by a test.
>
> **Symmetric read-path guard:** the `pattern <id>` MCP tool takes an untrusted `id`. `getPattern`
> must validate the id shape (`^[A-Za-z0-9_]+$` — no `.`/path separators) **before** joining it into
> a path, so a `../`-laden id cannot read `.md` files outside the patterns tree. Asserted by a
> traversal-rejection test.

`patterns/active/` and `patterns/archived/` remain human-owned; `candidates/` is plural for
consistency with them.

**Identity / filename** — content-addressed on identity so re-runs don't churn git:

- hash input is the namespace-scoped UTF-8 string `<kind>:<normalizedScope>` — i.e.
  `sha8("commit_scope_hotspot:" + normalizedScope)`, where `normalizedScope` is the canonical key
  from §3 (`scope.trim().toLowerCase()`). The `kind` prefix namespaces the hash so a future pattern
  kind keying on the same value can't collide.
- `id = "pat_scope_" + sha256(hashInput).hex.slice(0, 8)`.
- filename = `<id>.md` under `patterns/candidates/`.

**File format** (YAML frontmatter + Markdown body, per master design §2.1 — pattern fields
`evidence_count, confidence, status`):

```text
---
id: pat_scope_1a2b3c4d
kind: commit_scope_hotspot
scope: governance
evidence_count: 87
confidence: 1.0
status: candidate
generated_by: pattern-detector
---
Commit scope `governance` recurred 87 times in the L0 corpus (min-evidence threshold 5).

Evidence (first 20 of 87):
- evt_commit_<sha>
- ...
```

The evidence list is capped for readability (first N, default 20) but the body states the true
total (`… of 87`) — no silent truncation.

**Idempotency** (the harvest run1→run2 = 0 property):

- Stable filename + deterministic content ⇒ re-run on an **unchanged** corpus = byte-identical
  file = **zero git diff**. The writer returns `skipped` when the target exists with identical
  content, `written` otherwise.
- New commits in the same scope ⇒ updated `evidence_count`/`confidence` ⇒ a _meaningful_ diff
  (`written`) — that is the intended signal, not churn.

**Curation = human git operations:**

- **Activate:** move `candidates/<id>.md → active/<id>.md`, set `status: active`, commit. This
  commit is the activation gate. No automation touches `active/`.
- **Dismiss/reject:** move `candidates/<id>.md → archived/<id>.md` (set `status: archived`). Since
  `loadCuratedKeys` reads `archived/` too, a dismissed scope is **not re-proposed** on the next
  `detect`.

**Git tracking:** candidate files are tracked/committed (the user chose persistence in the tracked
`patterns/` tree). `patterns/candidates/.gitkeep` is added to preserve the empty dir before first
run. (Contrast: L0 `events/` are gitignored runtime artifacts; L1 patterns are SSOT.)

## 5. MCP surface

Mirrors the harvest/decision command shapes in `src/mcp/handlers.ts` + `src/mcp/server.ts`:

- **`detect`** _(write)_ — `readAllEvents` → `loadCuratedKeys` → `detectPatterns` → write each
  candidate. Returns `{ written, skipped, droppedNoScope, scopesConsidered }`. On-demand,
  idempotent. No cron.
- **`patterns`** _(read-only)_ — list candidate patterns (and optionally active) with
  `scope / evidence_count / confidence / status`.
- **`pattern <id>`** _(read-only)_ — one pattern's detail + its evidence event ids.

New MCP commands/types extend `src/bindings.ts` additively (drift = new surface only, gated by the
bindings drift check — no existing-type churn).

## 6. Invariants, errors, testing

**Invariants** (`docs/areas/decision-rails.md`):

- **#1 / #2 (no automation in the decision rails):** the detector only _proposes_ candidates;
  activation is a human commit; it never writes `active/`/`archived/`, and never touches
  `decisions.md`, ADRs, or `decision-rails.md`. It dedups against curated state so it cannot fight
  the human.
- **#5 (bounded):** single pass over the corpus, no retry/poll/daemon.
- **#6 (no PII/secrets in logs):** the detector reads only event bodies (commit subjects already in
  the local L0 store) and writes scope names + event ids — no tokens, no external response bodies.

**Errors / fail-soft** (like harvest): missing `events/` → 0 patterns; a malformed event file is
skipped (and the read tolerated); missing `active/`/`archived/` → empty `curatedKeys`. No throw on
empty corpus.

**No app / Rust / migration changes** — pure TS + workspace files, like the prior P3 slices.

**Tests:**

- `parseScope` — scoped, unscoped (`fix: …` → null), breaking (`feat(x)!: …`), nested-paren edge,
  leading/trailing space.
- `detectPatterns` — threshold boundary (n = minEvidence−1 vs minEvidence), dedup-against-curated
  (active and archived), confidence formula + saturation clamp, case/whitespace key merge, sorted
  output.
- `makeWritePattern` — idempotency: write → re-write unchanged = `skipped` / byte-identical; changed
  evidence_count = `written`. Content-addressed filename stability.
- `loadCuratedKeys` — reads frontmatter from `active/`+`archived/`, tolerant of `.gitkeep`/malformed.
- Headless MCP round-trip — `detect` → `patterns` → `pattern <id>`.
- Real-corpus smoke — `detect` run1 writes N candidates, run2 = 0 new (`written: 0`).

**Verification:** `pnpm test`, `pnpm exec tsc --noEmit`, bindings drift check; then an opus critic as
a **separate pass** (self-approve forbidden). Boule = **commit only, never push** without explicit
request.

## 7. Out of scope (deferred)

- pgvector / embeddings / fuzzy similarity clustering (corpus-scale-driven).
- Cron / scheduled runs (on-demand only this slice).
- Hermes notification leg of the adaptation loop (detector → notify → tap-to-activate).
- MCP `activate` write-command (activation stays a manual git op this slice).
- Additional pattern kinds (type×scope pairs, actor activity, decision-event patterns once tags exist).
- Archive Pruner / staleness handling of accumulated candidates.
