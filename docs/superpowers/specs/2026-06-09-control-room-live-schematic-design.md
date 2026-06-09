# Control Room — Live Layered Schematic (always-on infra + readiness + work)

Date: 2026-06-09
Status: Design (approved in brainstorm; pending spec review → writing-plans)
Area: `src/components/control-room/**` (frontend-shell + DESIGN.md) · `src-tauri/src/governance/**` (ipc-conventions) · `governance/src/{snapshot,live}/**`
Builds on: Phase T4a (`boule snapshot` CLI) + T4b (`get_project_control_room_snapshot` live fold, `governance/control_room.rs`).

## 1. Problem

The Control Room renders a work schematic (Spec→Plan→Task→Session→Handoff lanes) only when there is
work to show; with zero work it shows an empty card. There is **no always-on view of the runtime
infrastructure and readiness posture**. So an operator cannot answer, at a glance and at idle:

- Is the machinery healthy? (cmux reachable, git worktree usable, boule CLI found)
- Is this project _armed_ to run unattended, or is the autonomous loop gated — and **why**?
  (This is exactly the `readiness_failed` outcome a "Tick now" produces on an un-armed project: the
  L4 readiness gate refused to dispatch. Today that verdict is invisible until you read a stored
  tick report.)

We want an **architecture-diagram-style, real-time schematic** with three always-present layers —
runtime **infra**, the **readiness** gate, and the **work** pipeline — where the infra + readiness
layers render even when no work exists, and the work lanes fill in live as work flows.

## 2. Goals / Non-goals

**Goals**

- Always render (per selected project) a layered diagram: INFRA bar · READINESS gate strip · WORK lanes.
- Surface the 5 readiness gates (preflight / conductor / observer / auto / stall) with an overall
  "armed / not armed" verdict and the blocker reasons — making `readiness_failed` self-explanatory.
- Keep the work schematic but show its lane skeleton even at zero work; per-item nodes when present;
  active sessions show live status.
- Live via **polling** (~4s), reusing the existing pull-based snapshot path.
- Strictly **read-only** (INVARIANT #1): no governance event writes anywhere on this path.

**Non-goals (YAGNI / deferred)**

- Event-push liveness (Tauri events). Polling only.
- Animated stage-to-stage transitions.
- Live session metrics: **elapsed time, step N/M, token budget.** The current fold's `SessionRow`
  has no start timestamp, so "elapsed" is not derivable; deferred until the fold/event carries a
  session-start time. Sessions show **status** (e.g. running/blocked via phase), not elapsed.
- OS scheduler / cron (separate, already-deferred Phase T5).
- Aggregating infra across projects. Scope stays **per selected project** (the existing Select).

## 3. Architecture — one read-only fold, three view layers

```
┌──────────────── Control Room · [project ▾] · <stamp> · 새로고침 ──────────────┐
│ INFRA   [cmux ●] [git ●] [boule ●] [conductor ✕] [observer ✕] [auto:manual]   │
│         [autonomy: manual] [ticker ●·60s·idle]                                │
│ READY   preflight ✔   conductor ✕   observer ✕   auto ✕   stall ✔             │
│         → ✕ NOT ARMED · "BOULE_OBSERVER_MODE!=live — crashes/stalls undetected"│  (blockers on expand)
│ ───────────────────────────────────────────────────────────────────────────  │
│ WORK    Spec        Plan        Task            Session          Handoff       │
│         (lane headers + skeleton ALWAYS; nodes fill when present;              │
│          active session node shows running status)                            │
└────────────────────────────────────────────────────────────────────────────── ┘
```

### 3.1 Data layer — extend the snapshot fold with `infra` + `readiness`

The governance fold (`governance/src/snapshot/snapshot.ts` `buildControlRoomSnapshot`, surfaced by
the `boule snapshot --repo <p> --json` CLI) gains two blocks, computed by **reusing the same
`evaluatePreflight` / `evaluateReadiness` the tick path uses** (`governance/src/live/{preflight,readiness}.ts`).
So the dashboard shows exactly what a real `boule tick` would gate on — no second source of truth.

- The CLI command (`cmdSnapshot`) is the IO boundary: it gathers `PreflightSignals`
  (`CMUX_SOCKET_PATH` presence, `cmux --version` ok, `git worktree list` ok, plus the
  `BOULE_*_MODE` / `BOULE_AUTONOMY_LEVEL` env it already runs under) and `stalledCount`
  (`deriveStalledTasks(events).length` — already available from the events it folds), then calls
  `evaluateReadiness`.
- New emitted shape (camelCase, matching the existing fold contract):
  - `infra`: a list of named checks `{ id, label, status: "ok" | "down" | "advisory", detail? }`
    derived from `PreflightReport.checks` (`cmux_socket`, `cmux_binary`, `git_worktree`,
    `conductor_mode`, `observer_mode`, `auto_mode`, `autonomy_level`). "required-but-failing" → `down`;
    advisory posture flags → `advisory`.
  - `readiness`: `{ ready: boolean, blockers: string[], warnings: string[], gates: {
preflight, conductor, observer, auto, stall }: "pass" | "fail" }` — the 5 gates the UI renders.
    `gates` is derived deterministically from the preflight/readiness result (not re-parsed from
    blocker strings).
- `conductor`/`observer`/`auto` appear in **both** blocks on purpose and are not redundant: the
  `infra` chip reports the _configured value/mode_ (what it is set to, e.g. `auto:manual`), while the
  `readiness.gates` entry reports the _unattended-safety verdict_ (pass/fail for that gate). The UI
  shows value in the INFRA row and pass/fail in the READY strip.
- Environment honesty: the CLI inherits env exactly as `boule tick` does, so on a normal app launch
  (no `BOULE_*_MODE=live`) the readiness honestly reports "not armed" — which is correct, not a bug.
- Empty/idle is valid: a repo with no `.boule` events still yields a full `infra`/`readiness` block
  (the infra probes don't depend on events) plus empty work arrays.

### 3.2 Rust — grow the typed snapshot

- `src-tauri/src/governance/snapshot.rs`: extend `ControlRoomSnapshot` with `infra: Vec<InfraCheck>`
  and `readiness: ReadinessView` (camelCase serde + `specta::Type`, drift-resilient enums for
  statuses like the existing phase enums). `parse_control_room_snapshot` is unchanged in logic —
  only the shape grows; tests extend to cover the new blocks (incl. an empty-but-valid snapshot that
  still carries infra/readiness).
- `src-tauri/src/governance/control_room.rs` (the T4b runner) is **unchanged** — it already shells
  the CLI and deserializes; the larger shape flows through. The `get_project_control_room_snapshot`
  IPC returns the extended `ControlRoomSnapshot`. `bindings.ts` regenerates (drift gate).

### 3.3 Frontend — layered view + polling

- `src/lib/query/governance.ts`: `useProjectControlRoomSnapshot` gains `refetchInterval` (~4000ms)
  so the layered view is live (today it has only `staleTime`).
- `ControlRoomView.tsx`: when a project is selected, **always** render the layered view. Remove the
  `total === 0 → hide schematic` gate; instead:
  - **INFRA bar** — new `InfraBar.tsx` (pure): renders `snapshot.infra` checks as tone chips
    (ok=green, down=red, advisory=amber), plus the project's ticker chip (enabled · interval · last
    outcome) sourced from the existing ticker list (`useProjectTickerList`), since ticker state lives
    in app SQLite, not the repo fold.
  - **READINESS strip** — new `ReadinessStrip.tsx` (pure): the 5 `readiness.gates` as ✔/✕ + an
    overall "ARMED / NOT ARMED" verdict; blockers/warnings shown on expand or hover. This is the
    visual home for the `readiness_failed` explanation.
  - **WORK lanes** — reuse `Schematic` / `SchematicNode` / edges. Stop hiding at zero: lane headers +
    skeleton always render; per-item nodes when present; the active session node shows running
    status (phase-derived; no elapsed — see Non-goals).
- No-project / no-projects → existing empty states are kept.

### 3.4 Components & boundaries

| Unit                                           | Purpose                                                         | Depends on                              |
| ---------------------------------------------- | --------------------------------------------------------------- | --------------------------------------- |
| `infra`/`readiness` fold (governance)          | compute infra checks + readiness from preflight/readiness reuse | `live/{preflight,readiness}.ts`, events |
| `ControlRoomSnapshot.{infra,readiness}` (Rust) | typed transport, drift-resilient                                | snapshot fold JSON                      |
| `InfraBar.tsx`                                 | render infra chips + ticker chip                                | `snapshot.infra`, ticker list           |
| `ReadinessStrip.tsx`                           | render 5 gates + verdict + blockers                             | `snapshot.readiness`                    |
| `Schematic` (existing, tweaked)                | always-on work lanes + session status                           | `snapshot` work arrays                  |
| `controlRoom.ts` helpers (pure)                | gate→tone, chip derivation, verdict, empty-skeleton             | —                                       |

## 4. Testing

- **governance vitest**: `buildControlRoomSnapshot` emits `infra`/`readiness` over seeded signals —
  armed (all live) → `ready:true`, gates all pass; un-armed (no env) → `ready:false`, correct gates
  fail + blockers; empty events still carry infra/readiness; stall present → stall gate fails.
- **Rust**: extend `parse_control_room_snapshot` tests for the new blocks; empty-but-valid snapshot
  carries infra/readiness; unknown status string degrades (drift-resilient).
- **frontend vitest**: pure helpers — gate→tone mapping, infra-chip derivation, ARMED/NOT-ARMED
  verdict from gates, `buildSchematic` empty-skeleton (lanes render at zero).
- **Gates** (per `docs/reference/commands.md`): cargo test + clippy + fmt; pnpm typecheck + lint +
  vitest; **bindings drift 0**; `pnpm tauri dev` boot. Live visual smoke (idle infra renders;
  un-armed project shows NOT ARMED + blockers; work appears as nodes) = user/cmux (native WKWebView).

## 5. Risks / rollback

- **Spawn cost**: one read-only `node` subprocess per poll (~4s), unchanged from T4b's single-spawn
  model — we extend the existing call, not add a second. Bounded (30s timeout, kill_on_drop).
- **Readiness accuracy**: the dashboard's posture must equal what tick gates on. Mitigated by reusing
  the same `evaluateReadiness` and inheriting the same env. If the tick path derives `auto_mode` from
  `autonomyLevel`/config rather than raw env, the fold must mirror that derivation — verified in the
  plan so the dashboard never disagrees with an actual tick.
- **Scope creep**: session live metrics (elapsed/step/budget) are explicitly deferred; this spec adds
  no new event/timestamp plumbing.
- Rollback: additive fold blocks + new presentational components; revert is removing the layers and
  the `refetchInterval`, restoring the T4b view.

## 6. Decision rails (INVARIANTS touched)

- #1 (automation off the decision rails): read-only fold; no event writes. **Held.**
- #4 (IPC = generated bindings): shape grows via specta; drift gate. **Held.**
- #6 (no ad-hoc migrations): no schema/migration change. **Held.**
- No renderer-supplied repo path: path stays DB-resolved (T4b `resolve_project_repo_path`). **Held.**

## 7. Open items for the plan (not the spec)

- Confirm how the tick path assembles `auto_mode`/posture (raw env vs derived from `autonomyLevel`)
  and mirror it in the fold so dashboard == tick verdict.
- Decide PR slicing: (A) governance fold + Rust shape + bindings; (B) frontend layers + polling.
  Likely two PRs (backend fold first, then UI), one concern each.
