# Boule v3 Phase C — Live cmux Smoke Runbook (user-run)

> The agent cannot run this — it spawns real cmux sessions in your environment. This is the single live verification for Phase C (design §11). The headless path (stub adapter) is fully tested in CI (vitest 301); this proves the live cmux + git-worktree + executor-role-session wiring end-to-end.

## Preconditions
- In a cmux session (`CMUX_SOCKET_PATH` set).
- Governance deps installed: `cd governance && pnpm install --ignore-workspace`.
- `git` clean-ish (the smoke adds detached worktrees under a gitignored root).

## Env knobs (live mode)
```bash
export BOULE_CONDUCTOR_MODE=live
export BOULE_CONDUCTOR_CMUX_CMD=/Applications/cmux.app/Contents/Resources/bin/cmux   # default
export BOULE_CONDUCTOR_WORKTREES_ROOT=.boule-worktrees                                # default, gitignored, repoRoot-relative
export BOULE_WORKSPACE="$PWD/governance/workspace"                                    # where events land
```

## Steps
1. **Propose + accept a 2-step plan** (via the Governance MCP — Hermes, or a manual stdio client):
   - `propose_plan { intent: "smoke feature", steps: ["scaffold the module", "wire it up"] }` → note the `planId`.
   - `conduct_plan { planId }` BEFORE accept → must return **`REFUSED: plan must be active to conduct (is draft)`** (accept-gate).
   - `accept_plan { planId }` (this is YOU, the human gate, `actor:"user"`).
2. **Conduct step 1:** `conduct_plan { planId }` →
   - Returns `advanced step 0: task=… surface=… worktree=.boule-worktrees/boule-<plan>-step0 envelopeHash=…`.
   - **Observe:** a real cmux workspace opens, cwd = the isolated worktree; `<worktree>/.boule/{envelope.json,step-prompt.md,mcp.json}` exist; a `claude` session starts with the step prompt.
   - **Verify the session is verdict-locked:** in that session, `/mcp` (or attempt a `choose`) — the boule server it sees (executor role) exposes `escalate`/`complete_task`/reads but **NOT** `approve`/`reject`/`choose`/`accept_plan`/`accept_spec`. (If `--strict-mcp-config`/`--mcp-config` are not honored by your `claude` build, the `--disallowedTools` denylist still blocks them — confirm one of the two holds.)
3. **Finish step 1:** let the session do its work and call `complete_task { taskId }` (no open block). Then `conduct_plan { planId }` again → materializes **step 2 only** (`surface=…-step1`), cursor advanced.
4. **Force a Type-1 escalation in step 2:** instruct the step-2 session to hit a boundary so it calls `escalate { question, options, relatedTaskId: "<step2 taskId>" }`. Then:
   - `pending_escalations` surfaces the bound `decision_blocked` (carries the step-2 task id).
   - `conduct_plan { planId }` → **advances NOTHING**, reports the halting step + open decision. Repeat → still halted (no auto-default).
   - `complete_task { step2 taskId }` → **REFUSED** (open `decision_blocked`).
5. **Resolve (human only):** tap the option on your phone (the v2 Telegram bridge) or call `choose <decisionId> <option>` as the human (`actor:"user"`) — the spawned session cannot do this. Then unblock the task (`start_task`) and `conduct_plan` again → advances/completes.

## Expected invariant observations
- Conductor wrote only `task_*` / `step_bound` / `session_spawned` — grep `governance/workspace/events/**` for `decision_*` authored by the conductor → **none** (only the session's own `escalate` and your `choose`).
- Worktrees live under `.boule-worktrees/` (gitignored), never your working tree.

## Cleanup
```bash
git worktree list                 # see the boule-* detached worktrees
git worktree remove .boule-worktrees/boule-<plan>-step0   # per step, when the session is done
git worktree prune
```

## Residual live-wiring notes
- `new-workspace --cwd` vs `new-split`+`cd`: if `--cwd` workspaces are heavy in your cmux build, switch the adapter's `spawnSession` to `new-split` + an explicit `cd <worktree>` injection (design §12c).
- The session-verdict-isolation guarantee assumes your `claude` honors `--mcp-config`/`--strict-mcp-config` OR the `--disallowedTools` denylist. The **server role-gate** (`BOULE_SESSION_ROLE=executor` → verdict tools unregistered) is verified headlessly; this smoke confirms the CLI half.
- Worktree auto-cleanup, session liveness/heartbeat, and parallel multi-step fan-out are **Phase D** — not exercised here.
