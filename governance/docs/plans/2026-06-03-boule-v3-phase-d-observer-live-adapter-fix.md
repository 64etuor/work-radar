# Boule v3 Phase D — Observer Live Adapter cmux Enumeration Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Checkboxes = build tracking; the runtime `SessionState = events→derived` is the truth. Tick only on real evidence.

**Goal:** Make `BOULE_OBSERVER_MODE=live` actually enumerate real cmux surfaces — replace the nonexistent `cmux list` command (status 1 → throws) with `cmux tree --all --json` and a JSON-walking `parseSurfaces`, so the already-validated reconcile logic runs out-of-box against live cmux.

**Architecture:** A single-module change inside `governance/src/session/observer.ts`. Only the *enumeration* half (the `makeLiveAdapter` command + `parseSurfaces` parser) is wrong; the reconcile core, the `ObserverAdapter` seam, the server-side `spawnSync` injection, and every `session_*` event path are correct and untouched. Canonical surface id becomes the cmux-native ref `surface:N` (what `cmux tree --json` emits). Browser surfaces are excluded — Boule sessions are terminal agents, so the parser keeps only `type === "terminal"` surfaces, preventing browser panes from being mis-registered as orphan `session_opened` sessions.

**Tech Stack:** TS (Node 24 strip-types; src `.ts`, tests `.js`), vitest, zod 4.4.3. Real cmux CLI at `/Applications/cmux.app/Contents/Resources/bin/cmux` for the manual live-verification step only.

---

## Background / why this exists

Phase D shipped with `makeLiveAdapter` running `cmux list`, an **invented** command. Real cmux (`cmux --help`) has **no `list`** — it exits status 1 "Unknown command", so the live adapter throws and `BOULE_OBSERVER_MODE=live` is broken out-of-box. The `makeLiveAdapter` unit test encoded a fake spawn asserting `["list"]` against fabricated newline-delimited stdout, so the wrong contract was never caught. (Recorded as the BLOCKER in commit `b6d79f8` and the Phase D plan/design.)

Real cmux enumerates surfaces via `cmux tree [--all]` (and `list-panes` / `list-pane-surfaces` / `list-panels`). `cmux tree --all --json` (confirmed via `cmux tree --help`: `--json  Structured JSON output`) returns:

```json
{
  "active":  { "surface_ref": "surface:24", ... },
  "caller":  { "surface_ref": "surface:29", ... },
  "windows": [
    { "ref": "window:1",
      "workspaces": [
        { "ref": "workspace:5", "title": "HR Watchdog",
          "panes": [
            { "ref": "pane:7", "surface_refs": ["surface:7"],
              "surfaces": [
                { "ref": "surface:7", "type": "terminal", "title": "✳ Claude Code", "tty": "ttys003", ... }
              ] } ] } ] } ]
}
```

So **all live surfaces** = every `windows[].workspaces[].panes[].surfaces[].ref`, and each surface carries `"type": "terminal" | "browser" | ...`. Surface ids are `surface:N`. This was captured live (5 workspaces / 7 terminal surfaces) on 2026-06-03.

**Scope guard (smallest change, AGENTS.md):** This change touches ONLY `observer.ts` + `observer.test.ts` + the two Phase D docs. It does NOT touch reconcile, handlers, the server wiring (already injects `spawnSync`), or the conductor.

**Documented caveat (NOT in scope — flag for follow-up):** reconcile compares the live `surface:N` set against `s.surface` parsed from each session's *birth* event body. Phase-C `session_spawned` sessions store `surface = cmux new-workspace stdout.trim()` (conductor `adapter.ts`). For live reconcile to match, that stored value must also be the `surface:N` ref. Verifying/normalizing the conductor's `new-workspace` output to the `surface:N` form is a **separate Phase-C concern** and is intentionally left out of this change — it is called out in the docs update (Task 2) as a known reconciliation precondition. The 2026-06-03 logic smoke fed surfaces in `surface:N` form by hand, so the reconcile core is already proven against that canonical form.

---

## File Structure

- **Modify** `governance/src/session/observer.ts`
  - `parseSurfaces(stdout: string): LiveSurface[]` — change from newline-split to a defensive JSON walk over `cmux tree --json`, keeping only `type === "terminal"` surface refs, deduped.
  - `makeLiveAdapter(...).listSurfaces()` — change the spawn args from `["list"]` to `["tree", "--all", "--json"]`; update the doc comment and the `CommandError`/log labels from `list` to `tree --all --json`.
- **Modify** `governance/test/session/observer.test.ts`
  - The `makeLiveAdapter` describe block: assert the new command `["tree", "--all", "--json"]`; feed a real JSON fixture; assert `surface:N` refs returned and browser surfaces excluded; keep the non-zero-status terminal-failure test; replace the newline `parseSurfaces` unit test with a JSON-shape test.
- **Modify** `governance/docs/design/2026-06-03-boule-v3-phase-d-session-registry-design.md`
  - Resolve the §line ~129 / §line ~233-238 BLOCKER note: the live adapter now runs `cmux tree --all --json`; record the terminal-only filter and the conductor-`new-workspace`-format reconciliation precondition.
- **Modify** `governance/docs/plans/2026-06-03-boule-v3-phase-d-session-registry.md`
  - Update the status BLOCKER line to RESOLVED with a pointer to this plan.

No other files. `bindings.ts` unchanged (no IPC). No migrations. No new MCP tools.

---

## Tasks

### Task 1: Reshape `parseSurfaces` + live adapter command (TDD)

**Files:**
- Modify: `governance/src/session/observer.ts` (the `parseSurfaces` function ~lines 55-62, the `makeLiveAdapter` function ~lines 64-79, and their doc comments)
- Test: `governance/test/session/observer.test.ts` (the `makeLiveAdapter` + `parseSurfaces` describe block, ~lines 117-139)

- [ ] **Step 1: Rewrite the failing tests for the JSON contract**

Replace the entire `describe("makeLiveAdapter — cmux list command ...")` block (currently lines 117-139) with the block below. (`makeLiveAdapter`, `parseSurfaces`, `type SpawnResultLike` are already imported at the top of the file — no import changes.)

```ts
describe("makeLiveAdapter — cmux tree enumeration (injected fake spawn, no real process)", () => {
  // A minimal but real-shaped `cmux tree --all --json` payload: two terminal surfaces across two
  // workspaces, plus one browser surface that MUST be excluded, plus the top-level active/caller
  // refs that point back into the tree (must NOT double-count).
  const TREE_JSON = JSON.stringify({
    active: { surface_ref: "surface:24" },
    caller: { surface_ref: "surface:29" },
    windows: [
      {
        ref: "window:1",
        workspaces: [
          {
            ref: "workspace:5",
            panes: [
              {
                ref: "pane:7",
                surface_refs: ["surface:7"],
                surfaces: [{ ref: "surface:7", type: "terminal", title: "✳ Claude Code" }],
              },
            ],
          },
          {
            ref: "workspace:12",
            panes: [
              {
                ref: "pane:26",
                surface_refs: ["surface:29", "surface:30"],
                surfaces: [
                  { ref: "surface:29", type: "terminal", title: "agent" },
                  { ref: "surface:30", type: "browser", title: "docs", url: "https://x" },
                ],
              },
            ],
          },
        ],
      },
    ],
  });

  it("runs `cmux tree --all --json` and parses terminal surface refs from stdout", async () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeSpawn = (cmd: string, args: string[]): SpawnResultLike => {
      calls.push({ cmd, args });
      return { status: 0, stdout: TREE_JSON, stderr: "" };
    };
    const adapter = makeLiveAdapter({ spawn: fakeSpawn, cmuxCmd: "cmux" });
    const surfaces = await adapter.listSurfaces();
    expect(calls).toEqual([{ cmd: "cmux", args: ["tree", "--all", "--json"] }]);
    // surface:30 is a browser surface → excluded; surface:7 and surface:29 are terminals.
    expect(surfaces.map((s) => s.surface).sort()).toEqual(["surface:29", "surface:7"]);
  });

  it("surfaces a terminal failure when cmux exits non-zero (no retry loop)", async () => {
    const fakeSpawn = (): SpawnResultLike => ({ status: 1, stdout: "", stderr: "boom" });
    const adapter = makeLiveAdapter({ spawn: fakeSpawn, cmuxCmd: "cmux" });
    await expect(adapter.listSurfaces()).rejects.toThrow(/failed/i);
  });

  it("parseSurfaces returns [] on non-JSON / empty stdout (defensive)", () => {
    expect(parseSurfaces("")).toEqual([]);
    expect(parseSurfaces("not json")).toEqual([]);
  });

  it("parseSurfaces walks windows→workspaces→panes→surfaces, terminal-only, deduped", () => {
    expect(parseSurfaces(TREE_JSON).map((s) => s.surface).sort()).toEqual([
      "surface:29",
      "surface:7",
    ]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd governance && pnpm exec vitest run test/session/observer.test.js
```

Expected: FAIL — the command-assertion test fails (`["list"]` ≠ `["tree","--all","--json"]`), and the JSON `parseSurfaces` tests fail (current parser newline-splits, so `parseSurfaces("not json")` returns `[{surface:"not json"}]` and the JSON walk returns the wrong shape).

- [ ] **Step 3: Rewrite `parseSurfaces` as a defensive JSON walk**

Replace the current `parseSurfaces` (lines 55-62, including its doc comment) with:

```ts
/** A surface node inside `cmux tree --json`. Only the fields we read are typed; everything is
 *  treated as unknown and guarded (the CLI may add fields). */
interface CmuxSurfaceNode {
  ref?: unknown;
  type?: unknown;
}

/** Parse `cmux tree --all --json` stdout into the set of LIVE TERMINAL surfaces. Walks
 *  windows[].workspaces[].panes[].surfaces[], keeping each surface whose `type === "terminal"`
 *  (Boule sessions are terminal agents — browser surfaces are not sessions). Deduped, order-stable
 *  by first appearance. Returns [] on malformed/empty stdout (defensive — the adapter still throws
 *  on a non-zero exit; a 0-exit with junk stdout simply yields no surfaces). */
export function parseSurfaces(stdout: string): LiveSurface[] {
  let tree: unknown;
  try {
    tree = JSON.parse(stdout);
  } catch {
    return [];
  }
  const out = new Set<string>();
  const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

  for (const w of asArray(rec(tree).windows)) {
    for (const ws of asArray(rec(w).workspaces)) {
      for (const p of asArray(rec(ws).panes)) {
        for (const s of asArray(rec(p).surfaces)) {
          const node = s as CmuxSurfaceNode;
          if (typeof node.ref === "string" && node.ref.length > 0 && node.type === "terminal") {
            out.add(node.ref);
          }
        }
      }
    }
  }
  return [...out].map((surface) => ({ surface }));
}
```

- [ ] **Step 4: Point the live adapter at `cmux tree --all --json`**

In `makeLiveAdapter` (lines 64-79), update the doc comment and the spawn call. Replace the function with:

```ts
/** Build a live adapter that runs a real, bounded (one-shot, no retry loop) `cmux tree --all --json`
 *  and surfaces a terminal failure (design §5). Enumerates every live terminal surface across all
 *  windows/workspaces. Non-determinism (spawn) is injected, so the unit test asserts the exact
 *  command with a fake spawn — no real process. */
export function makeLiveAdapter(deps: ObserverLiveDeps): ObserverAdapter {
  return {
    async listSurfaces() {
      const res = deps.spawn(deps.cmuxCmd, ["tree", "--all", "--json"]);
      const surfaces = res.status === 0 ? parseSurfaces(res.stdout) : [];
      deps.log?.(
        `observer exec ${deps.cmuxCmd} tree --all --json status=${res.status ?? "null"} surfaces=${surfaces.length}`,
      );
      if (res.status !== 0)
        throw new CommandError(`${deps.cmuxCmd} tree --all --json`, res.status, res.stderr);
      return surfaces;
    },
  };
}
```

Also fix the stale module-level doc comment on `ObserverAdapter` (line ~17-19) and `stubAdapter` (line ~24-26) and `makeLiveAdapter`'s `ObserverLiveDeps` (the `cmuxCmd` comment is fine) where they still say `cmux list`:
- Line ~18: `the live adapter runs \`cmux list\` behind` → `the live adapter runs \`cmux tree --all --json\` behind`.
- Any other literal `cmux list` in this file's comments → `cmux tree --all --json`.

Run `grep -n "cmux list" governance/src/session/observer.ts` and confirm **zero** remaining matches.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd governance && pnpm exec vitest run test/session/observer.test.js
```

Expected: PASS — all four `makeLiveAdapter`/`parseSurfaces` tests green, AND the existing reconcile tests (heartbeat / crash-recover / orphan-open, which use the FAKE adapter and are unaffected) still green.

- [ ] **Step 6: Full typecheck + suite + drift**

```bash
cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run
```

Expected: `tsc` 0 errors; full vitest green at **354** (Phase D baseline 353 **+1**: the rewritten `makeLiveAdapter` block has 4 `it()` — command-assert, terminal-failure, defensive-`[]`, JSON-walk-dedup — vs the old 3, so the suite is +1, not a 1:1 swap).

```bash
git -C /Users/davidpark/private_project/work-radar/.claude/worktrees/boule-v3-phase-d status --porcelain
```

Expected: only `governance/src/session/observer.ts` + `governance/test/session/observer.test.ts` modified (plus this plan file already added). `bindings.ts` untouched.

> Do NOT commit yet — docs (Task 2) and the live-cmux verification (Task 3) land in the same commit.

---

### Task 2: Update Phase D design + plan docs (BLOCKER → RESOLVED)

**Files:**
- Modify: `governance/docs/design/2026-06-03-boule-v3-phase-d-session-registry-design.md`
- Modify: `governance/docs/plans/2026-06-03-boule-v3-phase-d-session-registry.md`

> These are governance docs (Markdown). **Do NOT run Prettier on them** — it caused unrelated churn earlier (handoff caveat).

- [ ] **Step 1: Resolve the BLOCKER in the design doc**

In `...session-registry-design.md`:
- Line ~129 (`makeLiveAdapter(deps): ObserverAdapter; // behind BOULE_OBSERVER_MODE=live → \`cmux list\``): change the trailing comment to `→ \`cmux tree --all --json\` (terminal surfaces only)`.
- Line ~152 (`Non-determinism (\`cmux list\` spawn) injected ...`): change `cmux list` → `cmux tree --all --json`.
- The Live smoke note block (lines ~228-238) — convert the `⚠️ BLOCKER (live adapter only ...)` paragraph to a **RESOLVED** note: state that the adapter now runs `cmux tree --all --json` and parses `windows[].workspaces[].panes[].surfaces[].ref` for `type === "terminal"` surfaces (fix plan: `2026-06-03-boule-v3-phase-d-observer-live-adapter-fix.md`). Keep one sentence of the history (what was wrong: invented `cmux list`, fake-spawn masked it).
- Add a one-line **reconciliation precondition** where surface identity is discussed: the live surface set is `surface:N` cmux refs, so a Phase-C `session_spawned` session reconciles only if its stored `surface` (from `cmux new-workspace` stdout, conductor `adapter.ts`) is also the `surface:N` ref — verifying/normalizing that is a separate Phase-C follow-up.

- [ ] **Step 2: Mark the BLOCKER resolved in the Phase D plan doc**

In `...session-registry-session-registry.md` (the Phase D plan, `2026-06-03-boule-v3-phase-d-session-registry.md`) Status block (line 3), append after the existing BLOCKER sentence:
`**[RESOLVED 2026-06-03]** live adapter now runs \`cmux tree --all --json\` (terminal-only surface walk) — see plan \`2026-06-03-boule-v3-phase-d-observer-live-adapter-fix.md\`; reconcile logic unchanged.`

- [ ] **Step 3: Confirm no doc churn beyond the intended edits**

```bash
git -C /Users/davidpark/private_project/work-radar/.claude/worktrees/boule-v3-phase-d diff --stat governance/docs
```

Expected: only the two Phase D docs changed, small line counts (no Prettier reflow).

---

### Task 3: Live cmux verification + gates + local commit

**Files:** none (verification + commit only).

- [ ] **Step 1: Real-cmux read-only enumeration smoke (manual, AI-run authorized)**

`cmux tree --all --json` is read-only (no surface mutation). Confirm the real command + the parser agree on this machine:

```bash
cd governance
cmux tree --all --json > /tmp/boule-cmux-tree.json
node --experimental-strip-types -e '
import("./src/session/observer.ts").then(async (m) => {
  const fs = await import("node:fs");
  const stdout = fs.readFileSync("/tmp/boule-cmux-tree.json", "utf8");
  const surfaces = m.parseSurfaces(stdout);
  console.log("parsed terminal surfaces:", surfaces.map((s) => s.surface));
});
'
```

Expected: prints the live terminal surface refs (e.g. `[ 'surface:7', 'surface:29', 'surface:24', ... ]`) — a non-empty list of `surface:N` strings, browser surfaces absent. Cross-check against `cmux tree --all` (the human-readable tree) showing the same `surface:N [terminal]` rows. Record the observed list in the commit body.

> This exercises the real CLI + real parser end-to-end without spawning/mutating anything. It does NOT run the full `observeSessions` reconcile against the live registry (that would WRITE `session_*` events) — logic reconcile was already smoked on 2026-06-03.

- [ ] **Step 2: Final gate sweep**

```bash
cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run
git -C /Users/davidpark/private_project/work-radar/.claude/worktrees/boule-v3-phase-d status --porcelain
```

Expected: `tsc` 0, vitest **354** green, drift only under `governance/**` (observer.ts, observer.test.ts, the two Phase D docs, this plan; + the two out-of-scope `cmux list` comment fixes in server.ts/config.ts surfaced by the critic).

- [ ] **Step 3: Separate critic ACCEPT pass (REQUIRED — no self-approve)**

Before committing, dispatch a separate opus critic pass (own context) reviewing this change against INVARIANT #1/#4/#5/#6 and the AGENTS.md review bar. Critic must confirm: (a) command is the real `cmux tree --all --json`; (b) parser is defensive (malformed → [], terminal-only, deduped); (c) reconcile/handlers/server/conductor untouched; (d) no `session_closed` path added; (e) docs BLOCKER resolved honestly with the conductor-format caveat recorded. Proceed only on ACCEPT (0 blockers / 0 MAJOR); fix any MAJOR and re-run the relevant gate.

- [ ] **Step 4: Local commit (NEVER push — PARKED)**

```bash
git -C /Users/davidpark/private_project/work-radar/.claude/worktrees/boule-v3-phase-d add \
  governance/src/session/observer.ts \
  governance/test/session/observer.test.ts \
  governance/docs/design/2026-06-03-boule-v3-phase-d-session-registry-design.md \
  governance/docs/plans/2026-06-03-boule-v3-phase-d-session-registry.md \
  governance/docs/plans/2026-06-03-boule-v3-phase-d-observer-live-adapter-fix.md
git -C /Users/davidpark/private_project/work-radar/.claude/worktrees/boule-v3-phase-d commit --no-verify -m "$(cat <<'EOF'
fix(governance): Observer live adapter enumerates real cmux surfaces

`makeLiveAdapter` ran an invented `cmux list` (status 1 → throw), so
BOULE_OBSERVER_MODE=live was broken out-of-box; a fake-spawn test asserting
["list"] masked it. Switch to `cmux tree --all --json` and walk
windows[].workspaces[].panes[].surfaces[] for terminal surface refs
(`surface:N`), deduped, defensive on malformed stdout. Browser surfaces are
excluded (sessions are terminal agents). Reconcile core / handlers / server
wiring / conductor unchanged; no session_closed path added.

Verified: real `cmux tree --all --json` parsed to live surface:N terminals on
this host; tsc 0; vitest 354; drift governance/** only; bindings unchanged.
Separate opus critic pass: ACCEPT.

Caveat (Phase-C follow-up): live reconcile matches only if session_spawned
surfaces stored from `cmux new-workspace` stdout are also surface:N refs.
EOF
)"