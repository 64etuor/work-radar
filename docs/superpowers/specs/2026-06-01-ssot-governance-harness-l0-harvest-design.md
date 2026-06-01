# SSOT Governance Harness — P3 Slice 2a: Gateway L0 Harvest (on-demand, idempotent)

- **Date**: 2026-06-01
- **Status**: design (approved, pre-plan)
- **Branch**: `feat/governance-boule-p1` (PARKED, unpushed — commit only, never push without explicit request)
- **Parent design**: `docs/superpowers/specs/2026-05-31-ssot-governance-harness-design.md` (§1.1 L0 event sources, §3 Gateway, §8 P3)
- **Sibling slice**: `docs/superpowers/specs/2026-06-01-ssot-governance-harness-decision-ingress-design.md` (P3 Slice 1 — L3/L4 read-only ingress; this slice reuses its parsers)

## 1. Problem & Context

The master design's pipeline is **L0 Events → L1 Patterns → L2 Hypotheses**. P3's headline
("Pattern Detector + pgvector") detects L1 patterns by scanning the L0 event store. But
**the L0 store is empty and nothing populates it**:

- `governance/workspace/events/` contains only `.gitkeep`.
- `gateway.ingest()` (raw activity → normalized `GovEvent`) is **never called outside tests**.
- The only events ever written are side-effects of MCP decision commands
  (`create_task`, `propose/approve/reject/review`) — there is no harvest of repo activity.

So Pattern Detection has no input. Its own done-criteria ("humans periodically review
_discovered_ patterns") is unsatisfiable over an empty corpus. **This slice fills that
prerequisite**: wire the Gateway to actually harvest repo activity into L0, on demand and
idempotently. No pattern detection, no embeddings, no DB — exactly mirroring Slice 1's
no-dependency, headless-testable posture.

### 1.1 Decisions locked during brainstorming

1. **Slice = L0 harvest only.** No Pattern Detector, no pgvector — that is a later slice.
2. **Trigger = on-demand idempotent rescan** via a `harvest` MCP command. No daemon, no
   poller, no git hook (honors INVARIANT #5: no infinite poll; honors the parked/local posture).
3. **Events are local runtime output, not committed.** `workspace/events/**` is gitignored
   (only `.gitkeep` tracked) — the `.gitignore` already declares events "runtime output, not
   source." The store is therefore _rebuildable by re-harvest_, which makes idempotency the
   central requirement.
4. **Full history, no window knob.** All 534 commits are scanned; events are gitignored/local
   and a larger corpus is better future pattern input. A window parameter is YAGNI for now.
5. **Reuse Slice 1 parsers** for the decisions/ADR sources; only `git log` parsing is new.
6. **Deterministic ids use full stable source identity** (full commit SHA, full ADR id, full
   content hash) — sha7 is for _display/filename shortening only_, never the id.
7. **Dateless/content-hash for decisions.md bullets.** No blame-derived historical timestamps
   this slice — the goal is idempotent local harvest, not perfect historical dating.

## 2. Goals / Non-goals

**Goals**

- A `harvest` MCP command that scans current repo state and writes not-yet-seen L0 events.
- Three local, no-network sources → typed L0 events:
  - `git log` → `commit_recorded`
  - `docs/decisions.md` bullets → `decision_recorded`
  - `docs/adr/*.md` → `decision_proposed`
- **Idempotent**: re-running writes nothing new (content-addressed events; `wx` skip-on-exist).
- Fully headless/deterministic-testable, no new runtime dependency, no DB, no network.

**Non-goals (deferred)**

- Pattern Detector (L0 → L1), embeddings, vector similarity, pgvector, Postgres, Docker.
- PR / CI / agent-run events (need the Rust `github.rs` network path).
- Continuous/daemon harvesting, git hooks, persisted cursor/watermark.
- Blame-derived or otherwise reconstructed timestamps for dateless decisions bullets.
- Any write to ADRs / `decisions.md` / `decision-rails.md`; any auto-decision.

## 3. Architecture & Module Boundaries

New directory `governance/src/harvest/`, plus one small additive helper in `src/event/`:

| Unit                           | Responsibility                                            | Purity                    |
| ------------------------------ | --------------------------------------------------------- | ------------------------- |
| `harvest/gitLog.ts`            | `parseGitLog(raw: string) → RawCommit[]`                  | pure (string in)          |
| `harvest/sources.ts`           | map `RawCommit` / Slice-1 `DecisionRow` → `HarvestItem`   | pure                      |
| `harvest/harvest.ts`           | gather all sources, write idempotently, return summary    | thin boundary             |
| `event/id.ts` (extend)         | `deriveEventId(kind, sourceKey) → string` (deterministic) | pure (additive)           |
| `event/writeEvent.ts` (extend) | optional disambiguator suffix in filename                 | thin fs (back-compatible) |

**Boundary discipline mirrors the rest of the sidecar.** The git-runner (a function returning
`git log` stdout) is **injected** into `harvest.ts`, exactly as `server.ts` injects `spawn`
and `nowFn`/`randFn`, and as Slice 1's `buildIndex` injects `fs`. The pure parser/mappers take
strings and rows; the orchestrator is the only unit that touches process/fs, and its
dependencies are all injected so it is unit-testable with canned git output + an in-memory
write-capture.

The decisions/ADR sources are thin `DecisionRow → HarvestItem` maps over the **already-tested**
Slice 1 parsers (`src/index/decisionLog.ts`, `src/index/adr.ts`) — no re-parsing, no new ADR /
decisions.md parsing logic introduced.

## 4. Data Model

```ts
// harvest/gitLog.ts
interface RawCommit {
  sha: string; // full 40-hex commit hash (stable identity)
  committedAt: Date; // committer date (ISO from git), used for the event stamp
  author: string; // author name → event actor
  subject: string; // first line → event body
}

// harvest/sources.ts
interface HarvestItem {
  id: string; // deterministic event id (full source identity)
  type: EventType; // commit_recorded | decision_recorded | decision_proposed
  source: EventSource; // git | decisions_doc | adr
  actor: string;
  body: string;
  tags: string[];
  refs?: string[]; // related_to (e.g. ADR cross-refs from Slice 1 rows)
  stampAt: Date; // historical date for path/time (see §6)
  fileDisambiguator: string; // short, collision-free filename suffix (sha7 / id / hash7)
}
```

`harvest.ts` converts each `HarvestItem` to a `GovEvent` (frontmatter from id/type/source/
actor/tags/refs, body = `body`) and writes it via `writeEvent(workspaceDir, evt, stampAt,
fileDisambiguator)`.

## 5. Deterministic IDs & Idempotency (the heart of the slice)

The existing `generateId(prefix, now, rand)` is **random** and stamped by run-time — correct
for live decision events, wrong for harvest. Add an additive sibling; do **not** change
`generateId` or its existing callers.

```ts
// event/id.ts (additive)
// Full stable source identity → deterministic id. No truncation in the id itself.
export function deriveEventId(kind: "commit" | "adr" | "decision", sourceKey: string): string;
//   commit   → `evt_commit_<full-40-hex-sha>`
//   adr      → `evt_adr_<full-adr-id>`            e.g. evt_adr_ADR-0007
//   decision → `evt_decision_<full-sha256-hex>`   sha256 of the normalized bullet text
```

- **Full identity, never sha7, in the id** (user adjustment). sha7 / hash7 appears _only_ in
  the filename disambiguator and any display string.
- **Idempotency** comes from two layers: (a) the deterministic id makes re-derivation stable,
  and (b) `writeEvent`'s `wx` flag fails if the target file already exists → caught and counted
  as **skipped**, never an error or a duplicate. Re-running `harvest` with no new repo activity
  writes 0 events.
- **Filename**: `writeEvent` gains an optional `disambiguator` param appended before `.md`
  (`HH-MM-SS_<type>_<disambiguator>.md`). Existing callers omit it → unchanged filenames.
  Harvest always passes one (sha7 / adr-id / hash7) so same-second same-type items never
  collide and the path itself encodes source identity.

## 6. Stamp / Dating Rules

- **Commits**: `stampAt` = committer date → event lives under `events/YYYY-MM-DD/` of the real
  commit day (real history, good future pattern input).
- **ADRs**: `stampAt` = ADR frontmatter `date` when present (Slice 1 `DecisionRow.date`); else
  a deterministic fallback day bucket `events/undated/` with the adr-id disambiguator.
- **Decisions.md bullets**: **always content-hash based, no date reconstruction** (user
  adjustment). `id` = `evt_decision_<sha256>`; path = `events/undated/` with a `hash7`
  disambiguator. (If a bullet happens to carry a parseable date in its own text, it is _not_
  used to backdate this slice — explicitly deferred.) Idempotency still holds via the content
  hash.

`events/undated/` is a sibling of the `YYYY-MM-DD/` day dirs under `events/` — gitignored like
the rest, created on demand.

## 7. MCP Surface (1 new command in `server.ts`)

- **`harvest`** (no input) → runs the orchestrator with the real injected git-runner and the
  repoRoot already resolved for Slice 1 (`BOULE_REPO_ROOT` / derived from `BOULE_WORKSPACE`).
  Returns a one-line summary: `harvested: <N> new, <M> already-seen` (optionally a per-source
  breakdown). On a git failure (not a repo / git absent) → fail-soft: that source contributes
  0, the command still returns a summary (never throws).

All existing commands (`principles`/`decisions`/`decision`/`why`/`history`/`conflicts`/
`approve`/`reject`/`propose_decision`/`request_review`/`create_task`/`status`/`observations`)
are **unchanged**. `harvest` is the only addition.

> **INVARIANT #1 note:** `harvest` _writes_, but only append-only **observations** to the
> gitignored L0 store — never a decision, principle, ADR, or `decisions.md`/`decision-rails.md`
> edit, and never an auto-approval. Observing that a commit/ADR/decision-line exists is not the
> same as making a decision. The decision rails are untouched.

## 8. Error Handling (fail-soft, matching Slice 1)

- git unavailable / not a repository / empty output → 0 commit events, command still succeeds.
- Missing `docs/decisions.md` or `docs/adr/` → that source contributes 0 (Slice 1 parsers
  already degrade to `[]`).
- A malformed individual commit line / row → skip that item, never throw out of `harvest`.
- `writeEvent` `wx` collision (already harvested) → caught, counted as skipped.
- No `unwrap`-style assumptions; idempotent and safe to re-run any number of times.

## 9. Testing (headless, deterministic)

- **`parseGitLog`** (pure, inline fixture): multi-commit null-delimited output → `RawCommit[]`;
  blank/malformed lines skipped; ISO committer date parsed; subject with embedded delimiters
  handled.
- **`deriveEventId`** (pure): stable across calls; distinct kinds/keys → distinct ids; full
  identity present (no truncation).
- **`harvest` orchestrator** (injected canned git-runner + in-memory fs + write-capture):
  - all three sources produce events with deterministic ids;
  - **idempotency**: second run over the same inputs writes 0, all skipped;
  - commit events stamped under the commit day; decisions/ADR-undated under `events/undated/`;
  - git failure → 0 commit events, no throw, summary still returned.
- **`writeEvent` disambiguator** back-compat: existing no-disambiguator call path unchanged;
  disambiguator path yields the expected filename.
- **Stub-MCP round-trip** (same harness as existing server tests): `harvest` returns a summary;
  a second `harvest` reports all-skipped.
- **Gates**: governance `vitest` (+N) and `pnpm exec tsc --noEmit` clean; app
  `pnpm typecheck`/`lint`/`vitest`, Rust `cargo test`/clippy/fmt, and `src/bindings.ts`
  **all untouched** (governance/\*\* only; not Tauri IPC).

## 10. INVARIANT Compliance

| #   | INVARIANT                    | How this slice complies                                                                                                                            |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 자동화 → 결정 레일 침투 금지 | `harvest` writes append-only **observations** only (gitignored L0). Never edits ADRs/decisions/rails, never auto-approves. Observation ≠ decision. |
| 2   | 외부 토큰 keychain           | None — local `git log` + file reads only.                                                                                                          |
| 3   | 외부 네트워크 Rust           | None — no network (PR/CI/agent-run events explicitly deferred).                                                                                    |
| 4   | IPC = specta 생성            | N/A — governance MCP is a stdio server, not a Tauri command; no `bindings.ts` change.                                                              |
| 5   | bounded retry                | N/A / satisfied — on-demand single pass, no poll, no daemon, no retry loop.                                                                        |
| 6   | SQLite 마이그레이션만        | No DB at all (filesystem markdown). App SQLite untouched.                                                                                          |
| 7   | 시각 디자인 DESIGN.md        | N/A — no UI in this slice.                                                                                                                         |

Markdown (here, the gitignored event files) is the materialized L0 store, rebuildable by
re-running `harvest`. INVARIANT verification is a **separate reviewer pass** (critic) — no
self-approve.

## 11. Verification Plan

- Each pure unit (`parseGitLog`, `deriveEventId`, source mappers) and the orchestrator covered
  by unit tests (TDD: red → green).
- Idempotency proven by a two-run orchestrator test (2nd run = 0 written).
- Stub-MCP round-trip proves `harvest` wires end to end.
- Independent critic (opus, separate context) ACCEPT before commit.
- Commit only; do **not** push (standing directive; Boule stays parked).

## 12. Deferred / Follow-ups

- Pattern Detector (L0 → L1) + in-memory similarity — the next slice, now unblocked.
- pgvector + embeddings + Postgres + Docker + keyring creds — only when vector similarity
  is actually needed (corpus-size driven).
- PR / CI / agent-run L0 events via the Rust `github.rs` path.
- Persisted cursor/watermark for incremental harvest (only if full rescan ever gets slow).
- Real historical dating for decisions.md bullets (git blame) — intentionally out of scope.
- Continuous/daemon or git-hook harvesting (tension with INVARIANT #5; revisit only if needed).
