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

## 0.5 Per-repo operation (run Boule inside a designated local repo)

Each designated local repo gets a `.boule/` sidecar (spec `governance/docs/design/2026-06-07-per-repo-governance-mcp-design.md`). Personal vs work differ by policy (work=strict, personal=loose).

```bash
# scaffold (kind from work-radar; the app passes --kind per designated local repo)
node --experimental-strip-types governance/src/cli/boule.ts init --repo <repo> --kind <personal|work>
#   → <repo>/.boule/{boule.config.json, workspace/, worktrees/, mcp.json} — 전체 machine-local
#     (.gitignore가 .boule/ 통째로 ignore — 커밋 대상 아님)

# inspect resolved policy (read-only)
node ... governance/src/cli/boule.ts status --repo <repo>

# change settings later (also editable directly in <repo>/.boule/boule.config.json, or from the
# work-radar Settings UI which writes the same JSON — Slice 2):
node ... governance/src/cli/boule.ts set --repo <repo> --kind work --auto-mode off --review-quorum 2

# run the per-repo MCP server (stdio), scoped to that repo's policy:
node ... governance/src/cli/boule.ts run --repo <repo>
# or point a client at the generated <repo>/.boule/mcp.json
```

Policy fail-closes to **work/strict** if `boule.config.json` is missing/corrupt (never silently loose). Re-read on each launch ⇒ a settings change applies on next server start.

## 0.7 오늘 손으로 켜는 법 — 재무장 의식 8단계 (disarmed 기본 상태 → 도는 루프)

> 시스템은 기본 **disarmed**로 출고된다(`tick_enabled=0`·`live_enabled=0`·attention 래치).
> 아래 8단계가 2026-06-12 기준 정확한 수동 재무장 절차다(자동화/UI 개선은
> `governance/docs/plans/2026-06-12-boule-omc-alignment-operability-master-plan.md` P1–P3).

1. **cmux 가능한 env에서 앱 실행** — `CMUX_SOCKET_PATH`가 앱 env에 상속돼야 한다(cmux pane 안에서
   `pnpm tauri dev`). 앱은 루프가 도는 동안 열어 둔다(스케줄러는 in-app — 앱 종료=루프 정지).
2. **`.boule` init 확인** — 대상 repo에 `.boule/`가 없으면 §0.5의 `boule init`.
3. **Control Room에서 ARM** — 프로젝트 행: **LIVE 토글 on**(`live_enabled` — off면 stub adapter) +
   **tick enabled on** + interval(≥30s)/max_steps 설정.
4. **attention 래치 해제** — `attention_required=1`이면 due-scan이 영구 제외한다. pending
   `needs_human`을 해소한 뒤 **Tick now**가 비-attention 결과로 끝나야 래치가 리셋된다(전용
   해제 버튼은 P1에서).
5. **plan 투입** — MCP 세션(`claude --mcp-config <repo>/.boule/mcp.json` 또는 `boule run --repo`)에서
   `propose_spec` → `propose_plan`. **모든 step에 `check.command` 또는 `check.artifact`** — check 없는
   step은 자동 완료 인증이 불가능해 `needs_human`에 박힌다(evaluator rung 배선은 P2).
6. **수락** — `autonomyLevel=full`이면 다음 tick이 auto-accept; 아니면 `accept_spec`/`accept_plan` 수동.
7. **babysit** — `halted_decision` ⇒ MCP `choose`로 해소(Telegram 자동 도달은 P3 전까지 수동
   `bridge/boule_sync_telegram.py sync-once`); `needs_human` ⇒ 원인 수정 후 Tick now; `stalled` ⇒ 재dispatch.
8. **수확** — plan 완주 후 `boule/<planId>` 브랜치를 사람이 검토·머지한다(자동 merge-back 없음 —
   의도된 게이트. 표면화는 P4).

## 1. L0 — Preflight (read-only, safe anywhere)

Confirms the live loop can physically run here. `ready=true` requires: `CMUX_SOCKET_PATH` set,
`cmux` binary resolves, `git worktree` works. The mode flags are advisory (so preflight is useful
before they are armed).

```bash
# via the MCP tool (preferred — exercises the real wiring; run FROM governance/ so node_modules resolves):
node bridge/boule-mcp.mjs preflight   # one-shot MCP client (or the inline minimal client below)
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

### 3.0 Precondition — pre-trust the worktrees root (one-time, per machine)

A spawned `claude` session in a **fresh** worktree hits the interactive **"trust this folder?"**
dialog (even under `--permission-mode bypassPermissions` / `--dangerously-skip-permissions`), and a
background cmux workspace cannot answer it → the session hangs and the loop never closes. Trust
**cascades to children**, so pre-trust the (stable, gitignored) worktrees ROOT once. Trust is keyed
by **realpath** (`/tmp`→`/private/tmp` on macOS):

```bash
python3 - "$BOULE_CONDUCTOR_WORKTREES_ROOT" <<'PY'
import json, os, sys
root = os.path.realpath(sys.argv[1])
p = os.path.expanduser("~/.claude.json"); d = json.load(open(p))
d.setdefault("projects", {})[root] = {"allowedTools": [], "hasTrustDialogAccepted": True}
json.dump(d, open(p, "w"), indent=2); print("trusted", root)
PY
```

Reversible: delete that `projects[<root>]` entry. This is an operator/environment precondition —
governance does NOT mutate `~/.claude.json` itself (it stays decoupled from the claude CLI's config).

### 3.1 Run

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

Set the step/plan executor to `codex` (envelope `executor: "codex"`, or `BOULE_CONDUCTOR_EXECUTOR=codex`).
`conduct_plan` spawns `codex exec` in the worktree instead of `claude`; loop closure verified the same
way (§3). Codex needs no folder-trust pre-seed (§3.0 is claude-only).

**Codex MCP round-trip (C2-codex) — live-confirmed wiring:** codex attaches the executor-role MCP via
`-c mcp_servers.boule-governance.{command,args,env}` (live: it lists `complete_task` and calls it). The
call requires **`-c approval_policy="never"`** — under the default policy codex blocks the MCP tool call
in headless `exec` (live failure: `complete_task (failed)` on a PermissionRequest). `buildSessionCommand`
sets this; the `--sandbox workspace-write` confinement is kept (never `--dangerously-bypass-approvals-and-sandbox`).

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
