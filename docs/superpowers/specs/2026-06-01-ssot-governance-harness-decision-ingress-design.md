# SSOT Governance Harness — P3 Slice 1: L3/L4 Decision/Principle Ingress (read-only adapter)

- **Date**: 2026-06-01
- **Status**: design (approved, pre-plan)
- **Branch**: `feat/governance-boule-p1` (PARKED, unpushed — commit only, never push without explicit request)
- **Parent design**: `docs/superpowers/specs/2026-05-31-ssot-governance-harness-design.md` (§2.2 Decisions/Principles 어댑터, §5.1 command set)

## 1. Problem & Context

The master design splits the governance harness into five layers. L3 (Decisions) and
L4 (Principles) **reuse existing canonical repo files** rather than re-storing them:

- L3 = `docs/adr/*.md` + `docs/decisions.md`
- L4 = `docs/areas/decision-rails.md` (the 7 INVARIANTs)

§2.2 specifies a **Decisions/Principles adapter**: parse those canonical markdown files
and expose them through the governance interface so the system can reference decisions
and principles (the `/why` / `/history` reference graph, the `principles` command).

Today none of this exists. The governance MCP server's `why`/`history`/`conflicts`
operate over the **governance event log** (`workspace/events/`), not the repo's actual
ADRs/decisions/rails. The `principles` command listed in §5.1 is **not implemented**, and
`observations` is an empty stub.

This is **P3 Slice 1**, scoped down per two decisions made during brainstorming:

1. **First P3 slice = ADR/decision ingress (no ML).** Lowest-risk foundation; no embeddings,
   no Pattern Detector yet.
2. **Index store = in-memory parse-on-load (no DB).** The corpus is tiny (7 ADRs +
   `decisions.md` + 7 INVARIANTs). Markdown stays SSOT; the index is a derived structure
   computed on demand. Postgres + pgvector are deferred to when vector similarity is
   actually needed (Pattern Detector, a later slice).

## 2. Goals / Non-goals

**Goals**

- Parse L3/L4 canonical markdown into an in-memory structured model.
- Build a reference graph (supersedes / superseded-by, `ADR-NNNN` cross-references).
- Expose three new **read-only** MCP commands: `principles`, `decisions`, `decision <id>`.
- Stay strictly read-only and fully headless/testable with no new runtime dependency.

**Non-goals (deferred)**

- Postgres / pgvector / Docker.
- Embeddings, vector similarity.
- Pattern Detector agent (L0 → L1) and `observations` population.
- Unifying the governance event id space with the ADR/decision id space inside `why`/`history`.
- Any write to ADRs / `decisions.md` / `decision-rails.md`, and any auto-decision.

## 3. Architecture & Module Boundaries

New directory `governance/src/index/`, four small single-purpose units:

| Unit             | Responsibility                                          | Purity           |
| ---------------- | ------------------------------------------------------- | ---------------- |
| `adr.ts`         | `parseAdr(content, sourcePath) → DecisionRow \| null`   | pure (string in) |
| `decisionLog.ts` | `parseDecisionLog(content, sourcePath) → DecisionRow[]` | pure             |
| `rails.ts`       | `parseRails(content, sourcePath) → PrincipleRow[]`      | pure             |
| `index.ts`       | `buildIndex(repoRoot, fs) → GovernanceIndex`            | thin fs boundary |

The three parsers take file **content strings**, never the filesystem — they are pure and
unit-testable with inline fixtures. `index.ts` is the only fs-touching unit; its `fs`
dependency (`readFile`, `readDir`) is **injected** so the assembler is testable with an
in-memory map (mirrors the existing server-boundary injection of `nowFn`/`randFn`).

This keeps each unit answerable: what it does (parse one source / assemble), how to use it
(call with content / repoRoot+fs), and what it depends on (nothing / injected fs).

## 4. Data Model

```ts
interface DecisionRow {
  id: string; // "ADR-0007" | decision-log slug (e.g. "2026-06-01-<slug>")
  kind: "adr" | "decision-log";
  title: string;
  status?: string; // ADR frontmatter (accepted/rejected/proposed/…); undefined for decision-log
  date?: string; // ADR frontmatter date / decision-log bullet date
  tags: string[]; // ADR frontmatter tags; [] for decision-log
  supersedes: string[]; // ADR-NNNN ids from frontmatter `supersedes:`
  refs: string[]; // ADR-NNNN ids mentioned in the body (deduped, self-excluded)
  excerpt: string; // first non-heading paragraph (one-line summary)
  sourcePath: string; // repo-relative path
}

interface PrincipleRow {
  id: string; // "INVARIANT-1"
  number: number;
  title: string; // "결정 레일은 사람만"
  body: string; // section text until the next "## "
  sourcePath: string;
}

interface DecisionEntry {
  row: DecisionRow;
  supersededBy: string[]; // inverse of supersedes
  referencedBy: string[]; // inverse of refs
}

interface GovernanceIndex {
  decisions: DecisionRow[];
  principles: PrincipleRow[];
  getDecision(id: string): DecisionEntry | null;
  listDecisions(): DecisionRow[];
  listPrinciples(): PrincipleRow[];
}
```

The reference graph (`supersededBy`, `referencedBy`) is the inverse of `supersedes` / `refs`,
computed once at build time over the small row set.

## 5. MCP Surface (3 new read tools in `server.ts`)

All tools are read-only and register alongside the existing ones.

- **`principles`** (no input) → lists the 7 INVARIANTs:
  `INVARIANT-1 — 결정 레일은 사람만`, … one per line.
- **`decisions`** (no input) → lists ADRs + decision-log entries:
  `ADR-0007 [accepted] — Governance Human-Approval Surface…`, decision-log rows without a status.
- **`decision <id>`** (`id: string`) → one entry detail:
  title, status, excerpt, then the reference graph
  (`supersedes`, `superseded-by`, `refs`, `referenced-by`). Unknown id → a friendly
  `not found: <id>` (no throw).

The repo root is resolved via an injected `BOULE_REPO_ROOT` env var; default = resolve
`../..` from `BOULE_WORKSPACE` (`<repo>/governance/workspace` → `governance/` → `<repo>`).
Resolved once at the server boundary, same pattern as `WORKSPACE`/`nowFn`/`randFn`. The index is built per
command invocation (cheap for this corpus) or memoized at server start — implementation
detail left to the plan; either satisfies "rebuild = re-parse".

Existing `why`/`history`/`conflicts`/`approve`/`reject`/`propose_decision`/`request_review`/
`create_task`/`status`/`observations` are **unchanged**.

## 6. Parsing Specifics & Edge Cases

- **ADR frontmatter**: split on the leading `---\n … \n---` block; read `adr-id`
  (→ `id`, e.g. `ADR-0007`), `status`, `date`, `tags`, `supersedes`. Skip files
  `ADR-0000-template.md` and `README.md`. A file with no/malformed frontmatter → `null`
  (skipped, not a crash).
- **`supersedes:` empty** → `[]`.
- **decision-log**: each top-level bullet `- **<title>(<date>)**: …` = one row; `id` =
  slugified `<title>`+`<date>`; `status` undefined; `tags` `[]`. Non-bullet lines ignored.
- **rails**: each `## N. <title>` heading → `INVARIANT-N`; `body` = text until the next
  `## ` heading. The intro before the first `## ` is ignored.
- **cross-refs**: regex `ADR-\d{4}` over the body, deduped, self-id excluded → `refs`.

## 7. Error Handling

Fail-soft, matching the existing `status()`/`conflicts()` tolerance:

- Missing file or directory → that source contributes `[]` (e.g. no `decisions.md` → no
  decision-log rows; no `docs/adr/` → no ADR rows).
- Malformed content → skip the offending item, never throw out of a command.
- No `unwrap`-style assumptions; no partial-write risk (read-only).

## 8. Testing (headless, deterministic)

- **Parser units** (pure, inline fixture strings): valid ADR; ADR with no/malformed
  frontmatter (→ null); empty `supersedes`; template/README skip; rails 7-section split;
  decision-log multi-bullet; cross-ref dedup + self-exclusion.
- **`buildIndex`**: injected in-memory `readFile`/`readDir` map → asserts the reference-graph
  inversion (`supersededBy`, `referencedBy`) and graceful degrade on a missing source.
- **Stub-MCP round-trip** (same harness as existing server tests): `principles`,
  `decisions`, `decision <known-id>`, `decision <unknown-id>`.
- **Gates**: governance `vitest` (+N) and `pnpm exec tsc --noEmit` clean;
  app `pnpm typecheck`/`lint`/`vitest`, Rust `cargo test`/clippy/fmt, and
  `src/bindings.ts` **all untouched** (governance/\*\* only; not Tauri IPC).

## 9. INVARIANT Compliance

| #   | INVARIANT                    | How this slice complies                                                                                                         |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 자동화 → 결정 레일 침투 금지 | Strictly read-only: parses & exposes L3/L4; never writes ADRs/decisions/rails, never auto-approves. Strongest possible posture. |
| 2   | 외부 토큰 keychain           | None — local file reads only.                                                                                                   |
| 3   | 외부 네트워크 Rust           | None — no network.                                                                                                              |
| 4   | IPC = specta 생성            | N/A — governance MCP is a stdio server, not a Tauri command; no `bindings.ts` change.                                           |
| 5   | bounded retry                | N/A — no retries/polling; synchronous local reads.                                                                              |
| 6   | SQLite 마이그레이션만        | No DB at all (in-memory). App SQLite untouched.                                                                                 |
| 7   | 시각 디자인 DESIGN.md        | N/A — no UI in this slice.                                                                                                      |

Markdown remains SSOT; the index is derived and rebuildable by re-running `buildIndex`.
INVARIANT verification is a **separate reviewer pass** (critic) — no self-approve.

## 10. Verification Plan

- Each parser and `buildIndex` covered by unit tests (TDD: red → green).
- Stub-MCP round-trip proves the three commands wire end to end.
- Independent critic (opus, separate context) ACCEPT before commit.
- Commit only; do **not** push (standing directive; Boule stays parked).

## 11. Deferred / Follow-ups

- pgvector + embeddings + Pattern Detector (the headline "pattern discovery") — next P3 slice.
- Postgres + Docker + keyring creds — only when vectors land.
- Unify event/ADR id namespaces inside `why`/`history`.
- `principle <id>` detail command (if listing titles proves insufficient).
- Live MCP load smoke inside Hermes (GUI; user/cmux-driven).
