# Governance Approval Finding (ADR) + Dev-DB Skew Fix — Design

**Date:** 2026-06-01
**Branch:** `feat/governance-boule-p1` (parked, unpushed)
**Scope:** `docs/adr/` (new ADR) + `src-tauri/src/lib.rs` (dev DB path resolution). No
migration, no `bindings.ts`, no FE change.

## Why

Two outcomes of this session's investigation into "governance `ask_user` MCP tool":

1. **The elicitation approach is architecturally refuted** — needs to be recorded so no
   future session re-attempts it. Evidence (file:line):
   - Hermes builds its MCP client as stock `mcp.ClientSession(read, write, **sampling_kwargs)`
     (`~/.hermes/hermes-agent/tools/mcp_tool.py:1466,1489`) — **no `elicitation_callback`**, so
     it never declares elicitation capability to the MCP servers it loads.
   - MCP SDK `server.elicitInput` (`@modelcontextprotocol/sdk` 1.29.0,
     `server/index.js:351-366`) throws `"Client does not support form elicitation"` unless the
     client declared `elicitation.form`.
   - work-radar declares only `clientCapabilities: { fs: {}, terminal: false }` to Hermes
     (`src-tauri/src/hermes_agent/acp_client.rs:182`); the only human-ask primitive bridged
     end-to-end is ACP `session/request_permission` → the P2b card.
   - Hermes has no elicitation handling outside its codex adapter; it bridges its **agent's
     tool-call approval** to ACP `request_permission` (`acp_adapter/server.py:1404`).

2. **The dev-DB migration skew blocks every in-app GUI smoke** on this branch and must be
   resolved durably to unblock verification.

## Part 1 — ADR 0007: governance approval via Hermes-native ACP, not MCP elicitation

New `docs/adr/0007-governance-approval-via-hermes-native-acp.md` (status: accepted), following
`ADR-0000-template.md`:

- **Context**: governance sidecar needs human sign-off (Type 1 approve gate, spec §5.2)
  surfaced as a tappable card.
- **Considered**: (A) governance MCP `ask_user` via `server.elicitInput`; (B) Hermes-native
  tool-call approval → ACP `session/request_permission` → P2b card; (C) extend Hermes to bridge
  MCP elicitation (out of lane — `~/.hermes` is the skills track / separate repo).
- **Decision**: **B**. The governance MCP server stays pure decision logic; the human surface is
  the agent runtime's existing ACP approval path, already carded by P2b. `ask_user`/`send_file`
  MCP tools (spec §5.1) are **superseded** for the approval use-case.
- **Confirmation**: the elicitation refutation is reproducible from the cited files; the chosen
  path is exercised by P2b's headless tests + (once unblocked) the in-app card smoke.
- **Anti-pattern reviewers reject**: re-introducing `server.elicitInput` in the governance
  server, or adding UI tools to the sidecar.
- **More Information**: relates to the P2b card design + the main harness design §5.1/§5.2.

This is a structural decision → ADR (per CLAUDE.md), not a `decisions.md` line.

## Part 2 — dev DB path env override

### Problem (confirmed)

`lib.rs:344-351` resolves the dev DB path as hardcoded `std::env::temp_dir() /
work-radar-dev / work-radar.db`. The shared macOS-GUI dev DB
(`/var/folders/st/…/T/work-radar-dev/work-radar.db`) is at migration **40** (skills track:
0038 skill_tags, 0039 skill_audit_log, 0040 skill_source); this branch ships up to **0037**.
A branch binary opening a v40 DB → `Migrate(VersionMissing(38))` panic at boot. Not a Boule
defect — environment skew.

### Change

Extract a **pure helper** in `lib.rs` and unit-test it:

```rust
/// Resolve the SQLite path. The dev override is honored ONLY for dev builds — a release
/// build always uses the app-data prod SSOT, never an env-supplied path (safety).
fn resolve_db_path(
    is_dev: bool,
    dev_override: Option<&str>,
    temp_dir: &Path,
    app_data: &Path,
) -> PathBuf {
    if is_dev {
        if let Some(ov) = dev_override.filter(|s| !s.is_empty()) {
            return PathBuf::from(ov);
        }
        return temp_dir.join("work-radar-dev").join("work-radar.db");
    }
    app_data.join("work-radar.db")
}
```

The setup hook reads `WORK_RADAR_DEV_DB` (via `std::env::var`) and threads it in. Unset/empty →
today's behavior, byte-for-byte. The existing `tracing::info!(code="db.path_selected")` stays
(optionally add whether the override was used — no PII, just a bool).

### Why this option

Over the alternatives: moving the shared DB aside resets a resource concurrent GUI sessions
use **and** re-skews on the next skills migration; copying 0038–0040 into this branch is a
parking / cross-track violation. The env override is dev-only, prod-untouched, backward
compatible, reversible, and durable.

## Testing

- **Rust unit tests** (`lib.rs` `#[cfg(test)]`) for `resolve_db_path`:
  - `is_dev=true, override=Some("/x/y.db")` → `/x/y.db`
  - `is_dev=true, override=Some("")` → default temp path (empty treated as unset)
  - `is_dev=true, override=None` → `temp/work-radar-dev/work-radar.db`
  - `is_dev=false, override=Some("/x/y.db")` → `app_data/work-radar.db` (**override ignored in prod**)
- Gates: `cargo test` + `cargo clippy --all-targets -- -D warnings` + `cargo fmt --check`.
  No migration / `bindings.ts` / FE change → stated explicitly, not claimed-passed.

## Unblock payoff (verification of the fix's purpose)

Run `pnpm tauri dev` with `WORK_RADAR_DEV_DB=<branch-local fresh path>` → expect a clean boot
migrating a fresh DB to 0037 (skew gone), observed via boot logs / `db.path_selected`.

**Honest boundary**: full card _interaction_ e2e (tapping the P2b card live, governance
approve→card) may still require a user-driven or cmux-driven GUI session. The deliverable here
is "app boots past the `VersionMissing` panic" — the skew resolution — plus whatever of the
card smoke is observable. Anything not run is recorded "could not run", not "passed".

## INVARIANT compliance

- **#6 SQLite migrations-only**: no schema change; this only selects _which_ DB file dev opens.
- **#4 specta**: no IPC/bindings change.
- Prod SSOT safety: the override is dev-only — a release build can never be redirected by env.
- No push (Boule parked).

## File touch list

- `docs/adr/0007-governance-approval-via-hermes-native-acp.md` — new ADR.
- `src-tauri/src/lib.rs` — `resolve_db_path` helper + `WORK_RADAR_DEV_DB` read + `#[cfg(test)]`.
- `docs/decisions.md` — done-line(s) after reviewer ACCEPT.
