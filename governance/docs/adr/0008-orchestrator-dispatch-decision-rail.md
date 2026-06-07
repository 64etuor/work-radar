---
adr-id: ADR-0008
status: accepted
date: 2026-06-04
decision-makers: [Boule governance track]
tags: [governance, orchestrator, automation, decision-rail]
supersedes:
---

# 0008. Orchestrator Dispatch Cannot Write Decisions

## Context and Problem Statement

**Scope**: the Boule governance sidecar (`governance/`), specifically the Phase I
`auto_dispatch` path.

Phase I adds the first autonomous execute path in Boule: an opt-in, on-demand dispatcher
can advance human-accepted plans by calling the existing Phase C `conduct_plan` executor. That
creates a boundary risk: if dispatch can approve, choose, or resolve decisions, automation has
penetrated the decision rail and the governance harness is no longer human-gated.

## Decision Drivers

- INVARIANT #1 requires decisions to remain human-gated.
- Type-1 ambiguity must halt through `decision_blocked`; it must never be self-resolved by a
  scheduler, conductor, dispatcher, timeout, or default.
- The guarantee must be structural and testable, not a prompt instruction.
- The dispatcher still needs an audit trail for allowed, denied, and failed attempts.

## Considered Options

- Option A: dispatcher can call approval or choice handlers after policy evaluation.
- Option B: dispatcher only selects already-human-accepted plan steps and calls `conduct_plan`.
- Option C: keep Phase I read-only and require a human to invoke every `conduct_plan` step.

## Decision Outcome

**Rule**: Orchestrator dispatch modules MUST NOT import or call decision write handlers, MUST NOT
emit `decision_*` events, and MUST NOT treat `BOULE_AUTO_MODE` as an approval-gate parameter.
They may emit only verdict-free dispatch audit events and may call `conduct_plan` for already
human-accepted plans. A spawned step that reaches a Type-1 boundary MUST emit `decision_blocked`
through the existing escalation path and halt until a human resolves it.

Chosen option: **B**, because it enables the narrow requested autonomy while preserving the
decision rail by construction.

### Consequences

- Good: `auto_dispatch` can make bounded progress on Type-2 plan execution without gaining
  approval authority.
- Good: denial and failure are observable through `action_denied` and
  `orchestrator_action_failed`.
- Bad: automation remains intentionally anemic; blocked plans wait indefinitely for humans.

### Confirmation

- `governance/test/orchestrator/dispatch/dispatch.test.ts` asserts that a full dispatch pass
  writes zero new `decision_*` events.
- The same test asserts `src/orchestrator/dispatch/dispatch.ts` imports no
  `decision/handlers` module.
- The same test asserts `canApprove` has no auto-mode parameter and still refuses an unreviewed
  Type-1 decision.
- `governance/test/orchestrator/dispatch/policy.test.ts` locks gate precedence:
  mode -> accepted plan -> halted -> done -> in-flight.

### Anti-Patterns

- Importing `decision/handlers` from `governance/src/orchestrator/dispatch/**`.
- Adding `approve`, `reject`, `choose`, or `decision_*` emission to an orchestrator dispatcher.
- Resolving `decision_blocked` by timeout, default, skipped step, or auto mode.
- Passing `BOULE_AUTO_MODE` into `canApprove`, `canComplete`, or `canAdvance`.

## Pros and Cons of the Options

### Option A

- Good: faster automation.
- Bad: violates INVARIANT #1 and makes policy code a hidden approval surface.

### Option B

- Good: preserves human approval while allowing bounded execution of already accepted work.
- Good: compatible with Phase C's existing halt-on-block and one-step conductor.
- Bad: cannot clear ambiguity without a human.

### Option C

- Good: safest operationally.
- Bad: leaves the agreed Phase I execute half unimplemented.

## More Information

- Related: ADR-0007.
- Implemented in: local Phase I work on `feat/boule-v3-phase-d`.
- Key files: `governance/src/orchestrator/dispatch/dispatch.ts`,
  `governance/src/orchestrator/dispatch/policy.ts`,
  `governance/test/orchestrator/dispatch/dispatch.test.ts`.
