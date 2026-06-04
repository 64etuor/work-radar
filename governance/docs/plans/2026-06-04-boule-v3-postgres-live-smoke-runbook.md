# Boule v3 Phase F Follow-up — Postgres Live Smoke Runbook (user-run)

> The agent must not run this without explicit approval. This smoke reads a real keychain credential
> and opens a real Postgres connection. The default governance runtime and all automated tests stay on
> PGlite.

## Scope

- Verify that the existing Postgres graph adapter contract can be wired to a real keyring resolver and
  a real Postgres opener in a later live slice.
- Exercise only the `events` / `nodes` / `edges` schema/bootstrap parity and `GraphStore` reads.
- Keep the markdown event log canonical; Postgres is a derived cache.

## Non-goals

- No pgvector extension, vector column, embeddings, similarity query, scheduler, or background sync.
- No credential body in env vars, SQLite, docs, CLI args, fixtures, or renderer code.
- No change to app SQLite migrations or `src/bindings.ts`.

## Preconditions

- User has explicitly approved this live smoke for the current session.
- A disposable Postgres database exists.
- The database credential body is already stored in the OS keychain under an agreed credential ref.
- The live slice has supplied both:
  - a keyring-backed `GraphCredentialResolver`
  - a driver-backed `GraphPostgresOpener`

## Required Fail-closed Checks

Run these before opening any DB connection:

1. No live config: `openConfiguredGraphStore({ workspaceDir })` opens file-backed PGlite.
2. Postgres config with empty `credentialRef` fails with `Postgres graph store requires credential_ref`.
3. Postgres config with no resolver fails with `Postgres graph store requires a keyring credential resolver`.
4. Resolver returning empty credential fails with `Postgres graph store keyring credential was empty`.
5. Postgres config with resolver but no opener fails with `Postgres graph store requires a Postgres adapter opener`.

## Live Steps

1. Confirm the credential ref and connection ref names only. Do not print credential bodies.
2. Resolve the credential via the approved keyring resolver.
3. Open the Postgres store via the approved opener.
4. Run schema bootstrap.
5. Rebuild from a small fixture or current workspace events.
6. Run `status()`, `getNode(id)`, and `getNeighbors(id)` against known rows.
7. Close the store.

## Expected Observations

- SQL bootstrap contains only `events`, `nodes`, `edges`, and their indexes.
- No pgvector DDL is executed.
- No credential body appears in logs, query text, docs, or test fixtures.
- Rebuild/status behavior matches the PGlite projection checksum for the same event corpus.

## Stop Conditions

- Any design requires credential material outside OS keychain.
- Any code path logs or serializes the credential body.
- Any live path opens Postgres without explicit config, resolver, and opener.
- Any task expands into pgvector schema or embeddings.
