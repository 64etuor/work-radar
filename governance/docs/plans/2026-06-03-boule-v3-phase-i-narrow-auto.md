# Boule v3 Phase I — Narrow opt-in Type-2 Auto (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> ⚠️ **This plan is the gated artifact. DO NOT begin implementation without an explicit user "build it" — Phase I is autonomy-boundary-sensitive.** No push/merge/delete/deploy; local commits only.

**Goal:** Build the orchestrator's anemic execute-half: an opt-in (`BOULE_AUTO_MODE=type2`), on-demand `auto_dispatch` MCP pass that auto-advances **human-accepted** plans by reusing the existing Phase-C `conduct_plan`, deny-by-default, leaving a `instruction_planned`/`orchestrator_action_executed`/`orchestrator_action_failed`/`action_denied` audit trail — minting **zero `decision_*`** events.

**Architecture:** A pure Safety Gate (`evaluateAutoDispatch`) over `deriveConductorState`, plus one IO shell (`autoDispatch`) that iterates non-terminal plans, dedups by dispatch-log key, emits the trail, and calls `conductPlan` (catching failures). All in the governance TS package (stdio MCP) — **no `src/bindings.ts` change, no app SQLite/migration**.

**Tech Stack:** TypeScript (Node `--experimental-strip-types`, vitest), governance event-sourced harness. Reuses `conductPlan`/`deriveConductorState`/`plansOf`/`writeEvent` unchanged.

**Spec:** `governance/docs/design/2026-06-03-boule-v3-phase-i-narrow-auto-design.md` (**rev. 2** — plan-critic ACCEPT-with-minors, 0 blockers; this plan is reconciled to rev.2: M1 sole-producer/F2 body-schema, **M2 dedup-keyed-off-`step_bound`-materialization**, M3 G3 `done`-before-`in_flight` precedence).

**Invariants:** #1 (no `decision_*` write-path — structural, negative test) is the crux; #4 (`bindings.ts` byte-unchanged — governance is a separate stdio package); #5 (on-demand single pass, no daemon); #6 (no app SQLite/migration). #2/#3/#7 trivially held.

**Pre-flight notes (this worktree):**
- Run governance gates from `governance/`: `pnpm exec tsc --noEmit` and `pnpm exec vitest run`. Import convention (match the as-built tests): **src→src** imports use `.ts` extensions, but **test files import from `src/` with `.js` extensions** — the test code blocks below follow that `.js` convention. Confirm against an existing test (e.g. `test/conductor/handlers.test.ts`) before committing.
- `bindings.ts` regen + app gates are NOT needed (no Rust touched), but the done-criteria still assert `git diff -- src/bindings.ts` and `src-tauri/migrations` are empty.
- **No push/merge/delete/deploy.** Local commits only; push only on explicit user request.
- The 4 plan-critic nits + 4 gaps are folded in below (candidate set = non-terminal plans; null-cursor denial dedup key = `(planId, reason)`; `mode_off` suppressed; `conductPlan`-throw → `orchestrator_action_failed`; best-effort per-plan; `listDispatchLog` sorted by id; ADR candidate in the final task).

---

## File Structure

**Created:**
- `governance/src/orchestrator/dispatch/policy.ts` — pure `evaluateAutoDispatch` + `isTerminalPlanPhase` + types.
- `governance/src/orchestrator/dispatch/dispatch.ts` — `autoDispatch` IO shell + event builders.
- `governance/src/orchestrator/dispatch/project.ts` — `listDispatchLog` read-only render.
- `governance/test/orchestrator/dispatch/policy.test.ts` — Safety Gate table test.
- `governance/test/orchestrator/dispatch/dispatch.test.ts` — IO shell + idempotency + halt-no-resolve + negative.
- `governance/test/orchestrator/dispatch/project.test.ts` — dispatch-log render.
- `governance/test/orchestrator/dispatch/config.test.ts` — `parseAutoMode`.

**Modified:**
- `governance/src/event/event.ts` — add 4 dispatch event types to the `EventType` union.
- `governance/src/mcp/config.ts` — `parseAutoMode`.
- `governance/src/mcp/server.ts` — register `auto_dispatch` + `dispatch_log` tools; parse `BOULE_AUTO_MODE`.

---

## Task 1: Add the 4 dispatch event types

**Files:** Modify `governance/src/event/event.ts`

- [ ] **Step 1: Extend the `EventType` union**

Change the union's final member (currently `| "orchestrator_suggestion_created";`) to append the 4 Phase-I types. Replace:

```ts
  | "orchestrator_suggestion_created";
```
with:
```ts
  | "orchestrator_suggestion_created"
  // v3 Phase I: orchestrator EXECUTE half (narrow opt-in Type-2 auto). verdict-free
  // (source/actor=system). Records the orchestrator's autonomous decision to advance a
  // human-accepted plan + the outcome. NO decision_* write-path exists from the dispatcher.
  | "instruction_planned"          // auto chose to advance plan P at step k (intent; dedup key)
  | "orchestrator_action_executed" // the dispatched conduct_plan succeeded
  | "orchestrator_action_failed"   // the dispatched conduct_plan refused/threw (carries reason)
  | "action_denied";               // Safety Gate denied advancing plan P (carries machine reason)
```

- [ ] **Step 2: Typecheck**

Run: `cd governance && pnpm exec tsc --noEmit`
Expected: 0 errors (a union extension is type-safe; no exhaustiveness break because the per-axis folds use fail-closed type filters).

- [ ] **Step 3: Commit**

```bash
cd governance && git add src/event/event.ts
git commit --no-verify -m "feat(governance): Phase I — add 4 dispatch event types (instruction_planned/orchestrator_action_executed/_failed/action_denied)"
```

---

## Task 2: Pure Safety Gate — `evaluateAutoDispatch`

**Files:**
- Create `governance/src/orchestrator/dispatch/policy.ts`
- Test `governance/test/orchestrator/dispatch/policy.test.ts`

- [ ] **Step 1: Write the failing table test**

Create `governance/test/orchestrator/dispatch/policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evaluateAutoDispatch, isTerminalPlanPhase } from "../../../src/orchestrator/dispatch/policy.js";
import type { ConductorState } from "../../../src/conductor/conductor.js";

function cs(over: Partial<ConductorState>): ConductorState {
  return {
    planId: "plan_x",
    planPhase: "active",
    steps: [],
    cursor: 0,
    halted: false,
    done: false,
    ...over,
  };
}

describe("evaluateAutoDispatch (deny-by-default)", () => {
  it("allows an active, not-halted, not-done plan with a ready cursor", () => {
    expect(evaluateAutoDispatch(cs({ cursor: 2 }), "type2")).toEqual({
      decision: "allow", planId: "plan_x", stepIndex: 2,
    });
  });
  it("denies when mode is off", () => {
    expect(evaluateAutoDispatch(cs({}), "off")).toEqual({
      decision: "deny", planId: "plan_x", reason: "mode_off",
    });
  });
  it("denies a non-accepted (draft/needs_revision) plan", () => {
    expect(evaluateAutoDispatch(cs({ planPhase: "draft" }), "type2").reason).toBe("plan_not_accepted");
    expect(evaluateAutoDispatch(cs({ planPhase: "needs_revision" }), "type2").reason).toBe("plan_not_accepted");
  });
  it("denies a halted plan (open decision_blocked) before anything else", () => {
    expect(evaluateAutoDispatch(cs({ halted: true, cursor: null }), "type2").reason).toBe("halted");
  });
  it("denies a fully-conducted plan", () => {
    expect(evaluateAutoDispatch(cs({ done: true, cursor: null }), "type2").reason).toBe("done");
  });
  it("denies an in-flight plan (a step is running → cursor null)", () => {
    expect(evaluateAutoDispatch(cs({ cursor: null }), "type2").reason).toBe("in_flight");
  });
  it("mode is checked first (off beats every other condition)", () => {
    expect(evaluateAutoDispatch(cs({ planPhase: "draft", halted: true, cursor: null }), "off").reason).toBe("mode_off");
  });
});

describe("isTerminalPlanPhase", () => {
  it("treats completed/archived/superseded as terminal, others not", () => {
    expect(isTerminalPlanPhase("completed")).toBe(true);
    expect(isTerminalPlanPhase("archived")).toBe(true);
    expect(isTerminalPlanPhase("superseded")).toBe(true);
    expect(isTerminalPlanPhase("active")).toBe(false);
    expect(isTerminalPlanPhase("draft")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it FAILS**

Run: `cd governance && pnpm exec vitest run test/orchestrator/dispatch/policy.test.ts`
Expected: FAIL — module `policy.ts` not found.

- [ ] **Step 3: Implement the pure gate**

Create `governance/src/orchestrator/dispatch/policy.ts`:

```ts
import type { ConductorState } from "../../conductor/conductor.ts";

export type AutoMode = "off" | "type2";
export type AutoDenyReason = "mode_off" | "plan_not_accepted" | "halted" | "done" | "in_flight";

export type AutoDispatchVerdict =
  | { decision: "allow"; planId: string; stepIndex: number }
  | { decision: "deny"; planId: string; reason: AutoDenyReason };

const TERMINAL_PLAN_PHASES = new Set(["completed", "archived", "superseded"]);

/** A finished plan is not a dispatch candidate (skip silently — not even a denial). */
export function isTerminalPlanPhase(phase: string): boolean {
  return TERMINAL_PLAN_PHASES.has(phase);
}

/** PURE deny-by-default Safety Gate. A re-statement of conductor `canAdvance` PLUS the opt-in
 *  gate, but it returns a *recorded, explained* verdict instead of a swallowed ok:false.
 *  Order matters: mode → acceptance → halt → done → in-flight. Total over all ConductorStates
 *  (no I/O, emits nothing). The dispatcher pre-refuses mode=off before the loop, so the mode_off
 *  branch is exercised only by unit tests / for totality. */
export function evaluateAutoDispatch(conductor: ConductorState, mode: AutoMode): AutoDispatchVerdict {
  const planId = conductor.planId;
  if (mode !== "type2") return { decision: "deny", planId, reason: "mode_off" };
  if (conductor.planPhase !== "active") return { decision: "deny", planId, reason: "plan_not_accepted" };
  if (conductor.halted) return { decision: "deny", planId, reason: "halted" };
  if (conductor.done) return { decision: "deny", planId, reason: "done" };
  if (conductor.cursor === null) return { decision: "deny", planId, reason: "in_flight" };
  return { decision: "allow", planId, stepIndex: conductor.cursor };
}
```

- [ ] **Step 4: Run it to verify it PASSES**

Run: `cd governance && pnpm exec vitest run test/orchestrator/dispatch/policy.test.ts`
Expected: PASS (both describe blocks).

- [ ] **Step 5: Commit**

```bash
cd governance && git add src/orchestrator/dispatch/policy.ts test/orchestrator/dispatch/policy.test.ts
git commit --no-verify -m "feat(governance): Phase I — pure evaluateAutoDispatch Safety Gate (deny-by-default, total)"
```

---

## Task 3: `parseAutoMode` config

**Files:**
- Modify `governance/src/mcp/config.ts`
- Test `governance/test/orchestrator/dispatch/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `governance/test/orchestrator/dispatch/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseAutoMode } from "../../../src/mcp/config.js";

describe("parseAutoMode (opt-in, fail-closed to off)", () => {
  it("returns type2 only for exactly 'type2' (case/space-insensitive)", () => {
    expect(parseAutoMode("type2")).toBe("type2");
    expect(parseAutoMode("  TYPE2 ")).toBe("type2");
  });
  it("defaults to off for unset/blank/junk (never accidentally auto)", () => {
    expect(parseAutoMode(undefined)).toBe("off");
    expect(parseAutoMode("")).toBe("off");
    expect(parseAutoMode("on")).toBe("off");
    expect(parseAutoMode("type1")).toBe("off");
    expect(parseAutoMode("true")).toBe("off");
  });
});
```

- [ ] **Step 2: Run it to verify it FAILS**

Run: `cd governance && pnpm exec vitest run test/orchestrator/dispatch/config.test.ts`
Expected: FAIL — `parseAutoMode` not exported.

- [ ] **Step 3: Implement (mirror `parseConductorMode`)**

In `governance/src/mcp/config.ts`, add after `parseConductorWorktreesRoot` (or near the conductor knobs):

```ts
/** Parse BOULE_AUTO_MODE: exactly "type2" (case-insensitive, trimmed) opts into narrow Type-2
 *  auto-dispatch; anything else (unset/junk) → "off". Fail-closed: an unrecognized value never
 *  accidentally enables auto. This gates *dispatch* only — it is NOT a parameter to any approval
 *  gate (canApprove/canComplete/canAdvance take no mode arg). */
export function parseAutoMode(raw: string | undefined): "off" | "type2" {
  return (raw ?? "").trim().toLowerCase() === "type2" ? "type2" : "off";
}
```

- [ ] **Step 4: Run it to verify it PASSES + typecheck**

Run: `cd governance && pnpm exec vitest run test/orchestrator/dispatch/config.test.ts && pnpm exec tsc --noEmit`
Expected: PASS + 0 type errors.

- [ ] **Step 5: Commit**

```bash
cd governance && git add src/mcp/config.ts test/orchestrator/dispatch/config.test.ts
git commit --no-verify -m "feat(governance): Phase I — parseAutoMode (opt-in BOULE_AUTO_MODE, fail-closed to off)"
```

---

## Task 4: `autoDispatch` IO shell

**Files:**
- Create `governance/src/orchestrator/dispatch/dispatch.ts`
- Test `governance/test/orchestrator/dispatch/dispatch.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `governance/test/orchestrator/dispatch/dispatch.test.ts`. It seeds a real temp workspace with events, runs `autoDispatch` with the deterministic `stubAdapter`, and asserts the trail + key invariants (idempotency, halt-no-resolve, zero `decision_*`):

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoDispatch } from "../../../src/orchestrator/dispatch/dispatch.js";
import { stubAdapter } from "../../../src/conductor/adapter.js";
import { writeEvent } from "../../../src/event/writeEvent.js";
import { generateId } from "../../../src/event/id.js";
import { readAllEvents } from "../../../src/decision/readEvents.js";
import type { GovEvent } from "../../../src/event/event.js";

const RAND = 0.42;
let ws: string;
beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), "boule-disp-")); });
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

// helpers — append events at distinct seconds so ids are distinct (the harness ORDERING CONTRACT).
let seedSec = 0;
function at(): Date { return new Date(Date.UTC(2026, 5, 3, 0, 0, seedSec++)); }
async function seed(evt: GovEvent, when: Date) { await writeEvent(ws, evt, when); }

async function seedAcceptedPlan(steps: string[]): Promise<string> {
  const when = at();
  const planId = generateId("evt", when, RAND);
  await seed({
    frontmatter: { id: planId, type: "plan_proposed", source: "hermes", actor: "planner", tags: ["plan"], related_to: [] },
    body: ["intent line", "", ...steps.map((s, i) => `${i + 1}. ${s}`)].join("\n"),
  }, when);
  const aWhen = at();
  await seed({
    frontmatter: { id: generateId("evt", aWhen, RAND), type: "plan_accepted", source: "hermes", actor: "user", tags: ["plan"], related_to: [planId] },
    body: `Human accepted ${planId}`,
  }, aWhen);
  return planId;
}

function typesOf(all: GovEvent[]): string[] { return all.map((e) => e.frontmatter.type); }

describe("autoDispatch", () => {
  it("off mode: refuses, emits nothing", async () => {
    await seedAcceptedPlan(["a", "b"]);
    const before = (await readAllEvents(ws)).length;
    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "off", at(), RAND);
    expect(summary).toEqual({ executed: 0, failed: 0, denied: 0, skipped: 0 });
    expect((await readAllEvents(ws)).length).toBe(before);
  });

  it("type2: advances an accepted plan one step (instruction_planned + executed + conductor events)", async () => {
    await seedAcceptedPlan(["a", "b"]);
    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    expect(summary.executed).toBe(1);
    const t = typesOf(await readAllEvents(ws));
    expect(t).toContain("instruction_planned");
    expect(t).toContain("orchestrator_action_executed");
    // conductPlan minted the bounded step:
    expect(t).toContain("task_created");
    expect(t).toContain("session_spawned");
    expect(t).toContain("task_started");
  });

  it("idempotent: a second pass with no state change advances nothing new", async () => {
    await seedAcceptedPlan(["a", "b"]);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    const boundBefore = (await readAllEvents(ws)).filter((e) => e.frontmatter.type === "step_bound").length;
    const summary2 = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    // step 0 now materialized + in-flight (active): step_bound dedup + cursor=null → in_flight deny.
    expect(summary2.executed).toBe(0);
    expect(summary2.denied).toBe(1); // action_denied(in_flight)
    const boundAfter = (await readAllEvents(ws)).filter((e) => e.frontmatter.type === "step_bound").length;
    expect(boundAfter).toBe(boundBefore); // no NEW materialization
  });

  it("M2: an orphan instruction_planned (no step_bound) does NOT poison the step — it re-dispatches", async () => {
    const planId = await seedAcceptedPlan(["a", "b"]);
    // simulate a crash AFTER the intent write but BEFORE conductPlan materialized the step:
    // an instruction_planned for (planId, 0) exists, but no step_bound.
    const iw = at();
    await seed({
      frontmatter: { id: generateId("evt", iw, RAND), type: "instruction_planned", source: "system", actor: "system", tags: ["orchestrator", "dispatch"], related_to: [planId] },
      body: JSON.stringify({ planId, stepIndex: 0 }),
    }, iw);
    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    // dedup keys off step_bound (absent) — NOT off instruction_planned — so the step re-dispatches.
    expect(summary.executed).toBe(1);
    expect((await readAllEvents(ws)).some((e) => e.frontmatter.type === "step_bound")).toBe(true);
  });

  it("M3 observability: a fully-conducted plan denies with reason 'done' (distinct from in_flight)", async () => {
    const planId = await seedAcceptedPlan(["a"]); // single step
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND); // materializes step 0 (active)
    const taskId = (await readAllEvents(ws)).find((e) => e.frontmatter.type === "task_created")!.frontmatter.id;
    const cw = at();
    await seed({ frontmatter: { id: generateId("evt", cw, RAND), type: "task_completed", source: "hermes", actor: "conductor", tags: ["task"], related_to: [taskId] }, body: `Completed ${taskId}` }, cw);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    const reasons = (await readAllEvents(ws))
      .filter((e) => e.frontmatter.type === "action_denied")
      .map((e) => JSON.parse(e.body).reason);
    expect(reasons).toContain("done"); // every step terminal → done, NOT in_flight (M3 precedence)
  });

  it("denies a non-accepted (draft) plan with plan_not_accepted, no conductor events", async () => {
    const when = at();
    const planId = generateId("evt", when, RAND);
    await seed({ frontmatter: { id: planId, type: "plan_proposed", source: "hermes", actor: "planner", tags: ["plan"], related_to: [] }, body: "intent\n\n1. a" }, when);
    // NO plan_accepted → draft.
    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    expect(summary.denied).toBe(1);
    const t = typesOf(await readAllEvents(ws));
    expect(t).toContain("action_denied");
    expect(t).not.toContain("session_spawned");
  });

  it("NEGATIVE #1: a full pass writes ZERO decision_* events (INVARIANT #1)", async () => {
    await seedAcceptedPlan(["a"]);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    const t = typesOf(await readAllEvents(ws));
    expect(t.filter((x) => x.startsWith("decision_"))).toEqual([]);
  });

  it("HALT-NO-RESOLVE: an open decision_blocked on a step → action_denied(halted), no advance, no decision_* write", async () => {
    const planId = await seedAcceptedPlan(["a", "b"]);
    // advance step 0 so a task exists to block:
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    const all = await readAllEvents(ws);
    const taskId = all.find((e) => e.frontmatter.type === "task_created")!.frontmatter.id;
    // escalate-style block bound to the task (the spawned session would emit this):
    const bWhen = at();
    await seed({
      frontmatter: { id: generateId("evt", bWhen, RAND), type: "decision_blocked", source: "agent_run", actor: "agent_run", tags: ["type0"], related_to: ["dec_x", taskId] },
      body: "needs a human",
    }, bWhen);
    const before = (await readAllEvents(ws)).length;
    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    // halted → denied; no new conductor/task/session/decision events beyond the action_denied:
    expect(summary.denied).toBe(1);
    const after = await readAllEvents(ws);
    expect(after.length).toBe(before + 1);
    expect(after[after.length - 1]!.frontmatter.type).toBe("action_denied");
  });

  it("conductPlan failure (throwing adapter) → orchestrator_action_failed, failed===1", async () => {
    await seedAcceptedPlan(["a"]);
    // adapter.createWorktree throws → conductPlan throws (after task_created, before step_bound).
    // autoDispatch's try/catch turns it into orchestrator_action_failed (best-effort per plan).
    const throwingAdapter = {
      createWorktree: async () => { throw new Error("worktree boom"); },
      spawnSession: async () => ({ surface: "stub" }),
      writeEnvelopeFile: async () => {},
    };
    const summary = await autoDispatch(ws, { adapter: throwingAdapter }, "type2", at(), RAND);
    expect(summary.failed).toBe(1);
    expect(summary.executed).toBe(0);
    const t = typesOf(await readAllEvents(ws));
    expect(t).toContain("orchestrator_action_failed");
    expect(t).not.toContain("orchestrator_action_executed");
  });

  it("two advanceable plans in one pass: shared stamp counter never collides (both advance)", async () => {
    await seedAcceptedPlan(["a"]);
    await seedAcceptedPlan(["b"]);
    // One pass dispatches BOTH plans. The shared per-event second-offset counter + the 4-slot
    // reservation around each conductPlan must keep every event id distinct — a same-second id
    // collision would throw on writeEvent's wx flag, so completing + executed===2 IS the assertion.
    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    expect(summary.executed).toBe(2);
    const ids = (await readAllEvents(ws)).map((e) => e.frontmatter.id);
    expect(new Set(ids).size).toBe(ids.length); // all ids distinct (no wx collision)
  });
});
```

> The exact `decision_blocked` shape used to halt mirrors `escalate.ts` (`related_to ∋ taskId`); if the seed doesn't trigger `hasOpenBlock`, check `hasOpenBlock`'s open-criteria in `task/handlers.ts` and match it (the block is "open" when no `decision_chosen`/`decision_approved`/`decision_rejected` resolves it).

- [ ] **Step 2: Run it to verify it FAILS**

Run: `cd governance && pnpm exec vitest run test/orchestrator/dispatch/dispatch.test.ts`
Expected: FAIL — `dispatch.ts` not found.

- [ ] **Step 3: Implement the IO shell**

Create `governance/src/orchestrator/dispatch/dispatch.ts`:

```ts
import { generateId } from "../../event/id.ts";
import { writeEvent } from "../../event/writeEvent.ts";
import type { GovEvent } from "../../event/event.ts";
import { readAllEvents } from "../../decision/readEvents.ts";
import { plansOf } from "../../plan/plan.ts";
import { deriveConductorState } from "../../conductor/conductor.ts";
import { conductPlan } from "../../conductor/handlers.ts";
import type { ConductorAdapter } from "../../conductor/adapter.ts";
import { evaluateAutoDispatch, isTerminalPlanPhase, type AutoMode } from "./policy.ts";

// IMPORTANT: this module imports ZERO decision write handlers (no "../../decision/handlers.ts").
// Its only writes are the 4 verdict-free dispatch events; conductPlan (which it calls) likewise
// imports zero decision handlers. INVARIANT #1 is structural — asserted by the negative test.

export interface DispatchSummary {
  executed: number; // conduct_plan succeeded
  failed: number; // conduct_plan refused or threw
  denied: number; // Safety Gate denied (recorded action_denied)
  skipped: number; // dedup hit (already-dispatched/denied this (plan,key))
}

const SEP = " ";
// Dedup keys off MATERIALIZATION (a step_bound exists for the step), NOT off instruction_planned —
// keying off the intent event would poison a step forever if conductPlan failed after the intent
// write (spec rev.2 M2). action_denied dedups on its own (planId, stepIndex, reason) so identical
// denials don't flood; a deny is NEVER in the materialized set, so it never blocks a later legitimate
// allow for the same step.
function materializedKey(planId: string, stepIndex: number): string { return `mat${SEP}${planId}${SEP}${stepIndex}`; }
function deniedKey(planId: string, stepIndex: number | null, reason: string): string {
  return `denied${SEP}${planId}${SEP}${stepIndex}${SEP}${reason}`;
}

function safeBody(body: string): { planId?: string; stepIndex?: number; reason?: string } {
  try { return JSON.parse(body); } catch { return {}; }
}

function evt(type: GovEvent["frontmatter"]["type"], planId: string, body: object, stamp: Date, rand: number, extraRelated: string[] = []): GovEvent {
  return {
    frontmatter: {
      id: generateId("evt", stamp, rand),
      type,
      source: "system",
      actor: "system",
      tags: ["orchestrator", "dispatch"],
      related_to: [planId, ...extraRelated],
    },
    body: JSON.stringify(body),
  };
}

/** auto_dispatch — ONE on-demand pass. Iterate non-terminal plans; per plan, gate (deny-by-default)
 *  and either record action_denied or emit instruction_planned + call conductPlan (catching
 *  refusal/throw → orchestrator_action_failed). Best-effort per plan: one plan's failure never
 *  aborts the others. Idempotent via the dispatch-log dedup keys. Off mode ⇒ refuse, emit nothing.
 *  Mirrors orchestrator/suggest.ts (per-event second-offset stamps → distinct chronological ids). */
export async function autoDispatch(
  workspaceDir: string,
  deps: { adapter: ConductorAdapter },
  mode: AutoMode,
  now: Date,
  rand: number,
): Promise<DispatchSummary> {
  const summary: DispatchSummary = { executed: 0, failed: 0, denied: 0, skipped: 0 };
  if (mode !== "type2") return summary; // opt-in gate: off ⇒ emit nothing (deny-by-default at the mode level)

  const all = await readAllEvents(workspaceDir);

  // Build the dedup set: MATERIALIZED steps (a step_bound = the conductor actually advanced it) +
  // prior identical denials. NOT keyed off instruction_planned (spec rev.2 M2: that would poison a
  // step on partial failure). step_bound body = { stepIndex, taskId, planId } (conductor/handlers.ts).
  const existing = new Set<string>();
  for (const e of all) {
    const b = safeBody(e.body);
    if (e.frontmatter.type === "step_bound" && b.planId && typeof b.stepIndex === "number") {
      existing.add(materializedKey(b.planId, b.stepIndex));
    } else if (e.frontmatter.type === "action_denied" && b.planId && b.reason) {
      existing.add(deniedKey(b.planId, typeof b.stepIndex === "number" ? b.stepIndex : null, b.reason));
    }
  }

  // Distinct, collision-free stamps. conductPlan internally mints 4 events at conductNow+0..3s,
  // so we RESERVE 4 slots around each conductPlan call to avoid same-second id collisions
  // (writeEvent uses wx → a collision would throw).
  let i = 0;
  const nextStamp = () => new Date(now.getTime() + i++ * 1000);

  for (const planProposed of plansOf(all)) {
    const cs = deriveConductorState(planProposed, all);
    if (isTerminalPlanPhase(cs.planPhase)) continue; // finished plan — not a candidate
    const verdict = evaluateAutoDispatch(cs, mode);

    if (verdict.decision === "deny") {
      // stepIndex on a denial = the conductor cursor at deny time (null for halted/done/in_flight).
      const key = deniedKey(verdict.planId, cs.cursor, verdict.reason);
      if (existing.has(key)) { summary.skipped++; continue; }
      const stamp = nextStamp();
      await writeEvent(workspaceDir, evt("action_denied", verdict.planId, { planId: verdict.planId, stepIndex: cs.cursor, reason: verdict.reason }, stamp, rand), stamp);
      existing.add(key);
      summary.denied++;
      continue;
    }

    // allow — guard on MATERIALIZATION (defensive: deriveConductorState's cursor only points at an
    // unmaterialized step, so this skip is belt-and-suspenders + the partial-failure retry path).
    const mkey = materializedKey(verdict.planId, verdict.stepIndex);
    if (existing.has(mkey)) { summary.skipped++; continue; }
    const planStamp = nextStamp();
    await writeEvent(workspaceDir, evt("instruction_planned", verdict.planId, { planId: verdict.planId, stepIndex: verdict.stepIndex }, planStamp, rand), planStamp);
    // Do NOT add to `existing` off the intent — materialization is recorded by conductPlan's step_bound.

    // Reserve 4 stamp slots for conductPlan's task_created/step_bound/session_spawned/task_started.
    const conductNow = new Date(now.getTime() + i * 1000);
    i += 4;
    try {
      const r = await conductPlan(workspaceDir, { planId: verdict.planId }, deps, conductNow, rand);
      const outStamp = nextStamp();
      if (r.ok && r.advanced) {
        await writeEvent(workspaceDir, evt("orchestrator_action_executed", verdict.planId, { planId: verdict.planId, stepIndex: r.advanced.stepIndex, taskId: r.advanced.taskId }, outStamp, rand, [r.advanced.taskId]), outStamp);
        summary.executed++;
      } else {
        await writeEvent(workspaceDir, evt("orchestrator_action_failed", verdict.planId, { planId: verdict.planId, stepIndex: verdict.stepIndex, reason: r.reason }, outStamp, rand), outStamp);
        summary.failed++;
      }
    } catch (err) {
      const outStamp = nextStamp();
      const reason = err instanceof Error ? err.message : String(err);
      await writeEvent(workspaceDir, evt("orchestrator_action_failed", verdict.planId, { planId: verdict.planId, stepIndex: verdict.stepIndex, reason }, outStamp, rand), outStamp);
      summary.failed++;
    }
  }
  return summary;
}
```

- [ ] **Step 4: Run it to verify it PASSES**

Run: `cd governance && pnpm exec vitest run test/orchestrator/dispatch/dispatch.test.ts`
Expected: PASS (all 6 cases). If the halt test doesn't deny, reconcile the seeded `decision_blocked` with `hasOpenBlock`'s open-criteria (note in Step 1).

- [ ] **Step 5: Commit**

```bash
cd governance && git add src/orchestrator/dispatch/dispatch.ts test/orchestrator/dispatch/dispatch.test.ts
git commit --no-verify -m "feat(governance): Phase I — autoDispatch IO shell (deny-by-default, idempotent, halt-safe, 0 decision_*)"
```

---

## Task 5: `listDispatchLog` read render

**Files:**
- Create `governance/src/orchestrator/dispatch/project.ts`
- Test `governance/test/orchestrator/dispatch/project.test.ts`

- [ ] **Step 1: Write the failing test**

Create `governance/test/orchestrator/dispatch/project.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoDispatch } from "../../../src/orchestrator/dispatch/dispatch.js";
import { listDispatchLog } from "../../../src/orchestrator/dispatch/project.js";
import { stubAdapter } from "../../../src/conductor/adapter.js";
import { writeEvent } from "../../../src/event/writeEvent.js";
import { generateId } from "../../../src/event/id.js";

const RAND = 0.42;
let ws: string;
let sec = 0;
const at = () => new Date(Date.UTC(2026, 5, 3, 0, 0, sec++));
beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), "boule-displog-")); sec = 0; });
afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

describe("listDispatchLog", () => {
  it("returns instruction_planned + outcome entries, sorted by id", async () => {
    const w = at();
    const planId = generateId("evt", w, RAND);
    await writeEvent(ws, { frontmatter: { id: planId, type: "plan_proposed", source: "hermes", actor: "planner", tags: ["plan"], related_to: [] }, body: "intent\n\n1. a" }, w);
    const aw = at();
    await writeEvent(ws, { frontmatter: { id: generateId("evt", aw, RAND), type: "plan_accepted", source: "hermes", actor: "user", tags: ["plan"], related_to: [planId] }, body: "ok" }, aw);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    const log = await listDispatchLog(ws);
    const kinds = log.map((e) => e.type);
    expect(kinds).toContain("instruction_planned");
    expect(kinds).toContain("orchestrator_action_executed");
    // sorted by id ascending:
    const ids = log.map((e) => e.id);
    expect([...ids].sort((a, b) => a.localeCompare(b))).toEqual(ids);
  });
});
```

- [ ] **Step 2: Run it to verify it FAILS**

Run: `cd governance && pnpm exec vitest run test/orchestrator/dispatch/project.test.ts`
Expected: FAIL — `project.ts` not found.

- [ ] **Step 3: Implement (mirror `listSuggestions`)**

Create `governance/src/orchestrator/dispatch/project.ts`:

```ts
import { readAllEvents } from "../../decision/readEvents.ts";

export interface DispatchLogEntry {
  id: string;
  type: "instruction_planned" | "orchestrator_action_executed" | "orchestrator_action_failed" | "action_denied";
  planId: string;
  stepIndex: number | null;
  reason: string | null;
  taskId: string | null;
}

const DISPATCH_TYPES = new Set<DispatchLogEntry["type"]>([
  "instruction_planned", "orchestrator_action_executed", "orchestrator_action_failed", "action_denied",
]);

/** Read-only render of the Phase-I dispatch trail (sorted by id, mirrors listSuggestions). */
export async function listDispatchLog(workspaceDir: string): Promise<DispatchLogEntry[]> {
  const all = await readAllEvents(workspaceDir);
  const out: DispatchLogEntry[] = [];
  for (const e of all) {
    const type = e.frontmatter.type as DispatchLogEntry["type"];
    if (!DISPATCH_TYPES.has(type)) continue;
    let b: { planId?: string; stepIndex?: number; reason?: string; taskId?: string } = {};
    try { b = JSON.parse(e.body); } catch { /* defensive: dispatcher only writes canonical JSON */ }
    out.push({
      id: e.frontmatter.id,
      type,
      planId: b.planId ?? (e.frontmatter.related_to ?? [])[0] ?? "",
      stepIndex: typeof b.stepIndex === "number" ? b.stepIndex : null,
      reason: b.reason ?? null,
      taskId: b.taskId ?? null,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 4: Run it to verify it PASSES**

Run: `cd governance && pnpm exec vitest run test/orchestrator/dispatch/project.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd governance && git add src/orchestrator/dispatch/project.ts test/orchestrator/dispatch/project.test.ts
git commit --no-verify -m "feat(governance): Phase I — listDispatchLog read render (sorted by id)"
```

---

## Task 6: MCP wiring + negative-import test + full gates

**Files:**
- Modify `governance/src/mcp/server.ts`
- Test (add to) `governance/test/orchestrator/dispatch/dispatch.test.ts` — the import-graph + flag≠approval negatives.

- [ ] **Step 1: Add the structural negative tests**

Append to `governance/test/orchestrator/dispatch/dispatch.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { canApprove } from "../../../src/decision/guardian.js";

describe("INVARIANT #1 — structural", () => {
  it("the dispatcher module imports ZERO decision write handlers", () => {
    const src = readFileSync(new URL("../../../src/orchestrator/dispatch/dispatch.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/decision\/handlers/);
  });

  it("the opt-in flag does NOT touch the approval gate (canApprove takes no mode arg)", () => {
    // canApprove is a pure function of DecisionState only; BOULE_AUTO_MODE cannot reach it.
    // An unreviewed Type-1 is refused regardless of any auto mode.
    const unreviewed = { verdict: null, reviewed: false } as Parameters<typeof canApprove>[0];
    expect(canApprove(unreviewed).ok).toBe(false);
  });
});
```

> Confirm the `DecisionState` shape for the `canApprove` fixture against `src/decision/guardian.ts` (and the `DecisionState` type it consumes); adjust the fixture to the real minimal shape if needed. The structural point — `canApprove` takes no mode argument, so `BOULE_AUTO_MODE` cannot reach it — is what the test must assert.

- [ ] **Step 2: Run to verify they pass against the existing impl**

Run: `cd governance && pnpm exec vitest run test/orchestrator/dispatch/dispatch.test.ts`
Expected: PASS (the import-graph assertion holds because Task 4 imported no decision handlers).

- [ ] **Step 3: Wire the MCP tools**

In `governance/src/mcp/server.ts`:

(a) Add imports near the other orchestrator imports:
```ts
import { autoDispatch } from "../orchestrator/dispatch/dispatch.ts";
import { listDispatchLog } from "../orchestrator/dispatch/project.ts";
import { parseAutoMode } from "./config.ts"; // extend the existing config import line
```
(b) Near `const CONDUCTOR_CFG = parseConductorConfig(process.env);`, add:
```ts
const AUTO_MODE = parseAutoMode(process.env.BOULE_AUTO_MODE);
```
(c) Register the tools next to the `suggest` block (verdict-free; NOT inside any `SESSION_ALLOWS_VERDICTS` gate — the opt-in refusal lives in the handler). Mirror the existing `conduct_plan`/`suggest` registration shape (use the file's actual `nowFn()`/`randFn()`/text-result helpers):
```ts
server.registerTool(
  "auto_dispatch",
  {
    description:
      "Phase I narrow opt-in Type-2 auto: one on-demand pass that auto-advances human-accepted " +
      "plans via conduct_plan (deny-by-default). Refuses unless BOULE_AUTO_MODE=type2. Writes no decision_*.",
    inputSchema: {},
  },
  async () => {
    if (AUTO_MODE !== "type2") {
      return { content: [{ type: "text", text: "auto disabled (set BOULE_AUTO_MODE=type2)" }] };
    }
    const s = await autoDispatch(WORKSPACE, { adapter: conductorAdapter }, AUTO_MODE, nowFn(), randFn());
    return { content: [{ type: "text", text: `dispatched: ${s.executed} executed, ${s.failed} failed, ${s.denied} denied, ${s.skipped} skipped` }] };
  },
);

server.registerTool(
  "dispatch_log",
  { description: "Phase I: read-only list of the auto-dispatch trail (instruction_planned + outcomes).", inputSchema: {} },
  async () => {
    const log = await listDispatchLog(WORKSPACE);
    return { content: [{ type: "text", text: JSON.stringify(log, null, 2) }] };
  },
);
```

> Match the EXACT `registerTool` signature/return shape the file already uses (some MCP SDK versions take `(name, {description, inputSchema}, handler)`; confirm against the `suggest`/`conduct_plan` registrations and copy their shape verbatim — including how `WORKSPACE`, `conductorAdapter`, `nowFn`, `randFn` are referenced).

- [ ] **Step 4: Typecheck + full governance suite + drift gates**

Run:
```bash
cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run
```
Expected: tsc 0 errors; full suite green. **Capture the baseline at execution** — run `pnpm exec vitest run` once before Task 1 to record the real starting count, then again here and record the real new total (baseline + the new dispatch tests). Do not hardcode a count in the commit/INDEX; use the observed numbers.

Then from the repo root, confirm no app drift (governance is a separate stdio package):
```bash
cd /Users/davidpark/private_project/work-radar/.claude/worktrees/boule-v3-phase-d
git diff --stat -- src/bindings.ts src-tauri/migrations
```
Expected: **empty** (no Rust/bindings/migration touched — INVARIANT #4/#6).

- [ ] **Step 5: Commit**

```bash
cd governance && git add src/mcp/server.ts test/orchestrator/dispatch/dispatch.test.ts
git commit --no-verify -m "feat(governance): Phase I — wire auto_dispatch + dispatch_log MCP tools (opt-in handler refusal) + structural negatives"
```

---

## Task 7: ADR + INDEX + separate impl-critic

**Files:**
- Create `docs/adr/<NNNN>-orchestrator-dispatch-decision-rail.md` — **run `ls docs/adr/` at execution to pick the next free number** (do not commit a literal `00XX`/`NNNN` placeholder)
- Modify `docs/areas/decision-rails.md` (one line)
- Modify `governance/docs/INDEX.md` (Phase I row → DONE on critic ACCEPT)

- [ ] **Step 1: Write the ADR for the exercised decision rail**

The spec's §9 ADR candidate: an auto path now exercises master §4.6's rail ("orchestrator/dispatcher modules have no `decision_*` write-path; a spawned step that hits a Type-1 boundary must emit `decision_blocked` and halt, never self-resolve"). Create the ADR recording: context (Phase I adds the first auto execute path), decision (the rail + its enforcement = the negative test, not prose), consequences (anemic auto; latency is the feature). Add a one-line pointer in `docs/areas/decision-rails.md`.

- [ ] **Step 2: Separate impl-critic (opus) — self-approve forbidden**

Dispatch a fresh `oh-my-claudecode:critic` (opus) over the full diff vs. the spec + INVARIANTs (#1 structural: 0 `decision_*` + no decision-handler import; #4 bindings byte-unchanged; #5 on-demand; #6 no migration). Re-run the gates. Address any blockers.

- [ ] **Step 3: Mark INDEX DONE (on ACCEPT only) + commit**

Update `governance/docs/INDEX.md` Phase I row → ✅ Slice 1 DONE with the real vitest count + critic note + the new event types. Commit (local only — **do NOT push**).

- [ ] **Step 4: Live smoke (user-run, optional)**

`BOULE_AUTO_MODE=type2 BOULE_CONDUCTOR_MODE=live` + an accepted 2-step plan → `auto_dispatch` spawns a real cmux session for step 1; force a Type-1 escalation → next `auto_dispatch` reports `denied` (halted), no advance. Agent cannot drive the native session → report "could not run", hand to user/cmux.

---

## Self-Review (run before execution)

**1. Spec coverage:**
- Opt-in `BOULE_AUTO_MODE=type2` deny-by-default (spec §0.2.4/§5) → Task 3 + Task 4 off-mode refusal. ✓
- Drive off conductor-advanceability, not E suggestions (spec §0.2.1) → Task 4 iterates `plansOf` + `deriveConductorState`. ✓
- Safety Gate G0–G3 (spec §3) → `evaluateAutoDispatch` (Task 2). ✓ Candidate set = non-terminal plans (critic nit #2) → `isTerminalPlanPhase` skip + G1 records `plan_not_accepted`. ✓
- 4 dispatch events (spec §4) → Task 1. ✓ Dedup keyed off **materialization (`step_bound`)** not `instruction_planned` (spec rev.2 **M2** — partial-failure poisoning) → `materializedKey` built from `step_bound`; `action_denied` deduped on `(planId,stepIndex,reason)` → `deniedKey`. ✓ G3 reason precedence `done` before `in_flight` (rev.2 **M3**) → `policy.ts` ordered checks + done-criterion #5. ✓ Phase I = sole producer of the 4 events, F2 must reuse this body schema (rev.2 **M1**) → Task 7 ADR. ✓ `mode_off` suppressed (nit #4) → off-mode early return, no emit. ✓
- `conductPlan` throw → `orchestrator_action_failed` (critic gap) → try/catch (Task 4). ✓ Best-effort per plan → loop continues. ✓
- INVARIANT #1 structural (spec §1) → import-graph negative + 0-`decision_*` test + flag≠approval test (Task 4/6). ✓
- `listDispatchLog` sorted by id (critic gap) → Task 5. ✓ ADR (spec §9 + critic) → Task 7. ✓
- Headless; live = user-run (spec §7.10) → Task 7.4. ✓ No `bindings.ts`/migration → Task 6.4 gate. ✓

**2. Placeholder scan:** Every step shows real code. Three `>` notes ask the implementer to confirm exact local API shapes (`registerTool` signature, `hasOpenBlock` open-criteria, `DecisionState` fixture) against the repo — legitimate verifications, not skipped work.

**3. Type consistency:** `AutoMode`/`AutoDispatchVerdict`/`AutoDenyReason`/`evaluateAutoDispatch`/`isTerminalPlanPhase`/`autoDispatch`/`DispatchSummary`/`listDispatchLog`/`DispatchLogEntry`/`parseAutoMode`/`ConductorState{planId,planPhase,cursor,halted,done}`/`conductPlan(...).advanced.{stepIndex,taskId}` all used identically across tasks and match the verified as-built signatures.

**4. The id-collision hazard** (dispatcher stamps vs. `conductPlan`'s 4 internal `+i*1000` events) is handled by reserving 4 stamp slots around each `conductPlan` call (Task 4, Step 3 comment) — `writeEvent`'s `wx` flag would otherwise throw on a same-second same-id collision.

---

## Execution Handoff

Plan saved to `governance/docs/plans/2026-06-03-boule-v3-phase-i-narrow-auto.md`.

⚠️ **Gated:** this plan goes to a **separate plan-critic** next. **Do NOT execute (build) without an explicit user "build it"** — Phase I is autonomy-boundary-sensitive. After plan-critic ACCEPT and the user's go: Subagent-Driven (recommended) or Inline execution, TDD per task, then the Task-7 impl-critic.
