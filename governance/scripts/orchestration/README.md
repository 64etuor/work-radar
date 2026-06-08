# Boule autonomous-coding orchestration toolkit

Deterministic shell glue for driving codex/claude executor slices during the
autonomous-coding master plan (`governance/docs/plans/2026-06-08-autonomous-coding-master-plan.md`).

**Why shell:** offload the *repeatable, deterministic* parts of the dev loop off the
(expensive) LLM orchestrator — saves tokens and removes hand-wiring. The
intelligence-required parts (brief authoring, critic judgment, conflict resolution)
stay with models. This is a **bootstrap**: as M1–M6 land, `boule tick` (cron-driven,
bounded — NOT a daemon, INVARIANT #5) subsumes this loop with the harness's own
executor/reviewer/evaluator roles.

## Hard rules (do not script around these)
- **Never auto-push.** Push only on explicit user request. `main` is PR-only.
- **No self-approve.** `commit-if-accepted.sh` refuses to commit without a *separate*
  critic verdict file that says ACCEPT (gates-green alone is not enough). INVARIANT #1.
- **Isolation.** Each parallel slice runs in its own git worktree; codex runs under a
  clean hooks-free `CODEX_HOME` and `--sandbox workspace-write`.

## Scripts
| script | purpose | output |
|---|---|---|
| `new-slice-worktree.sh <name> <branch> <base>` | worktree+branch, share node_modules, scratchpad | worktree path |
| `run-slice.sh <phase> <wt> <brief>` | spawn codex (clean CODEX_HOME, workspace-write), tee, then gate | tees to `<wt>/scratchpad/<phase>-out.txt`; prints gate JSON |
| `gate.sh <wt>` | run tsc + vitest + app-drift check | one compact JSON line; exit 0 iff all green |
| `merge-slice.sh <branch>` | clean merge into current branch, else abort+report | `{"merged":bool,...}` |
| `commit-if-accepted.sh <wt> <verdict> <msg>` | commit governance/ iff verdict=ACCEPT AND gates green | `COMMITTED: <sha>` or `REFUSE: ...` |

## Loop (per slice)
```
WT=$(new-slice-worktree.sh m4-budget plan/m4-budget plan/autonomous-orchestration)
# write /tmp/boule-m4-brief.txt (model authors the brief)
run-slice.sh m4-budget "$WT" /tmp/boule-m4-brief.txt   # run in background; notified on exit
# orchestrator launches a SEPARATE critic pass -> writes verdict to <wt>/scratchpad/m4-verdict.txt
commit-if-accepted.sh "$WT" "$WT/scratchpad/m4-verdict.txt" /tmp/boule-m4-msg.txt
# integrate: from master-plan worktree -> merge-slice.sh plan/m4-budget
```

Env overrides: `BOULE_REPO`, `BOULE_WT_BASE`, `BOULE_NM_SRC`.
