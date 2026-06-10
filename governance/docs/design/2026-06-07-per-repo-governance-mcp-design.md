# Per-Repo Governance MCP — operate Boule in each designated local repo (personal/work differently)

- **Date**: 2026-06-07
- **Status**: design approved (brainstorm 2026-06-07); spec for implementation.
  **As-built note (2026-06-10):** implemented and operating (per-repo `.boule/` sidecar live).
  Post-dating this spec, graduated autonomy added `overrides.autonomyLevel`
  (manual<dispatch<auto_plan<full) to `boule.config.json` and `BOULE_AUTONOMY_LEVEL` to the
  generated `mcp.json` env — see ADR-0009/ADR-0010 for the as-built schema; this spec's §B/§D.4
  field lists predate that feature.
- **Branch**: `plan/autonomous-orchestration` (continues the live-autonomy track)
- **Depends on**: Boule v3 (A–I on dev) + the 2026-06-07 live-autonomy work (L0–L6).

## Problem

The Boule governance MCP operates on a single workspace (`BOULE_WORKSPACE` ?? `work-radar/governance/workspace`). The owner wants it to operate **inside each local repo they designate** in work-radar (the `repos` rows with `provider='local'`), with **personal vs work repos behaving differently**, a defined **folder structure**, and the per-repo policy **changeable from settings** (not frozen at init).

## Decisions (from brainstorm)

1. **Workspace location**: repo-internal `<repo>/.boule/` sidecar (gitignored derived state; one committed config file).
2. **Differences personal↔work**: (a) **autonomy level** and (b) **external-action gating** — NOT executor default, NOT storage-only.
3. **Discovery/scoping**: `.boule/boule.config.json` + a lightweight launcher. The work-radar sqlite is read **once at `init`** to stamp `kind`; no runtime coupling between the governance package and the app DB.
4. **Editable from settings**: `boule.config.json` is the mutable source of truth, re-read on every launch; editable via a `boule set` CLI **and** the work-radar Settings UI (same JSON contract).
5. **Decision rail unchanged**: `accept_plan`/`accept_spec` stay human gates regardless of kind. Per-kind policy only tunes **post-acceptance** autonomy (INVARIANT #1 intact).

## A. Folder structure (per designated local repo)

```
<local-repo>/
  .boule/
    boule.config.json     # COMMITTED — self-describing: schemaVersion, projectId, projectName, kind, overrides?
    workspace/            # GITIGNORED — governance event store (events/ specs/ plans/ tasks/ sessions/ handoffs/ state/ index/)
    worktrees/            # GITIGNORED — per-step conductor worktrees (was a global root)
    mcp.json              # GITIGNORED — generated MCP client config scoped to this repo
  .gitignore              # gains: .boule/workspace/  .boule/worktrees/  .boule/mcp.json
```

- Only `boule.config.json` is committed (records `kind` so the repo is self-describing). Everything derived is gitignored.
- Conductor worktrees move from a global root into `<repo>/.boule/worktrees/` so each repo's autonomy stays inside that repo.

## B. boule.config.json schema (the mutable settings surface)

```jsonc
{
  "schemaVersion": 1,
  "projectId": "prj_...",          // from work-radar (informational)
  "projectName": "...",            // informational
  "kind": "personal" | "work",     // drives default policy
  "overrides": {                   // OPTIONAL — any field overrides the kind default
    "autoMode": "off" | "type2",
    "reviewQuorum": 1,
    "forbiddenDecisionClasses": ["scope", "architecture", ...],
    "allowedType2Actions": ["edit", "test", "lint", ...]
  }
}
```

`deny_unknown_fields`-style strict parse with a fail-closed fallback to the **strict (work)** policy on any parse/validation error (safe direction).

## C. Per-kind policy (resolvePolicy)

| Knob                                   | **work** (strict default)                                   | **personal** (loose default)      |
| -------------------------------------- | ----------------------------------------------------------- | --------------------------------- |
| `autoMode` → `BOULE_AUTO_MODE`         | `off` (manual `conduct_plan` only)                          | `type2` (`auto_dispatch` allowed) |
| `reviewQuorum` → `BOULE_REVIEW_QUORUM` | `2`                                                         | `1`                               |
| envelope `forbiddenDecisionClasses`    | full set incl. `dependency`/`security` etc. → must escalate | narrower (more autonomous)        |
| envelope `allowedType2Actions`         | `["edit","test","lint"]`                                    | broader                           |

`overrides` win field-by-field over the kind default. The resolver is **pure** (`resolvePolicy(kind, overrides) → ResolvedPolicy`).

## D. Components (new, in `governance/`)

1. **`src/repo/paths.ts`** (pure) — repo root → `.boule/{workspace,worktrees,mcp.json,boule.config.json}` paths.
2. **`src/repo/config.ts`** (pure) — `parseBouleConfig(json)` (strict, fail-closed) · `resolvePolicy(kind, overrides) → ResolvedPolicy` · `serializeConfig(config)` (stable key order for clean diffs).
3. **`src/repo/configIo.ts`** (thin IO) — `readConfig(repoRoot)` · `writeConfig(repoRoot, config)` (atomic) · `mcpConfigJson(repoRoot, policy)`.
4. **`src/cli/boule.ts`** (launcher + admin CLI), subcommands:
   - `boule run --repo <path>` — read config → `resolvePolicy` → set env (`BOULE_WORKSPACE`, `BOULE_REPO_ROOT`, `BOULE_CONDUCTOR_WORKTREES_ROOT`, `BOULE_AUTO_MODE`, `BOULE_REVIEW_QUORUM`, `BOULE_CONDUCTOR_MODE` passthrough, …) → exec `src/mcp/server.ts`. One server instance per repo.
   - `boule init --repo <path> [--kind k | --from-work-radar]` — scaffold `.boule/`, write config (kind via `--kind` or read once from work-radar sqlite), patch `.gitignore`, generate `mcp.json`. Idempotent.
   - `boule set --repo <path> [--kind k] [--auto-mode m] [--review-quorum n] …` — mutate `boule.config.json` (validated) + regenerate `mcp.json`. The CLI half of "changeable from settings".
   - `boule init --all` — read the repos table, scaffold every `provider='local'` repo.
   - `boule status --repo <path>` — print resolved policy + workspace paths (read-only).

## E. Policy → envelope/server wiring

- The conductor's `buildEnvelope` defaults become **policy-driven**: `forbiddenDecisionClasses` / `allowedType2Actions` come from `ResolvedPolicy` (threaded like `executor` already is via the conductor deps).
- `autoMode` / `reviewQuorum` are already env-driven in `server.ts`; the launcher sets them from policy — minimal server change (the policy→env mapping lives in the launcher).
- Re-read on every launch ⇒ a settings change takes effect on the next server start (documented; no hot-reload in v1).

## F. work-radar Settings integration (the "from settings" surface)

- **Contract, not coupling**: the app Settings UI writes `<repo>/.boule/boule.config.json` per the §B schema (kind toggle + policy overrides). The governance package owns the schema + validation; the app owns the UI.
- v1 governance deliverable provides the schema + `boule set` CLI + `boule status`. The app-side Settings panel (React + Rust IPC writing the JSON, or shelling `boule set`) is **Slice 2** (separate, app-side; bindings/drift gate applies there).

## G. Invariants / safety

- INVARIANT #1: kind only tunes post-`accept_plan` autonomy; human gates unchanged; fail-closed to **work/strict** on any config error.
- INVARIANT #6: governance state is the repo-internal `.boule/workspace` (separate from app sqlite); no migrations touched.
- Worktrees stay inside `<repo>/.boule/worktrees/` (isolation); never the user's working tree.
- External writes still go only through the work-radar External Action Gate (governance is proposal-only) — the per-kind "external gating" knob is realized via the **autonomy envelope** (forbidden classes), not new network paths.

## H. Testing

- Pure: `parseBouleConfig` (valid/invalid/unknown-field/fail-closed), `resolvePolicy` (work vs personal defaults, override precedence), `paths` (path computation).
- IO: `readConfig`/`writeConfig` round-trip (tmpdir), `init` scaffolds expected tree + idempotent, `set` mutates + revalidates, `.gitignore` patch is additive.
- Launcher: env composition asserted (resolvePolicy → env map) without exec.
- e2e (node 22+): `boule init` a throwaway repo → `boule run` → MCP `status`/`readiness` reflects the repo's policy.

## I. Scope / out

- **In (Slice 1)**: §D components + §C policy + §E wiring + §H tests + runbook update.
- **Out (Slice 2, app-side)**: the work-radar Settings UI panel + Rust IPC (writes the §B JSON / shells `boule set`).
- **Out**: hot-reload of config in a running server; per-step kind (run-level only); multi-tenant single-server (one instance per repo is the model).
