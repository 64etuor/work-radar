# External Action Gate — code-review follow-ups (next-session goals)

- Date: 2026-06-04
- Source: `/code-review` (high-effort recall) on `origin/feat/external-action-gate-mcp...HEAD` (Phase 2 preconditions + Phase 2-PR1).
- Branch `feat/external-action-gate-mcp`, local tip `8362457` (6 commits ahead of origin `71d9dba`, **unpushed** — push only on explicit user request).
- Worktree: `.claude/worktrees/skills-mgr-migration`. cargo from `src-tauri/`, `export PATH="$HOME/.cargo/bin:$PATH"` first. bindings regen = `cargo test`. done = critic(opus, separate ctx) ACCEPT.

## Already fixed this session (commit `8362457`)

- **#2** enqueue race: benign "winner went terminal mid-race" now re-inserts via a bounded loop instead of surfacing a raw UNIQUE error (`enqueue_with_idempotency`, `store.rs`).
- **#16** dropped stale `allow(dead_code)` on `project_ref_for`.

## Remaining findings → goals (ordered by leverage)

### GOAL 1 — PR2: MCP write tools + project_ref VALIDATION (closes #11, highest severity)

**Why first:** #11 (the auth-isolation finding) and the PR1-critic precondition are the _same thing_, and PR2 is already the in-progress task. The gate currently trusts a raw stored `project_ref` and feeds it to `keychain::get_token` with no ownership check (`commands/external_actions.rs` `github_writer` → `store::project_ref_for`). Today it's latent (only `wr_propose_noop` exists, passes `project_ref=None`); it becomes a live cross-profile credential-injection vector the moment a proposer can set it.
**Do:**

- `wr_list_projects` MCP read tool → `[{id, name, kind}]` (reuse `commands::projects::list_projects` / `models::Project`; do NOT expose `credential_ref`).
- `wr_github_comment` / `wr_github_create_issue` write tools: take `project_id` (+ op params), **validate `project_id` resolves to a real project via the `projects` table** (`tokens::project_credential_ref(db, project_id)` → reject unknown/unowned), resolve `credential_ref`, then `store::enqueue_with_idempotency(.., project_ref = cref, idempotency_key = <stable content hash>)`. Never accept a raw `project_ref`/`credential_ref` from the proposer.
- Idempotency key MUST be content-derived/stable (see `enqueue_with_idempotency` doc) — e.g. hash of `(kind, project_id, repo, issue_number|title, body)`. A per-attempt UUID defeats dedup.
- MCP `schema_tests` for the new param DTOs (additionalProperties:false + field/required), extend the existing pattern in `mcp/mod.rs`.
- Approval-panel preview should make the **target project (personal/work) visible** so the human sees which identity will act (defense-in-depth for #11).
  **Acceptance:** unknown `project_id` → tool returns error, nothing enqueued. Valid → enqueued with `project_ref=cref`. Dedup on repeated identical proposal. cargo/clippy/fmt/tc/lint/vitest green + bindings drift only additive. critic ACCEPT.

### GOAL 2 — Transactional finalize + reconcile (#3, #10) — the deepest fix

**Root cause shared by #3 and #10:** `approve()` does CAS→`SELECT payload`→`execute`→finalize as **separate, non-transactional** statements, and the success/fail finalize UPDATEs are **unconditional `WHERE id=?`** (not status-guarded). So:

- **#3:** connector write succeeds, then the `UPDATE ... 'succeeded'` errors via `?` → row stuck `executing` → reaper later marks it `failed` (false "failed" after a real external write) + frees the idempotency key → re-proposal double-writes.
- **#10:** on a shared DB / double-launch, the startup reaper blanket-flips ALL `executing` → `failed` with no in-flight guard; `approve`'s unconditional success UPDATE then overwrites the reaper's `failed`, leaving inconsistent audit + a freed-key gap.
  **Do (pick the smallest correct combination):**
- Make finalize UPDATEs **status-guarded** (`... WHERE id=? AND status='executing'`) so a concurrent reaper and the connector can't silently clobber each other; detect 0-rows-affected and reconcile.
- On connector **success**, persist `result`/`external_ref` durably and ensure the row reaches `succeeded` even if the first finalize UPDATE fails (retry the finalize, or record external_ref to audit _before_ the status flip so a later reaper sees "write happened" and does NOT relabel as failed). The invariant: **a completed external mutation must never be reported as `failed`.**
- Reaper: don't blanket-reap. Either (a) document+enforce single-instance execution, or (b) add an in-flight guard (e.g. an `executing` lease/heartbeat with an expiry, like `recover_stale_heartbeats`) so a sibling instance's genuinely-live action isn't reaped. Note `WORK_RADAR_DEV_DB` shared-dev-DB is the realistic trigger.
  **Acceptance:** test that a finalize-UPDATE failure after connector success does NOT end as `failed` (reconcile path); test status-guarded UPDATE rejects a stale write. critic ACCEPT.

### GOAL 3 — Duplicate-write hardening across lost-response (#5)

**Finding:** `WRITE_MAX_ATTEMPTS=1` stops _retry_ double-writes, but a POST that reached GitHub then lost its response is reported `failed` → human re-proposes → duplicate comment/issue. idempotency_key dedups _proposals_, not API effects, so the at-most-once impression doesn't fully hold.
**Do (decide per-connector, document the choice):**

- Prefer a **check-before-write / read-back** on re-proposal: before creating, scan recent comments/issues for an identical body+author within a window, or record the last `external_ref` per idempotency_key and surface "possibly already created" to the human.
- Or use any GitHub-side idempotency affordance where available.
- Minimum bar if neither: make the residual **explicit in the approval UI** ("a transient failure may mean the write partially applied — verify before re-approving") and in `mcp-server-conventions.md`.
  **Acceptance:** documented decision in `decisions.md`; if a mechanism is added, a test for the dedup-on-reproposal path. critic ACCEPT.

### GOAL 4 — Surface completeness (#7, #8) — cheap, do alongside PR2

- **#7 list_pending LIMIT 200 hides the NEWEST** (ORDER BY created_at ASC) with no signal beyond a server-side warn. Add a `total`/`truncated` field to `PendingList` (MCP) and/or `PendingAction` surface so the human + polling agent know the list is capped; consider returning newest-or-paginated. (`store.rs` list_pending, `mcp/mod.rs`, FE `PendingActionsPanel`.)
- **#8 reaper only runs in the GUI Tauri setup closure**; the `--mcp-stdio` path returns before setup, so an MCP proposer can be blocked by a GUI-crash zombie key (it dedups to the dead `executing` row forever). Run `recover_interrupted_actions` (cheap, idempotent) on the `--mcp-stdio` startup path too (`mcp/run.rs::run_mcp_stdio`, after `init_db`). ⚠️ if GOAL 2 adds a lease/guard, apply the same guard here so the MCP-path reaper also doesn't reap a live GUI-instance action.
  **Acceptance:** truncated flag present + asserted; mcp-stdio smoke shows reaper runs. critic ACCEPT.

### GOAL 5 — Seam cleanup BEFORE Phases 3-5 extend it (#12, #13)

- **#12 (do before any new connector):** `GithubWriter` returns the gate's `ExecOutcome` directly (drop the parallel `GithubWriteOutcome`, or make it a type alias). Today `execute_github_action` maps field-by-field, so when Phases 3-5 add a field to `ExecOutcome` the GitHub path silently drops it with no compile error. (`github.rs`.)
- **#13:** extract a shared `github_provider_for_cref(&cref) -> Result<HttpPrProvider, AppError>` and call it from BOTH `commands/pr_radar.rs` and `ExternalActionRouter::github_writer` (the token→client recipe is duplicated; error codes already drift — `pr_radar.token_missing` vs `external_action.github_token_missing`).
  **Acceptance:** one source for the outcome shape + the provider recipe; cargo/clippy green. critic ACCEPT.

## After these: continue the original Phase 2-5 plan

PR3 (FE GitHub preview) → Phases 3-5 (Notion/Calendar/Gmail) each add ONE arm to the 3 shared spots (router `match` in `commands/external_actions.rs`, `execute_github_action`-equivalent dispatch, `kind_str`). Live external-API smoke = user (agent can't). Master spec: `docs/superpowers/specs/2026-06-04-external-action-gate-mcp-design.md`.

## Caveats (this worktree)

- Tool output can interleave/dup; verify git state with shell equality (`git ls-remote` vs HEAD), not memory. SHA-confab risk.
- `Db` = `SqlitePool` alias (use `&pool`/`db.inner()`). New PK ids = `i32` (no specta i64). FE commit: `pnpm exec prettier --write` first.
- Foreground `sleep` blocked → use background + until-loop. cargo needs `$HOME/.cargo/bin` on PATH (also for husky pre-commit fmt).
