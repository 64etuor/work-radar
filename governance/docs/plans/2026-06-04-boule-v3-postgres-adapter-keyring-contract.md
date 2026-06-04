# Boule v3 Phase F Follow-up — Postgres Adapter + Keyring Contract Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a deterministic graph-store adapter boundary so PGlite stays the default/test store while explicit Postgres live mode fails closed unless a keyring credential contract is available.

**Architecture:** Keep `projectGraph(events)` and `GraphStore` as the only graph behavior contract. Add a small config/adapter layer that chooses PGlite by default and treats Postgres as explicit live mode. This slice defines the keyring credential contract and fail-closed behavior; it does not add pgvector, scheduler work, or live credential/network execution.

**Tech Stack:** TypeScript, Vitest, PGlite, existing `GraphStore`, governance MCP server, OS-keychain contract modeled as an injected credential resolver.

---

## Requirements Summary

- PGlite remains the default store for tests and local governance MCP runtime.
- Postgres mode is opt-in only.
- Postgres mode must fail closed when credentials are missing, resolver is absent, or the returned credential is empty.
- No credential bodies are read from env, CLI args, SQLite, markdown, or renderer code.
- No pgvector embeddings, real Postgres smoke, auto scheduler, app SQLite migration, or `src/bindings.ts` change in this slice.
- Real OS keychain integration is deferred to a user-authorized live slice; this slice only defines the contract and deterministic selection behavior.

## Acceptance Criteria

- `openConfiguredGraphStore` selects file-backed PGlite when no live config is provided.
- `openConfiguredGraphStore` selects in-memory PGlite for explicit test config.
- explicit Postgres mode with no `credentialRef` fails before opening any DB connection.
- explicit Postgres mode with no credential resolver fails before opening any DB connection.
- explicit Postgres mode with an empty credential from the resolver fails before opening any DB connection.
- a test-injected Postgres adapter receives only `{ connectionRef, credential }`, never an env-inline password.
- governance MCP server uses the adapter selector instead of directly calling `openStore(...)`.
- `git diff --stat -- src/bindings.ts src-tauri/migrations` stays empty.

## Implementation Steps

### Task 1: Add adapter selection tests

**Files:**
- Create: `governance/test/graph/config.test.ts`
- Create: `governance/src/graph/config.ts`
- Modify: `governance/src/graph/types.ts`

**Step 1: Write failing tests**

Test cases:
- default config opens a PGlite store with `join(workspace, "index", "pglite")`.
- `{ kind: "pglite", loc: ":memory:" }` opens in-memory PGlite.
- `{ kind: "postgres", connectionRef: "...", credentialRef: "" }` throws `Postgres graph store requires credential_ref`.
- Postgres config without resolver throws `Postgres graph store requires a keyring credential resolver`.
- resolver returning `""` throws `keyring credential was empty`.
- injected Postgres opener receives `connectionRef` and `credential` from the resolver.

**Step 2: Run test and verify fail**

Run:

```bash
cd governance
pnpm exec vitest run test/graph/config.test.ts
```

Expected: fail because `src/graph/config.ts` does not exist.

### Task 2: Implement minimal config + adapter contract

**Files:**
- Create: `governance/src/graph/config.ts`
- Modify: `governance/src/graph/types.ts`

**Step 1: Add contract types**

Add:
- `GraphStoreConfig = { kind: "pglite"; loc: string } | { kind: "postgres"; connectionRef: string; credentialRef: string }`
- `GraphCredentialResolver = (credentialRef: string) => Promise<string | null>`
- `GraphPostgresOpener = (input: { connectionRef: string; credential: string }) => Promise<GraphStore>`

**Step 2: Add selector**

Add `openConfiguredGraphStore(options)`:
- computes default `{ kind: "pglite", loc: join(workspaceDir, "index", "pglite") }`.
- calls existing `openStore(loc)` for PGlite.
- for Postgres:
  - validates `credentialRef.trim()`.
  - requires `credentialResolver`.
  - resolves credential.
  - rejects missing/empty credential.
  - requires an injected `openPostgresStore` until the live adapter slice adds a real implementation.

**Step 3: Run target test**

Run:

```bash
cd governance
pnpm exec vitest run test/graph/config.test.ts
```

Expected: pass.

### Task 3: Wire MCP server through adapter selector

**Files:**
- Modify: `governance/src/mcp/server.ts`
- Modify: `governance/test/mcp/*.test.ts` only if an existing MCP startup test needs deterministic env defaults.

**Step 1: Replace direct PGlite open**

Replace:

```ts
const graphStore = await openStore(join(WORKSPACE, "index", "pglite"));
```

with:

```ts
const graphStore = await openConfiguredGraphStore({
  workspaceDir: WORKSPACE,
});
```

No env-driven Postgres live mode should be enabled unless a later slice adds the real resolver/opener path.

**Step 2: Run graph + MCP tests**

Run:

```bash
cd governance
pnpm exec vitest run test/graph test/mcp
```

Expected: pass.

### Task 4: Update design docs and index wording

**Files:**
- Modify: `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md`
- Modify: `governance/docs/INDEX.md`

**Step 1: Record this slice**

Update Phase F deferred/current wording:
- PGlite remains default and test store.
- Postgres adapter/keyring contract exists and fails closed.
- real keyring resolver, live Postgres smoke, and pgvector embeddings remain deferred.

**Step 2: Reconcile P6 wording if touched**

If editing `INDEX.md`, reconcile the stale "full gate rerun pending this checkpoint" wording with the later verified governance gate.

### Task 5: Final verification

Run:

```bash
cd governance
pnpm exec tsc --noEmit
pnpm exec vitest run
cd ..
git diff --stat -- src/bindings.ts src-tauri/migrations
```

Expected:
- typecheck passes.
- governance tests pass.
- bindings/migrations diff stat is empty.

## Risks and Mitigations

- **Risk:** adapter selection becomes a hidden live DB attempt.  
  **Mitigation:** default config is PGlite and Postgres path requires explicit injected live dependencies.
- **Risk:** credential body leaks into env/docs/tests.  
  **Mitigation:** tests use synthetic injected resolver output only; env config carries only refs.
- **Risk:** this turns into pgvector work.  
  **Mitigation:** pgvector is an explicit non-goal until live Postgres baseline is stable.
- **Risk:** governance sidecar bypasses app keychain rules.  
  **Mitigation:** this slice defines the resolver contract only; real resolver must be user-authorized and keychain-backed.

## Stop Conditions

- Stop before any real Postgres connection, real keychain read, network smoke, pgvector schema, or scheduler.
- Stop if selecting Postgres live mode would require storing credentials outside OS keychain.
- Stop if `src/bindings.ts` or `src-tauri/migrations` drift appears.
