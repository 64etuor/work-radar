---
adr-id: ADR-0001
status: accepted
date: 2026-05-27
decision-makers: []
tags: [docs, governance, agents]
supersedes:
---

# 0001. Adopt ADR Governance for Structural Decisions

## Context and Problem Statement

**Scope**: repository documentation, agent instructions, PR review, and
architecture governance.

Work Radar has used `docs/decisions.md` as a single append-only decision log.
That file is useful for Phase chronology, but it is now large and mixes
long-lived architectural rules with implementation breadcrumbs. Future agents
need a smaller, scan-friendly place for binding structural decisions.

## Decision Drivers

- Agents must be able to find binding decisions without loading the full Phase
  history.
- Small Phase trade-offs still need a lightweight chronological log.
- Accepted structural decisions must be immutable; changes require a new record.
- The documentation model should follow the proven Mirrorless_Mono ADR pattern
  while staying smaller for this single-package Tauri app.

## Considered Options

- Option A: Add `docs/adr/` for structural decisions and keep
  `docs/decisions.md` as a historical Phase log.
- Option B: Keep only `docs/decisions.md`.
- Option C: Replace `docs/decisions.md` entirely with ADRs.

## Decision Outcome

**Rule**: Work Radar MUST use `docs/adr/` for structural, costly, or
cross-cutting decisions, and MUST keep `docs/decisions.md` for short Phase-level
breadcrumbs and chronology.

Chosen option: "Option A", because it preserves existing history while giving
future agents a binding decision index with explicit lifecycle rules.

### Consequences

- Good: Agents can load `docs/adr/README.md` and the relevant ADR instead of
  scanning the entire historical log.
- Good: Existing Phase notes remain intact and do not need a risky migration.
- Good: ADR immutability prevents accepted architecture from being silently
  rewritten.
- Bad: Some decisions may have both an ADR and a short `docs/decisions.md`
  breadcrumb; reviewers must keep the boundary clear.

### Confirmation

- `AGENTS.md`, `CLAUDE.md`, `docs/areas/area-map.md`,
  `docs/areas/git-conventions.md`, and the PR template route structural
  decisions to `docs/adr/`.
- New ADRs use `docs/adr/ADR-0000-template.md`.
- Accepted/rejected ADR bodies are treated as frozen except typo and link fixes.

### Anti-Patterns

- Put a long-lived architecture rule only in `docs/decisions.md`.
- Edit the body of an accepted ADR to change the decision.
- Create ADRs for tiny single-file implementation details.
- Delete historical `docs/decisions.md` entries while migrating guidance.

## Pros and Cons of the Options

### Option A

- Good, because it separates binding architecture from chronological notes.
- Good, because it matches the Mirrorless_Mono ADR convention without copying
  its package-level routing model.
- Bad, because contributors must decide whether a note is ADR-worthy.

### Option B

- Good, because it keeps one file.
- Bad, because the file is already too broad for fast agent routing.
- Bad, because it has no explicit lifecycle or immutability rule.

### Option C

- Good, because all decisions would share one format.
- Bad, because migrating the existing Phase log would be noisy and low value.
- Bad, because small operational breadcrumbs would become over-formalized.

## More Information

- Related: [ADR README](./README.md).
- Related: [decisions log](../decisions.md).
- Key files: `AGENTS.md`, `CLAUDE.md`, `docs/areas/area-map.md`,
  `.github/PULL_REQUEST_TEMPLATE.md`.
