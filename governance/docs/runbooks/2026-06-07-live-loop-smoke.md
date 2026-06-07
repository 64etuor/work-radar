# Live-loop smoke runbook (Boule v3 — L0/L1/L2/L3)

> Operator runbook for the **live** autonomous loop. The deterministic core is unit-tested; the
> live steps below need a real cmux surface, so they are **user/cmux-run**. Source plan:
> `governance/docs/plans/2026-06-07-boule-v3-live-autonomy-master-plan.md`.

## 0. Node version (IMPORTANT)

- **Test suite (vitest):** node 20 (CI pin `.github/workflows/ci.yml` node-version: "20"). esbuild
  transforms TS, so the `--experimental-strip-types` flag is NOT needed.
- **Runtime MCP server:** node **22+** — `package.json` `mcp` script runs
  `node --experimental-strip-types src/mcp/server.ts`, and that flag does not exist on node 20.
  Use node 22/24/26 to run the server and any live loop.

```bash
cd governance && pnpm install --ignore-workspace   # worktrees: --ignore-workspace or deps land in the parent workspace
```

## 1. L0 — Preflight (read-only, safe anywhere)

Confirms the live loop can physically run here. `ready=true` requires: `CMUX_SOCKET_PATH` set,
`cmux` binary resolves, `git worktree` works. The mode flags are advisory (so preflight is useful
before they are armed).

```bash
# via the MCP tool (preferred — exercises the real wiring):
node governance/path/to/one-shot-mcp-client.mjs preflight   # see §5 for a minimal client
# expected: "preflight ready=true" with the 3 required checks ✓
```

Required ✗ ⇒ stop and fix infra before any live step.

## 2. Hello-loop target (sacrificial — proves loop closure with zero blast radius)

Use a throwaway git repo so a real session can do trivial work in isolation.

```bash
SMOKE=/tmp/boule-live-smoke
rm -rf "$SMOKE" && mkdir -p "$SMOKE" && cd "$SMOKE"
git init -q && git commit -q --allow-empty -m "smoke base"
# gitignore the worktrees + governance derived dirs
printf '.boule-worktrees/\ngovernance/workspace/state/\ngovernance/workspace/tasks/\n' > .gitignore
git add .gitignore && git commit -q -m "ignore boule derived"
```

The **1-step plan**: "Create `LOOP_OK.md` in the worktree with the line `loop closed`."
The success criterion is a real session that (a) creates the file in its worktree, then (b) calls
`complete_task(taskId)` so `task_completed` lands in the SSOT.

## 3. L1 — First claude loop-closure (single step, live)

Arm conductor live mode pointed at a dedicated governance workspace; accept a 1-step plan; conduct
one step; observe the spawned claude session close the task.

```bash
export BOULE_WORKSPACE="$SMOKE/governance/workspace"     # dedicated derived workspace
export BOULE_REPO_ROOT="$SMOKE"                          # worktrees added from here
export BOULE_CONDUCTOR_MODE=live
export BOULE_CONDUCTOR_WORKTREES_ROOT="$SMOKE/.boule-worktrees"
# (the spawned session inherits the SCOPED executor-role MCP from .boule/mcp.json — verdict tools absent)

# 1) propose_spec / propose_plan(intent, steps=["Create LOOP_OK.md ..."]) / accept_spec / accept_plan
# 2) conduct_plan(planId)  → mints task_*/step_bound/session_spawned + spawns a real cmux claude session
# 3) watch: conductor_status(planId) shows the step bound + task active
# 4) the spawned session does the work + calls complete_task → task_completed
# 5) conduct_plan(planId) again → cursor advances / plan done
```

**Done = observed:** `LOOP_OK.md` exists in the worktree AND `task_completed` is in the workspace
events AND `conductor_status` shows the step done. Capture the event log + a screenshot.

**Executor MCP check (C2):** in the spawned session, `approve`/`choose`/`accept_plan` MUST be
absent (executor role strips them). Confirm via the session's tool list.

## 4. L2 — Multi-step + stall safety

- 2–3 step plan + `BOULE_AUTO_MODE=type2` → `auto_dispatch` advances steps without per-step human.
- Decision halt: make one step `escalate` → `decision_blocked` → next `auto_dispatch` refuses
  (`halted`) until a human `choose`.
- Stall: kill a spawned session → with `BOULE_OBSERVER_MODE=live`, `observe_sessions` emits
  `session_crashed`; `stalled_tasks` (L2 helper) surfaces the active task whose session died.

## 5. L3 — Codex peer executor

Set the step/plan executor to `codex` (envelope `executor: "codex"`). `conduct_plan` spawns
`codex exec` in the worktree instead of `claude`; loop closure verified the same way (§3).

## Minimal one-shot MCP client (node 22+)

```js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({ command: "node",
  args: ["--experimental-strip-types", "src/mcp/server.ts"], env: { ...process.env } });
const c = new Client({ name: "smoke", version: "0" }, { capabilities: {} });
await c.connect(t);
console.log((await c.callTool({ name: process.argv[2], arguments: JSON.parse(process.argv[3] ?? "{}") }))
  .content.map((x) => x.text).join("\n"));
await c.close();
// run FROM the governance dir so node_modules resolves.
```

## Failure triage

| Symptom | Likely cause | Fix |
|---|---|---|
| `bad option: --experimental-strip-types` | server launched on node < 22 | use node 22+ |
| preflight `cmux_binary ✗` | cmux not on PATH / `BOULE_CONDUCTOR_CMUX_CMD` wrong | set the binary |
| step spawns but task never completes | session didn't call `complete_task` (prompt/MCP) | check `.boule/step-prompt.md` + `.boule/mcp.json` reached the session |
| every known session shows `crashed` | observer ran with no live surfaces | only run `observe_sessions` with `BOULE_OBSERVER_MODE=live` + real cmux |
| `Cannot find package` from a /tmp script | client script outside governance/ | place the client in governance/ |
