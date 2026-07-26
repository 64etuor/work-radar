# Governance Sidecar

`governance/` is the Boule control-plane package within Work Radar. It has an
independent TypeScript/Vitest lifecycle, but it inherits the repository root
working agreement and its decision rails.

## Start Here

Before changing `governance/**`, read in this order:

1. Root `AGENTS.md` and `docs/areas/area-map.md` row 17.
2. `governance/docs/INDEX.md` for the stable documentation router.
3. `governance/docs/STATUS.md` for the only live queue/status ledger.
4. `governance/docs/conventions.md` for canonical placement and naming.
5. Only the routed design, plan, ADR, runbook, or harness document needed by
   the touched module.

## Boundaries

- CLI entrypoint: `src/cli/boule.ts`; executable wrapper: `bin/boule`.
- MCP server: `src/mcp/server.ts`; place domain tool behavior in
  `src/mcp/tools/`, never in runtime registration code.
- Bridge clients live in `bridge/`; orchestration bootstrap scripts live in
  `scripts/orchestration/` and do not auto-push.
- App-owned Tauri surfaces (ticker, Control Room, migrations, bindings) stay
  under the repository root's `src*/` and `docs/` ownership, not here.
- Tests mirror domain modules under `test/**`; Vitest is node-environment by
  default.

## Authority and State

- Event/state projections are derived. Never edit a `status:` projection or
  use plan checkboxes as runtime input.
- `INDEX.md` is routing only; `STATUS.md` is the sole moving ledger. Do not
  duplicate queue/status tables elsewhere.
- Agents and the orchestrator do not receive verdict authority. Executor MCP
  sessions must not expose verdict tools.
- `decision_blocked` never auto-resolves or times out: halt and escalate.
- `tick` and `housekeep` are bounded passes; the OS provides cadence. Do not
  add an unbounded daemon, poll, or retry loop.
- Preserve the root decision rails, including separate critic acceptance and
  no self-approval.

## Documentation Placement

Use `governance/docs/{design,plans,runbooks,harness,adr}/` according to
`governance/docs/conventions.md`. New repository-wide decision breadcrumbs
belong in root `docs/decisions.md`; `governance/docs/decisions.md` is frozen.

## Verification

`docs/reference/commands.md` is the canonical command index. Use its
Governance section from `governance/`; for orchestration-script changes, run
the focused script test or `scripts/orchestration/gate.sh` when applicable.
