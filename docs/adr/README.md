---
status: live
owner: repo-maintainers
last_reviewed: 2026-05-27
source_of_truth_scope: architecture decision records
---

# Architecture Decision Records

This directory holds Work Radar's architecture decision records. ADRs explain
why a structural decision exists, what alternatives were rejected, and how future
agents should verify that the decision is still being followed.

Format: MADR-style records with AI-agent-oriented fields.

## When to Write an ADR

Write an ADR when any of these are true:

| Trigger                                                                     | Example                                                       |
| --------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Multiple viable options exist                                               | SQLite schema shape vs app-config table vs JSON file          |
| The decision affects architecture, data, security, or automation boundaries | IPC command ownership, keychain posture, agent sandbox policy |
| Reversing the decision is expensive                                         | migrations, external API contracts, accepted UI primitives    |
| A future engineer will ask why the repo uses this pattern                   | tauri-specta generated bindings, local DB as SSOT             |
| A standard exists but is only implicit                                      | docs area routing, reviewer pass separation                   |

Do not write an ADR for a local implementation detail, a trivially reversible
single-file choice, or a Phase note that only needs a chronological breadcrumb.
Use `docs/decisions.md` for those smaller Phase notes.

## File Naming

```text
{NNNN}-{kebab-case-title}.md
```

- Use a zero-padded four-digit number.
- Never reuse a number, even for rejected ADRs.
- Pick the next number with `ls docs/adr/[0-9]*.md | sort | tail`.
- Keep titles short: problem plus chosen direction.

## Status Lifecycle

```text
proposed -> accepted
         -> rejected
accepted -> deprecated
         -> superseded by ADR-XXXX
```

- `proposed`: under review, not binding.
- `accepted`: binding; body is frozen except typo/link fixes.
- `rejected`: declined and retained to avoid re-litigation.
- `deprecated`: no longer relevant, with no direct replacement.
- `superseded by ADR-XXXX`: replaced by a newer ADR.

## Immutability Rule

After an ADR is accepted or rejected, do not rewrite its body to change the
decision. Create a new ADR instead. When superseding, link both directions:

- Old ADR status: `superseded by ADR-XXXX`
- New ADR `More Information`: `Supersedes: ADR-XXXX`

## Template

Use `ADR-0000-template.md` as the starting point.

Required sections:

- YAML frontmatter
- Context and Problem Statement
- Decision Drivers
- Considered Options
- Decision Outcome with an imperative rule
- Consequences
- Confirmation
- Anti-Patterns
- More Information

## Relationship to `docs/decisions.md`

`docs/decisions.md` remains the historical Phase log and short operational
breadcrumb file. ADRs are the binding records for structural decisions.

When both exist, read the ADR first, then use `docs/decisions.md` for chronology
and implementation context.
