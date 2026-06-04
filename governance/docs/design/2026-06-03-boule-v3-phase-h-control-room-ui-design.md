# SSOT Governance Harness — Boule v3 Phase H: Control Room UI (design)

- **Date**: 2026-06-03
- **Status**: design (pre-plan, parked) — 🆕 authored this session, awaiting separate plan-critic
- **Branch**: `feat/boule-v3-phase-d` (PARKED, unpushed — commit only, never push/merge/delete/deploy without explicit request)
- **Master design**: `governance/docs/design/2026-06-02-boule-v3-orchestrator-control-plane-design.md` (§12 Control Room panels/graph/colors, §13 INVARIANT posture, §10 phase sequence, Risk #5 dev-DB skew / bindings drift)
- **Depends-on**: Phase **E** (✅ DONE — orchestrator view) · Phase **F** (✅ DONE — PGlite graph index) · Phase **G** (✅ DONE — handoff axis). Reads the derived projections built in A–G.
- **Catalog**: `governance/docs/INDEX.md` (mark ✅ DONE only on separate impl-critic ACCEPT).

> **One-line:** add a **read-only** in-app Control Room — a new work-radar Tauri/shadcn **view** that
> reads the governance harness's **derived `state/*.json` projections** through a thin **specta-typed
> IPC** command and renders them as status boards. It mints **no governance events**, exposes **no
> approval surface**, and triggers **no rebuild** — it is a window onto state the harness already
> projected. First phase that touches the app shell ⇒ INVARIANT **#4** (specta drift gate) and **#7**
> (shadcn/Tailwind v4) now apply; **#1/#6** are preserved structurally.

---

## 0. Problem & Framing

Phases A–G built the execution plane (task/plan/spec/session/handoff folds), the orchestrator
cross-view, a PGlite graph index, and the handoff/continuity axis — **all observable only through MCP
stdio** (`tasks`, `sessions`, `handoff_status`, `index_status`, …). There is no **human-facing surface**
to see "what is the harness doing right now" at a glance. Master design §12 fixes the answer: a
**Control Room** = an in-app Tauri/shadcn view reading the derived projections via specta IPC.

This phase is **deliberately the last** (master §10) because it is the first to touch `src/bindings.ts`
and the app shell, re-arming the drift / dev-DB-skew risks (master Risk #5) that the headless A–G phases
avoided. The mitigation is to keep the app-side change **as thin and read-only as possible**.

### 0.1 The single most important design choice (the master §16 Phase-H fork)

> **How does the Tauri app (Rust) reach governance state?** Resolved: **the Rust IPC command reads the
> derived `governance/workspace/state/*.json` files from disk and re-exposes them as specta types.** It
> does **not** spawn the governance MCP/node runtime, and it does **not** read the PGlite index.

Rationale:

- **Read-only by construction (INVARIANT #1).** The new Tauri command has **no write path** to the
  governance event log — it only `read_to_string`s derived JSON caches. There is structurally no way for
  the UI to mint a `decision_*`/`task_*`/`session_*` event, approve, or choose. This is the strongest
  possible posture: the decision rail is unreachable from the app boundary, not merely policy-gated.
- **Smallest change.** The `state/*.json` files are already the rendered, byte-stable, fully-rebuildable
  projections of every axis (Phases A/D/E/G all ship a `render*` → `state/<axis>.json`). The UI consumes
  exactly what the harness already writes. No new node-runtime coupling, no MCP client in Rust.
- **Separate store (INVARIANT #6, Risk #5).** Governance state is a sibling package's gitignored runtime
  cache — **completely disjoint from the app SQLite DB and its migrations**. This phase adds **no app
  migration** and changes **no app SQLite schema**; the dev-DB-skew failure mode (`Migrate(VersionMissing)`)
  is not re-introduced by the data path (it remains only a *boot-smoke* concern, §8).

### 0.2 Settled scope decisions (this session — Hermes-delegated, pre-plan)

1. **Read-only passive viewer.** No write path, no approval surface, no rebuild/render trigger. The
   Control Room shows what the harness has already projected; refreshing re-reads the files.
2. **Slice 1 = the JSON-backed boards.** Of master §12's six panels, Slice 1 delivers the four that fall
   straight out of the existing flat projections: **System Overview · Agent Session Board · Handoff
   Queue · Work (Task/Plan/Spec) Lists**. The two heavy panels (**Spec/Plan Graph**, **Timeline/Replay**)
   and the **Approval/Decision Queue** are explicit non-goals this slice (§0.3).
3. **One aggregate IPC command.** `get_control_room_snapshot()` reads all existing `state/*.json` in one
   pass and returns a single typed `ControlRoomSnapshot`. One round-trip, one specta type, one read path.
4. **Graceful empty/stale.** Absent state file ⇒ empty list (not an error — the harness simply hasn't
   projected that axis yet). `generatedAt` = newest state-file mtime, surfaced as "projected Xm ago".
   A present-but-unparseable file is the only `AppError`.
5. **Suggestions & decisions deferred.** Orchestrator `suggestions` and decision/approval state have **no
   `state/*.json` projector today** (they're MCP-over-events reads). Surfacing them needs a governance-side
   `renderSuggestions`/decision projector — a separate slice. Slice 1 stays purely app-side, reading only
   the six existing rendered files.

### 0.3 What this slice is NOT (explicit non-goals)

- **No Spec/Plan Graph viz** — needs the Phase F PGlite edges, which Rust cannot read (JS/WASM). Requires
  a governance-side `state/graph.json` export first → later slice.
- **No Timeline/Replay** — event-stream rendering over `events/*.md`; later slice.
- **No Approval/Decision Queue, and no approval action of any kind.** Master §12/§13: approvals stay on
  the existing **Hermes ADR-0007 shadcn card**; the Control Room must never let the UI bypass external
  review / quorum / the `actor:"user"` gate. Even a *read-only* "pending gates" list is deferred (no
  decision `state/*.json` exists yet, and we will not couple it to an action surface in the same slice).
- **No rebuild/render trigger from the app.** Triggering a projection rebuild means spawning the
  governance node package from Rust — deferred (a later slice can add an out-of-band affordance if wanted).
- **No PGlite read, no new governance event type, no write to the decision rail, no app SQLite/migration
  change, no governance-package change at all** (Slice 1 is app-only).

---

## 1. INVARIANTs this slice must preserve (master §13)

This is the **first phase where #4 and #7 are in-scope** (prior phases were headless / UI-less).

| # | INVARIANT | Posture in Phase H Slice 1 |
| --- | --- | --- |
| 1 | automation must not penetrate the decision rail | **Structural:** the only new Rust path is `read_to_string` of derived JSON → no `decision_*`/`task_*`/`session_*`/`approve`/`choose` write path exists in the app at all. No approval surface in the UI (§0.3). |
| 2 | external tokens in keychain | No tokens, no credentials, no network. Reads local sibling-package JSON only. |
| 3 | external network calls in Rust | **No network.** Local filesystem read only. |
| 4 | **IPC = specta-generated bindings** | New command(s) are `#[tauri::command] #[specta::specta]`, registered in `collect_commands!`; `cargo test` regenerates `src/bindings.ts`; **CI `git diff --exit-code src/bindings.ts` gate must stay green** (committed, fresh). No hand-written TS IPC types. |
| 5 | bounded retry / no unbounded loops | Snapshot read is a single on-demand pass (one file read per axis). No polling loop in Rust; the UI refresh is user/`react-query`-driven (bounded, no infinite poll). |
| 6 | SQLite schema via migrations only | **No app migration, no app SQLite change.** Governance state is a separate gitignored cache. `git diff -- src-tauri/migrations` must be empty. |
| 7 | **visual design = DESIGN.md** | New view uses **shadcn primitives** (`src/components/ui/*`), **lucide** icons, **Tailwind v4 `@theme` tokens** (`--color-wr-*`, `--radius-*`), component-scoped CSS (`--cr-*`), no raw hex. Light default + `.dark` overrides. Node-status colors map master §12 → existing `wr` semantic tokens (§4.3). |

INVARIANT verification is a **separate critic pass** (opus) — self-approve forbidden.

---

## 2. Architecture — thin read-only specta bridge

```
governance/workspace/state/*.json        ← derived caches (gitignored, rebuildable from events)
  tasks.json plans.json specs.json
  sessions.json handoffs.json orchestrator-view.json
        │  (read_to_string, one pass)
        ▼
src-tauri/src/governance/snapshot.rs      ← NEW: pure-ish reader; resolves workspace dir,
        │                                    reads+parses each file, absent⇒empty, newest mtime⇒generatedAt
        ▼
commands::get_control_room_snapshot()     ← NEW #[tauri::command] #[specta::specta]
        │   -> Result<ControlRoomSnapshot, AppError>
        ▼   (collect_commands! → cargo test regenerates src/bindings.ts)
src/lib/query/governance.ts               ← NEW: react-query hook via commands.getControlRoomSnapshot() + unwrap()
        ▼
src/components/control-room/ControlRoomView.tsx   ← NEW shadcn view (4 panels), registered as View "control-room"
```

- **One stateful boundary** (`snapshot.rs` file reads); everything downstream is render-only. Mirrors the
  app's existing read-command pattern (`commands/signals.rs::list_signals` → `Result<Vec<_>, AppError>`).
- **Path resolution** (`resolve_governance_state_dir`): default = repo-root-relative
  `governance/workspace/state`; **env override `WORK_RADAR_GOVERNANCE_WORKSPACE`** (mirrors the existing
  `WORK_RADAR_DEV_DB` dev-override precedent) so dev/release/cmux can point at the right tree. Exact
  default-resolution (cwd vs. app-resource dir) is a **plan-stage detail** (§9 fork F1) — Slice 1 targets
  `tauri dev` where repo-root-relative resolution works; release packaging is out of scope this slice.

### 2.1 New modules / files

| Side | Path | Role |
| --- | --- | --- |
| Rust | `src-tauri/src/governance/mod.rs` + `snapshot.rs` | resolve dir · read+parse each `state/*.json` · build `ControlRoomSnapshot` · newest-mtime `generatedAt` |
| Rust | `src-tauri/src/commands/governance.rs` | `#[tauri::command] get_control_room_snapshot` → `Result<ControlRoomSnapshot, AppError>` |
| Rust | `src-tauri/src/commands/mod.rs`, `lib.rs` | re-export + add to `collect_commands!` (regenerates bindings) |
| TS | `src/lib/query/governance.ts` | `useControlRoomSnapshot()` react-query hook (`unwrap()` envelope) |
| TS | `src/components/control-room/ControlRoomView.tsx` + `ControlRoomView.css` | the 4-panel view + `--cr-*` scoped tokens |
| TS | `src/store.ts`, `src/lib/nav.ts`, `src/App.tsx` | register View `"control-room"` + nav item + `renderView` branch |

No governance-package files change in Slice 1.

---

## 3. IPC surface & types (specta-generated)

One command. Types are Rust structs deriving `serde::{Serialize}` + `specta::Type`; the TS shapes below
are what specta emits into `src/bindings.ts`. Field shapes **mirror the governance fold types verbatim**
(verified against `task/`, `plan/`, `spec/`, `session/`, `handoff/`, `orchestrator/` projectors).

```ts
// generated into src/bindings.ts (illustrative)
type ControlRoomSnapshot = {
  generatedAt: string | null;          // RFC3339, newest state-file mtime; null if none projected yet
  tasks: TaskRow[];                    // state/tasks.json
  plans: PlanRow[];                    // state/plans.json
  specs: SpecRow[];                    // state/specs.json
  sessions: SessionRow[];              // state/sessions.json
  handoffs: HandoffRow[];              // state/handoffs.json
  orchestrator: OrchestratorView;      // state/orchestrator-view.json (cross-fold; hasOpenBlock)
};

type TaskRow    = { taskId: string; title: string; phase: TaskPhase };
type PlanRow    = { planId: string; title: string; phase: PlanPhase };
type SpecRow    = { specId: string; title: string; phase: SpecPhase };
type SessionRow = { sessionId: string; surface: string | null; ownership: Ownership; taskId: string | null; phase: SessionPhase };
type HandoffRow = { handoffId: string; sessionId: string; phase: HandoffPhase };
type OrchestratorView = {
  tasks: { taskId: string; phase: TaskPhase; hasOpenBlock: boolean }[];
  plans: { planId: string; phase: PlanPhase }[];
  sessions: { sessionId: string; phase: SessionPhase; ownership: Ownership; taskId: string | null }[]; // SLIM — no `surface`/`title` (verified: orchestrator/project.ts)
};

type TaskPhase    = "ready" | "active" | "blocked" | "done" | "cancelled";
type PlanPhase    = "draft" | "active" | "needs_revision" | "completed" | "archived" | "superseded";
type SpecPhase    = "draft" | "accepted" | "archived";
type SessionPhase = "planned" | "opening" | "active" | "waiting" | "blocked"
                  | "context_pressure_high" | "checkpoint_requested" | "handoff_ready"
                  | "closing" | "closed" | "crashed" | "recovering";
type HandoffPhase = "requested" | "validating" | "pending" | "invalid" | "consumed";
type Ownership    = "user_owned" | "orchestrator_owned" | "external_owned";
```

- **Robustness to schema drift:** the Rust reader deserializes each file into its own typed struct;
  fields the projector may add later are ignored (serde default). An absent file ⇒ `Default` (empty vec /
  `generatedAt: null`); a present-but-corrupt file ⇒ `AppError` (terminal, code `governance.parse_failed`)
  — fail-loud only on actual corruption, fail-soft on "not yet projected".
- **Phase enums are string unions** matching the governance source exactly; the plan task that adds them
  must assert parity against the governance fold types (a drift here is a silent display bug).

---

## 4. The view (Slice 1 — 4 panels, read-only)

`ControlRoomView.tsx` is a single scrollable view, no overlays in Slice 1 (no Dialog/Dropdown ⇒ the
overlay-stack/Esc contract is **not triggered**; standard window-Esc-hides applies unchanged). A
**Refresh** affordance re-runs the query (react-query `refetch`); a header shows `generatedAt` as
"projected Xm ago" + an empty-state when nothing is projected yet.

### 4.1 Panels

| Panel | Source | Content |
| --- | --- | --- |
| **System Overview** | all + `orchestrator` | counts per axis (tasks/plans/specs/sessions/handoffs) · a health line: # blocked tasks (`orchestrator.tasks[].hasOpenBlock`), # sessions under pressure (`context_pressure_high`/`checkpoint_requested`), # handoffs `pending` |
| **Agent Session Board** | `sessions` | one card per session: phase badge, ownership chip, bound `taskId` (or "no task"), surface. Grouped by phase bucket (active / waiting-blocked / pressure / terminal). |
| **Handoff Queue** | `handoffs` | one row per handoff: phase badge, origin `sessionId`. Ordered requested→consumed. |
| **Work Lists** | `tasks`+`plans`+`specs`+`orchestrator` | three compact lists; tasks show a **blocked** badge when `hasOpenBlock` (the INVARIANT #1 coupling, surfaced for humans). |

### 4.2 Node/status color semantics (master §12 → wr tokens)

Master §12 palette mapped to existing semantic tokens (no new global tokens; §4.3 defines the local
mapping in `ControlRoomView.css` `--cr-*`):

| meaning | master color | phases | token |
| --- | --- | --- | --- |
| healthy / done | green | task `done`, plan `completed`, handoff `consumed` | `--color-wr-green` |
| active | blue | `active`, session `active` | wr accent/info |
| waiting / review | yellow | session `waiting`, plan `needs_revision`, handoff `validating` | wr warn-muted |
| pressure / handoff | orange | session `context_pressure_high`/`checkpoint_requested`/`handoff_ready`, handoff `pending` | wr warn |
| blocked / crashed / Type-1 | red | task `blocked`, session `blocked`/`crashed`, `hasOpenBlock` | `--color-wr-coral` (semantic danger, not CTA) |
| archived / derived / terminal | gray | `archived`/`cancelled`/`superseded`/`closed` | wr muted |

Exact token names resolve at plan time against `src/styles/tokens.css` (the explore confirmed
`--color-wr-coral`/`--color-wr-green` exist; the warn/info hues map to whatever wr tokens exist, else a
documented `--cr-*` local token derived from them — **no raw hex**, INVARIANT #7).

### 4.3 Frontend integration rules (from `frontend-shell.md` / `shadcn-migration.md`)

- **View registration:** add `"control-room"` to the `View` union (`src/store.ts`), a `NAV_ITEMS` entry
  (`src/lib/nav.ts`) in group `connect` with a **lucide** icon (e.g. `Radar`/`Gauge`/`Network`), **no
  default Cmd-number** (they're exhausted — palette/`Cmd+K` discovery only, like `skills`), and a
  `renderView` branch in `src/App.tsx`. `NAV_BY_VIEW` + palette pick it up automatically.
- **shadcn only:** `Card`, `Badge`, `Button` (Refresh = `variant="outline" size="sm"`), from
  `src/components/ui/*`. lucide icons only.
- **CSS namespace:** `src/components/control-room/ControlRoomView.css` with `--cr-*` tokens under the view
  root selector; never touch global `shared.css`/`tokens.css`.
- **Query layer:** `src/lib/query/governance.ts` hook uses the `unwrap()`/`IpcError` envelope
  (traceId/retryable/action) like every other view; a read failure surfaces via the standard ToastHost.
- **Frontend ownership / prettier:** run `pnpm exec prettier --write` on touched FE before commit (a
  `--no-verify` commit bypasses the husky prettier hook — memory caveat).

---

## 5. Decomposition (TDD tasks — one critic-able unit each)

1. **Rust reader** `governance/snapshot.rs` — `resolve_governance_state_dir` (+ env override) · per-axis
   typed deserialize · absent⇒empty · corrupt⇒`AppError` · newest-mtime `generatedAt`. Unit tests with a
   temp dir: all-present, some-absent, one-corrupt, none-present.
2. **IPC command** `commands/governance.rs::get_control_room_snapshot` + re-export + `collect_commands!`
   wiring; **`cargo test` regenerates `src/bindings.ts`** → commit the regenerated bindings.
3. **Phase-enum parity guard** — a Rust (or doc) assertion that the snapshot phase enums match the
   governance fold types (catches silent drift). Lightweight; could be a comment-backed test fixture.
4. **TS query hook** `lib/query/governance.ts` + `bindings.ts` types consumed; vitest for the hook's
   empty/stale/error mapping.
5. **View + panels** `ControlRoomView.tsx` + CSS — 4 panels, status-color mapping, empty/stale header,
   Refresh. Component vitest for panel grouping + badge mapping (pure helpers extracted, e.g.
   `bucketSessions`, `statusTone`).
6. **Shell registration** — `store.ts` View union, `nav.ts` item, `App.tsx` branch; vitest/typecheck green.
7. **Gates + boot smoke** — full battery (§7); `pnpm tauri dev` boot + click-to-Control-Room (agent
   cannot run GUI → **user/cmux**, §8).

Extracted **pure helpers** (grouping, status→tone, "Xm ago") are unit-tested; the view shell is thin.

---

## 6. MCP surface

**None.** Phase H adds **no** governance MCP command (Slice 1 is app-only and reads the already-rendered
`state/*.json`). The governance package is untouched.

---

## 7. Observable done-criteria (evidence, not prose)

1. With seeded `state/*.json` (tasks+sessions+handoffs+orchestrator-view present, specs absent),
   `get_control_room_snapshot` returns the parsed rows, `specs: []`, and `generatedAt` = newest mtime.
2. A corrupt `state/tasks.json` ⇒ `AppError` (`governance.parse_failed`, terminal); an **absent** file ⇒
   empty list (not an error). Both covered by Rust unit tests.
3. The Control Room view renders all four panels from a snapshot fixture; blocked tasks show the blocked
   badge (`hasOpenBlock`); empty-state shows when `generatedAt` is null. (component vitest + manual.)
4. **INVARIANT #1 structural:** `grep` shows the app has **no** write path to governance events — the
   only governance touch is `read_to_string` in `snapshot.rs` (negative check in review).
5. **Gates green:** `cargo test` (regenerates bindings) · `cargo clippy --all-targets -- -D warnings` ·
   `cargo fmt --check` · `pnpm typecheck` · `pnpm lint` (0 errors; baseline warns unchanged) ·
   `pnpm vitest run` (record real count, +N).
6. **INVARIANT #4:** `src/bindings.ts` regenerated **and committed**; CI `git diff --exit-code
   src/bindings.ts` gate passes (no drift).
7. **INVARIANT #6:** `git diff <base>..HEAD -- src-tauri/migrations` **empty**; no app SQLite schema change.
8. **Boot smoke:** `pnpm tauri dev` boots without panic and the Control Room view opens (see §8 — GUI
   click-smoke is **user/cmux**; agent reports "could not run GUI" rather than claiming pass).
9. **Separate impl-critic (opus) ACCEPT 0 blockers** — self-approve forbidden.

---

## 8. Risks → mitigation

| Risk | Mitigation |
| --- | --- |
| **UI becomes an approval bypass** (master §12/§13 top risk) | Slice 1 has **no approval surface and no write path at all**; approvals stay on the existing Hermes ADR-0007 card; "pending decisions" panel is a deferred non-goal, never co-shipped with an action. |
| **bindings.ts drift** (Risk #5) | New command is specta-annotated + in `collect_commands!`; `cargo test` regenerates; CI git-diff gate; done-criteria #6 asserts committed+fresh. |
| **dev-DB skew on boot smoke** (`Migrate(VersionMissing)` — Risk #5/MEMORY) | The data path does **not** touch app SQLite (#6), so the *feature* is unaffected; but `pnpm tauri dev` still migrates the app DB. **Plan prerequisite:** rebase app migrations onto origin/dev (or use the `WORK_RADAR_DEV_DB` override) **before** the boot smoke, since this branch trails origin/dev. Flagged, not solved here. |
| **Stale / absent state surfaces as "all healthy"** | `generatedAt` ("projected Xm ago") + explicit empty-state; absent axis renders as an empty panel labeled "not yet projected", never as a green all-clear. |
| **Path resolution differs dev vs. release** | `WORK_RADAR_GOVERNANCE_WORKSPACE` env override + repo-root-relative default; release-packaging resolution is an explicit out-of-scope fork (§9 F1) — Slice 1 targets `tauri dev`. |
| **Phase-enum drift (UI vs. governance fold)** | Parity guard task (§5.3); enums quoted from source; a drift is a display bug, caught by the guard. |
| **Reading PGlite / building graph viz creeps in** | Hard non-goal (§0.3); graph + timeline + suggestions are separate slices needing governance-side JSON exports first. |

---

## 9. Provenance / open items

- **Grounding (2026-06-03):** read the master design §12/§13, the E/F/G design specs, and the as-built
  governance projectors (`task|plan|spec|session|handoff|orchestrator/project.ts` → `state/*.json`,
  confirmed gitignored runtime caches with no render-all entry) + the work-radar app patterns
  (`commands/signals.rs` read-command shape, `lib.rs` `collect_commands!` + `export_typescript_bindings`
  test, CI `git diff` bindings gate, `capabilities/default.json`, `store.ts` `View` union, `nav.ts`
  `NAV_ITEMS`, `App.tsx` `renderView`, and the `frontend-shell`/`shadcn-migration`/`ipc-conventions`
  area docs). Two parallel Explore passes.
- **Forks resolved here:** master §16 "Control Room 권한 surface 상세" → **read-only file-read bridge, no
  approval surface, no rebuild** (§0.1/§0.3). Panel scope → **4 JSON-backed boards first** (§0.2).
- **Open forks for the plan / future slices:**
  - **F1 — release path resolution.** How to locate `governance/workspace/state` in a packaged build
    (app-resource dir vs. env vs. config). Slice 1 targets `tauri dev`; release is deferred.
  - **F2 — graph viz panel.** Needs a governance-side `state/graph.json` export (Rust can't read PGlite).
    Separate slice (governance + app).
  - **F3 — suggestions / decision panels.** Need `renderSuggestions` + a decision projector (governance
    side); the decision/approval read panel must deep-link to the Hermes card, never to an action.
  - **F4 — Timeline/Replay.** Event-stream rendering over `events/*.md`; separate slice.
  - **F5 — refresh cadence.** Slice 1 = manual Refresh + react-query staleTime; an auto-refresh (bounded,
    INVARIANT #5) is a later option.
- **This spec is pre-plan.** Next: a **separate plan-critic** pass on the implementation plan before any
  code; then TDD per §5; then a **separate impl-critic (opus) ACCEPT** before marking INDEX ✅ DONE.
  No push/merge/delete/deploy without explicit user request.
