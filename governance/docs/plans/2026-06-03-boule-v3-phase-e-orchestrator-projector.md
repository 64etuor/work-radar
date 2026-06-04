# Boule v3 Phase E — Orchestrator Projector (observe/suggest only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the read-half of the Boule Orchestrator — a pure cross-fold projection over task/plan/session/decision states plus a Policy Evaluator that emits **advisory suggestions only**.

**Architecture:** `src/orchestrator/` gains a pure `projectOrchestratorView` (joins the existing `projectTasks`/`projectPlans`/`projectSessions` folds + the reused `hasOpenBlock` coupling — no new fold), a pure `evaluateSuggestions` (5 rules), and a `suggest` boundary (mirror of `session/observer.ts`) that emits **only** `orchestrator_suggestion_created`, deduped per `(ruleId, subjectId)`. Zero `decision_*`/`task_*`/`session_*` write-path (negative test). No DB, no UI, `bindings.ts` untouched.

**Tech Stack:** Node 24 strip-types TypeScript (src `.ts`, test imports `.js`), vitest, gray-matter events, MCP stdio (`@modelcontextprotocol/sdk` `registerTool`).

**Spec:** `governance/docs/design/2026-06-03-boule-v3-phase-e-orchestrator-projector-design.md` (committed `4bf531f`).

**Invariants this plan enforces (non-negotiable):**
- **One new event type only:** `orchestrator_suggestion_created` (suggestion-class, `source:"system"`, `actor:"system"`, no verdict). No `instruction_*`/`orchestrator_action_*`/`action_denied`/`projection_rebuilt` (Phase I).
- **No `decision_*`/`task_*`/`session_*` write-path** — proven by Task 6 negative test (INVARIANT #1).
- **Evidence required:** vitest green + negative test + keystone property test + `tsc --noEmit` 0 + `bindings.ts` byte-unchanged.

**Gates (run from `governance/`):**
- `pnpm exec tsc --noEmit` → 0 errors
- `pnpm exec vitest run` → all green (current baseline 354; this slice adds tests)

**Commit policy for this branch:** local `git commit --no-verify` only (don't Prettier governance Markdown). **No push / merge / delete** — `feat/boule-v3-phase-d` is PARKED. Do NOT begin implementation, critic, or commit until execution is explicitly approved.

---

## File Structure

**Create:**
- `src/orchestrator/view.ts` — `OrchestratorView`, `TaskView`, `projectOrchestratorView` (pure join).
- `src/orchestrator/policy.ts` — `RuleId`, `SuggestionCandidate`, `evaluateSuggestions` (pure, 5 rules).
- `src/orchestrator/suggest.ts` — `SuggestSummary`, `suggest` (emit + dedup boundary).
- `src/orchestrator/project.ts` — `OpenSuggestion`, `renderOrchestrator`, `listSuggestions`.
- `test/orchestrator/view.test.ts`
- `test/orchestrator/policy.test.ts`
- `test/orchestrator/suggest.test.ts`
- `test/orchestrator/project.test.ts`
- `test/orchestrator/negative.test.ts`

**Modify:**
- `src/event/event.ts` — add `"orchestrator_suggestion_created"` to the `EventType` union.
- `src/mcp/server.ts` — register `suggest` + `suggestions` tools (outside the executor-role gate block, like `observe_sessions`).

---

## Task 1: New event type `orchestrator_suggestion_created`

**Files:**
- Modify: `src/event/event.ts` (the `EventType` union, after the session block ~line 45)
- Test: `test/orchestrator/event.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/orchestrator/event.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { serializeEvent, parseEvent, type GovEvent } from "../../src/event/event.js";

describe("orchestrator_suggestion_created event type", () => {
  it("round-trips serialize → parse", () => {
    const evt: GovEvent = {
      frontmatter: {
        id: "evt_20260603_140000_0001",
        type: "orchestrator_suggestion_created",
        source: "system",
        actor: "system",
        tags: ["orchestrator", "suggestion"],
        related_to: ["evt_task0"],
      },
      body: JSON.stringify({ rule: "task_needs_session", subject: "evt_task0", subjectType: "task", detail: "x" }),
    };
    const round = parseEvent(serializeEvent(evt));
    expect(round.frontmatter.type).toBe("orchestrator_suggestion_created");
    expect(JSON.parse(round.body).rule).toBe("task_needs_session");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm exec tsc --noEmit`
Expected: FAIL — `Type '"orchestrator_suggestion_created"' is not assignable to type 'EventType'`.

- [ ] **Step 3: Add the event type to the union**

In `src/event/event.ts`, append to the `EventType` union (after `"session_recovered";` — note: move the trailing `;` to the new last line):

```ts
  | "session_recovered"                 // observer saw a crashed surface return → recovering
  // v3 Phase E: Orchestrator emits an advisory suggestion. suggestion-class — source/actor=system,
  // NO verdict. This is the ONLY new write权한 in Phase E (master §4.1); dispatch events deferred to Phase I.
  | "orchestrator_suggestion_created";
```

(If `"session_recovered"` currently ends the union with `;`, replace that `;` with the two lines above so the union terminates on `orchestrator_suggestion_created`.)

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run test/orchestrator/event.test.ts`
Expected: tsc 0 errors; test PASS.

- [ ] **Step 5: Commit (local, no-verify)**

```bash
git add governance/src/event/event.ts governance/test/orchestrator/event.test.ts
git commit --no-verify -m "feat(governance): Phase E event type orchestrator_suggestion_created"
```

---

## Task 2: Pure cross-fold projection `projectOrchestratorView`

**Files:**
- Create: `src/orchestrator/view.ts`
- Test: `test/orchestrator/view.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/orchestrator/view.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { projectOrchestratorView } from "../../src/orchestrator/view.js";
import type { GovEvent } from "../../src/event/event.js";

function ev(id: string, type: GovEvent["frontmatter"]["type"], body = "", related?: string[]): GovEvent {
  return {
    frontmatter: { id, type, source: "system", actor: "user", tags: [], ...(related ? { related_to: related } : {}) },
    body,
  };
}

describe("projectOrchestratorView", () => {
  it("joins task/plan/session folds and computes per-task hasOpenBlock", () => {
    const all: GovEvent[] = [
      ev("evt_t1", "task_created", "Build X"),
      ev("evt_t1s", "task_started", "Started", ["evt_t1"]), // t1 → active
      ev("evt_p1", "plan_proposed", "Plan A"),
      ev("evt_s1", "session_opened", JSON.stringify({ surface: "3", ownership: "external_owned" })),
      // an unresolved decision_blocked referencing t1 (proposal absent → conservative open)
      ev("evt_b1", "decision_blocked", JSON.stringify({ question: "?" }), ["evt_dec1", "evt_t1"]),
    ];
    const view = projectOrchestratorView(all);
    expect(view.tasks.find((t) => t.state.taskId === "evt_t1")?.state.phase).toBe("active");
    expect(view.tasks.find((t) => t.state.taskId === "evt_t1")?.hasOpenBlock).toBe(true);
    expect(view.plans.map((p) => p.planId)).toContain("evt_p1");
    expect(view.sessions.find((s) => s.sessionId === "evt_s1")?.ownership).toBe("external_owned");
  });

  it("is pure — same input twice yields deep-equal output", () => {
    const all: GovEvent[] = [ev("evt_t1", "task_created", "X")];
    expect(projectOrchestratorView(all)).toEqual(projectOrchestratorView(all));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm exec vitest run test/orchestrator/view.test.ts`
Expected: FAIL — cannot find module `../../src/orchestrator/view.js`.

- [ ] **Step 3: Write the implementation**

Create `src/orchestrator/view.ts`:

```ts
import type { GovEvent } from "../event/event.ts";
import { projectTasks } from "../task/project.ts";
import { projectPlans } from "../plan/project.ts";
import { projectSessions } from "../session/project.ts";
import { hasOpenBlock } from "../task/handlers.ts";
import type { TaskState } from "../task/task.ts";
import type { PlanState } from "../plan/plan.ts";
import type { SessionState } from "../session/session.ts";

export interface TaskView {
  state: TaskState;
  /** Reuses task/handlers.hasOpenBlock — the EXACT INVARIANT #1 coupling, not a duplicate fold. */
  hasOpenBlock: boolean;
}

export interface OrchestratorView {
  tasks: TaskView[];
  plans: PlanState[];
  sessions: SessionState[];
}

/** PURE: events → cross-fold read model. Reuses the existing per-axis folds (god-fold ban, master
 *  §8) and the reused hasOpenBlock coupling. No I/O, emits no events. The keystone invariant holds:
 *  this is a total function of the event log (renderOrchestrator persists it; rebuildable byte-for-byte). */
export function projectOrchestratorView(all: GovEvent[]): OrchestratorView {
  const tasks: TaskView[] = projectTasks(all).map((state) => ({
    state,
    hasOpenBlock: hasOpenBlock(all, state.taskId),
  }));
  return { tasks, plans: projectPlans(all), sessions: projectSessions(all) };
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run test/orchestrator/view.test.ts`
Expected: tsc 0; both tests PASS.

- [ ] **Step 5: Commit (local, no-verify)**

```bash
git add governance/src/orchestrator/view.ts governance/test/orchestrator/view.test.ts
git commit --no-verify -m "feat(governance): Phase E projectOrchestratorView (pure cross-fold join)"
```

---

## Task 3: Pure Policy Evaluator `evaluateSuggestions` (5 rules)

**Files:**
- Create: `src/orchestrator/policy.ts`
- Test: `test/orchestrator/policy.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/orchestrator/policy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { evaluateSuggestions } from "../../src/orchestrator/policy.js";
import type { OrchestratorView } from "../../src/orchestrator/view.js";
import type { SessionState } from "../../src/session/session.js";
import type { TaskState } from "../../src/task/task.js";

function task(taskId: string, phase: TaskState["phase"], hasOpenBlock = false) {
  const verdict = phase === "done" ? "done" : phase === "cancelled" ? "cancelled" : null;
  return { state: { taskId, title: taskId, phase, verdict } as TaskState, hasOpenBlock };
}
function sess(sessionId: string, phase: SessionState["phase"], taskId: string | null, ownership: SessionState["ownership"] = "orchestrator_owned"): SessionState {
  return { sessionId, surface: "1", ownership, taskId, phase, verdict: phase === "closed" ? "closed" : null };
}
const view = (over: Partial<OrchestratorView>): OrchestratorView => ({ tasks: [], plans: [], sessions: [], ...over });

describe("evaluateSuggestions — the 5 rules", () => {
  it("rule 1 session_checkpoint: context_pressure_high session", () => {
    const out = evaluateSuggestions(view({ sessions: [sess("evt_s1", "context_pressure_high", "evt_t1")] }));
    expect(out.map((c) => c.ruleId)).toContain("session_checkpoint");
  });

  it("rule 2 task_needs_session: active task with no bound non-closed session", () => {
    const out = evaluateSuggestions(view({ tasks: [task("evt_t1", "active")] }));
    expect(out.find((c) => c.ruleId === "task_needs_session")?.subjectId).toBe("evt_t1");
  });

  it("rule 2 no-fire: active task that already has an open bound session", () => {
    const out = evaluateSuggestions(view({
      tasks: [task("evt_t1", "active")],
      sessions: [sess("evt_s1", "active", "evt_t1")],
    }));
    expect(out.some((c) => c.ruleId === "task_needs_session")).toBe(false);
  });

  it("rule 3 session_stale: active session whose bound task is done", () => {
    const out = evaluateSuggestions(view({
      tasks: [task("evt_t1", "done")],
      sessions: [sess("evt_s1", "active", "evt_t1")],
    }));
    expect(out.find((c) => c.ruleId === "session_stale")?.subjectId).toBe("evt_s1");
  });

  it("rule 4 task_blocked_decision: non-terminal task with open block", () => {
    const out = evaluateSuggestions(view({ tasks: [task("evt_t1", "blocked", true)] }));
    expect(out.find((c) => c.ruleId === "task_blocked_decision")?.subjectId).toBe("evt_t1");
  });

  it("rule 4 no-fire: terminal task is not flagged even with hasOpenBlock", () => {
    const out = evaluateSuggestions(view({ tasks: [task("evt_t1", "done", true)] }));
    expect(out.some((c) => c.ruleId === "task_blocked_decision")).toBe(false);
  });

  it("rule 5 orphan_session: active external_owned session with null task", () => {
    const out = evaluateSuggestions(view({ sessions: [sess("evt_s1", "active", null, "external_owned")] }));
    expect(out.find((c) => c.ruleId === "orphan_session")?.subjectId).toBe("evt_s1");
  });

  it("emits nothing for an empty view; output is deterministically sorted", () => {
    expect(evaluateSuggestions(view({}))).toEqual([]);
    const out = evaluateSuggestions(view({
      tasks: [task("evt_t2", "active"), task("evt_t1", "active")],
    }));
    expect(out.map((c) => c.subjectId)).toEqual(["evt_t1", "evt_t2"]); // sorted within a ruleId
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm exec vitest run test/orchestrator/policy.test.ts`
Expected: FAIL — cannot find module `../../src/orchestrator/policy.js`.

- [ ] **Step 3: Write the implementation**

Create `src/orchestrator/policy.ts`:

```ts
import type { SessionPhase } from "../session/session.ts";
import type { OrchestratorView } from "./view.ts";

export type RuleId =
  | "session_checkpoint"
  | "task_needs_session"
  | "session_stale"
  | "task_blocked_decision"
  | "orphan_session";

export interface SuggestionCandidate {
  ruleId: RuleId;
  subjectId: string;
  subjectType: "session" | "task";
  detail: string;
}

/** "active-like" = a live, observed session (mirror of session/observer.ts ALIVE_OBSERVED): every
 *  phase except the pre-birth births (planned/opening) and the terminal (closed). */
const ACTIVE_LIKE: ReadonlySet<SessionPhase> = new Set<SessionPhase>([
  "active",
  "waiting",
  "blocked",
  "context_pressure_high",
  "checkpoint_requested",
  "handoff_ready",
  "recovering",
]);

/** PURE: cross-fold view → advisory suggestion candidates (master §4.3 anemic auto). No I/O, no
 *  emit, no verdict. Output is deterministically sorted by (ruleId, subjectId). No rule suppression
 *  or priority in this slice — one subject may fire multiple distinct-key candidates. */
export function evaluateSuggestions(view: OrchestratorView): SuggestionCandidate[] {
  const out: SuggestionCandidate[] = [];
  const taskById = new Map(view.tasks.map((t) => [t.state.taskId, t]));
  // tasks that already have a non-closed session bound to them (for rule 2).
  const boundTaskIds = new Set(
    view.sessions
      .filter((s) => s.phase !== "closed" && s.taskId !== null)
      .map((s) => s.taskId as string),
  );

  for (const s of view.sessions) {
    const activeLike = ACTIVE_LIKE.has(s.phase);
    // rule 1
    if (s.phase === "context_pressure_high") {
      out.push({ ruleId: "session_checkpoint", subjectId: s.sessionId, subjectType: "session", detail: "context pressure high — checkpoint recommended" });
    }
    // rule 3
    if (activeLike && s.taskId !== null) {
      const t = taskById.get(s.taskId);
      if (t && (t.state.phase === "done" || t.state.phase === "cancelled")) {
        out.push({ ruleId: "session_stale", subjectId: s.sessionId, subjectType: "session", detail: `bound task ${s.taskId} is ${t.state.phase} — consider closing` });
      }
    }
    // rule 5
    if (activeLike && s.taskId === null && s.ownership === "external_owned") {
      out.push({ ruleId: "orphan_session", subjectId: s.sessionId, subjectType: "session", detail: "orphan session with no bound task" });
    }
  }

  for (const t of view.tasks) {
    const terminal = t.state.phase === "done" || t.state.phase === "cancelled";
    // rule 2
    if (t.state.phase === "active" && !boundTaskIds.has(t.state.taskId)) {
      out.push({ ruleId: "task_needs_session", subjectId: t.state.taskId, subjectType: "task", detail: "active task with no open session" });
    }
    // rule 4
    if (!terminal && t.hasOpenBlock) {
      out.push({ ruleId: "task_blocked_decision", subjectId: t.state.taskId, subjectType: "task", detail: "unresolved decision_blocked in task chain — needs human" });
    }
  }

  return out.sort((a, b) =>
    a.ruleId === b.ruleId ? a.subjectId.localeCompare(b.subjectId) : a.ruleId.localeCompare(b.ruleId),
  );
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run test/orchestrator/policy.test.ts`
Expected: tsc 0; all 8 tests PASS.

- [ ] **Step 5: Commit (local, no-verify)**

```bash
git add governance/src/orchestrator/policy.ts governance/test/orchestrator/policy.test.ts
git commit --no-verify -m "feat(governance): Phase E evaluateSuggestions (5 advisory rules, pure)"
```

---

## Task 4: `suggest` boundary — emit + dedup (mirror observer)

**Files:**
- Create: `src/orchestrator/suggest.ts`
- Test: `test/orchestrator/suggest.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/orchestrator/suggest.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggest } from "../../src/orchestrator/suggest.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 14, 0, s));
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-orch-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function ev(id: string, type: GovEvent["frontmatter"]["type"], body = "", related?: string[]): GovEvent {
  return { frontmatter: { id, type, source: "system", actor: "user", tags: [], ...(related ? { related_to: related } : {}) }, body };
}
async function typesOf(): Promise<string[]> { return (await readAllEvents(dir)).map((e) => e.frontmatter.type); }
function count(types: string[], t: string): number { return types.filter((x) => x === t).length; }

describe("suggest — emit + dedup", () => {
  it("an active task with no session → one orchestrator_suggestion_created", async () => {
    await writeEvent(dir, ev("evt_t1", "task_created", "Build X"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "Started", ["evt_t1"]), at(1));
    const r = await suggest(dir, at(10), 0.1);
    expect(r.created).toBe(1);
    expect(count(await typesOf(), "orchestrator_suggestion_created")).toBe(1);
  });

  it("is idempotent — second pass with no state change creates 0", async () => {
    await writeEvent(dir, ev("evt_t1", "task_created", "Build X"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "Started", ["evt_t1"]), at(1));
    await suggest(dir, at(10), 0.1);
    const r2 = await suggest(dir, at(20), 0.2);
    expect(r2.created).toBe(0);
    expect(r2.skipped).toBe(1);
    expect(count(await typesOf(), "orchestrator_suggestion_created")).toBe(1);
  });

  it("emits ONLY orchestrator_suggestion_created (no other new type)", async () => {
    await writeEvent(dir, ev("evt_t1", "task_created", "Build X"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "Started", ["evt_t1"]), at(1));
    const before = await typesOf();
    await suggest(dir, at(10), 0.1);
    const after = await typesOf();
    const newTypes = new Set(after.filter((t, i) => i >= before.length));
    expect([...newTypes]).toEqual(["orchestrator_suggestion_created"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm exec vitest run test/orchestrator/suggest.test.ts`
Expected: FAIL — cannot find module `../../src/orchestrator/suggest.js`.

- [ ] **Step 3: Write the implementation**

Create `src/orchestrator/suggest.ts`:

```ts
import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents } from "../decision/readEvents.ts";
import { projectOrchestratorView } from "./view.ts";
import { evaluateSuggestions } from "./policy.ts";

export interface SuggestSummary {
  created: number;
  skipped: number; // candidates whose (ruleId, subjectId) already had an open suggestion
}

const SEP = " ";
function keyOf(rule: string, subject: string): string {
  return `${rule}${SEP}${subject}`;
}

/** suggest — read events, project the cross-fold view, evaluate advisory rules, and emit AT MOST
 *  ONE orchestrator_suggestion_created per (ruleId, subjectId) not already present in the log
 *  (dedup → no flood; idempotent: run1 emits N, run2 emits 0). This boundary NEVER emits any
 *  decision_*/task_*/session_* event — the ONLY emission type is orchestrator_suggestion_created
 *  (negative test, INVARIANT #1). On-demand: one pass, no poll loop (INVARIANT #5). Mirrors
 *  session/observer.ts (per-emission now + i*1000 offset → distinct chronological ids in one pass). */
export async function suggest(workspaceDir: string, now: Date, rand: number): Promise<SuggestSummary> {
  const all = await readAllEvents(workspaceDir);
  const candidates = evaluateSuggestions(projectOrchestratorView(all));

  const existing = new Set<string>();
  for (const e of all) {
    if (e.frontmatter.type !== "orchestrator_suggestion_created") continue;
    try {
      const b = JSON.parse(e.body) as { rule?: string; subject?: string };
      if (typeof b.rule === "string" && typeof b.subject === "string") existing.add(keyOf(b.rule, b.subject));
    } catch {
      // malformed prior suggestion → ignore for dedup (defensive; suggest only writes canonical JSON)
    }
  }

  const summary: SuggestSummary = { created: 0, skipped: 0 };
  let i = 0;
  for (const c of candidates) {
    const k = keyOf(c.ruleId, c.subjectId);
    if (existing.has(k)) {
      summary.skipped++;
      continue;
    }
    const stamp = new Date(now.getTime() + i * 1000);
    const evt: GovEvent = {
      frontmatter: {
        id: generateId("evt", stamp, rand),
        type: "orchestrator_suggestion_created",
        source: "system",
        actor: "system",
        tags: ["orchestrator", "suggestion"],
        related_to: [c.subjectId],
      },
      body: JSON.stringify({ rule: c.ruleId, subject: c.subjectId, subjectType: c.subjectType, detail: c.detail }),
    };
    await writeEvent(workspaceDir, evt, stamp);
    existing.add(k);
    summary.created++;
    i++;
  }
  return summary;
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run test/orchestrator/suggest.test.ts`
Expected: tsc 0; all 3 tests PASS.

- [ ] **Step 5: Commit (local, no-verify)**

```bash
git add governance/src/orchestrator/suggest.ts governance/test/orchestrator/suggest.test.ts
git commit --no-verify -m "feat(governance): Phase E suggest boundary (emit + (rule,subject) dedup)"
```

---

## Task 5: `renderOrchestrator` + `listSuggestions` (keystone property test)

**Files:**
- Create: `src/orchestrator/project.ts`
- Test: `test/orchestrator/project.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/orchestrator/project.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderOrchestrator, listSuggestions } from "../../src/orchestrator/project.js";
import { suggest } from "../../src/orchestrator/suggest.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 14, 0, s));
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-orch-proj-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function ev(id: string, type: GovEvent["frontmatter"]["type"], body = "", related?: string[]): GovEvent {
  return { frontmatter: { id, type, source: "system", actor: "user", tags: [], ...(related ? { related_to: related } : {}) }, body };
}

describe("renderOrchestrator — keystone property", () => {
  it("render is byte-identical after wiping state/ (derived, not authored)", async () => {
    await writeEvent(dir, ev("evt_t1", "task_created", "Build X"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "Started", ["evt_t1"]), at(1));
    const path = await renderOrchestrator(dir);
    const first = await readFile(path, "utf8");
    await rm(join(dir, "state"), { recursive: true, force: true });
    await renderOrchestrator(dir);
    const second = await readFile(path, "utf8");
    expect(second).toBe(first);
  });
});

describe("listSuggestions", () => {
  it("returns every emitted suggestion (all open in this slice)", async () => {
    await writeEvent(dir, ev("evt_t1", "task_created", "Build X"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "Started", ["evt_t1"]), at(1));
    await suggest(dir, at(10), 0.1);
    const list = await listSuggestions(dir);
    expect(list).toHaveLength(1);
    expect(list[0].rule).toBe("task_needs_session");
    expect(list[0].subject).toBe("evt_t1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd governance && pnpm exec vitest run test/orchestrator/project.test.ts`
Expected: FAIL — cannot find module `../../src/orchestrator/project.js`.

- [ ] **Step 3: Write the implementation**

Create `src/orchestrator/project.ts`:

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readAllEvents } from "../decision/readEvents.ts";
import { projectOrchestratorView } from "./view.ts";

export interface OpenSuggestion {
  id: string;
  rule: string;
  subject: string;
  subjectType: string;
  detail: string;
}

/** Render the derived cross-fold view to state/orchestrator-view.json. Overwrites; fully
 *  rebuildable from events; deterministic field + element order → byte-stable output (keystone
 *  property test). This writer holds NO authority — it only projects existing folds. */
export async function renderOrchestrator(workspaceDir: string): Promise<string> {
  const view = projectOrchestratorView(await readAllEvents(workspaceDir));
  const stateDir = join(workspaceDir, "state");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "orchestrator-view.json");
  const rows = {
    tasks: view.tasks.map((t) => ({ taskId: t.state.taskId, phase: t.state.phase, hasOpenBlock: t.hasOpenBlock })),
    plans: view.plans.map((p) => ({ planId: p.planId, phase: p.phase })),
    sessions: view.sessions.map((s) => ({ sessionId: s.sessionId, phase: s.phase, ownership: s.ownership, taskId: s.taskId })),
  };
  await writeFile(path, JSON.stringify(rows, null, 2) + "\n");
  return path;
}

/** Open suggestions = all orchestrator_suggestion_created events. In this slice there is no
 *  dismiss/acknowledge event, so every emitted suggestion is open (sorted by id). */
export async function listSuggestions(workspaceDir: string): Promise<OpenSuggestion[]> {
  const all = await readAllEvents(workspaceDir);
  const out: OpenSuggestion[] = [];
  for (const e of all) {
    if (e.frontmatter.type !== "orchestrator_suggestion_created") continue;
    try {
      const b = JSON.parse(e.body) as { rule?: string; subject?: string; subjectType?: string; detail?: string };
      out.push({
        id: e.frontmatter.id,
        rule: b.rule ?? "",
        subject: b.subject ?? "",
        subjectType: b.subjectType ?? "",
        detail: b.detail ?? "",
      });
    } catch {
      // skip malformed (defensive)
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
```

- [ ] **Step 4: Run test + typecheck to verify pass**

Run: `cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run test/orchestrator/project.test.ts`
Expected: tsc 0; both tests PASS.

- [ ] **Step 5: Commit (local, no-verify)**

```bash
git add governance/src/orchestrator/project.ts governance/test/orchestrator/project.test.ts
git commit --no-verify -m "feat(governance): Phase E renderOrchestrator + listSuggestions (keystone property)"
```

---

## Task 6: NEGATIVE test — no decision/task/session write-path (INVARIANT #1)

**Files:**
- Create: `test/orchestrator/negative.test.ts`

This is the structural proof of master §4.4#1 / INVARIANT #1: the orchestrator read-half mints no verdict and advances nothing. Mirror of `test/session/negative.test.ts`.

- [ ] **Step 1: Write the test (it should pass immediately — the guarantee is structural)**

Create `test/orchestrator/negative.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suggest } from "../../src/orchestrator/suggest.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 3, 14, 0, s));
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-orch-neg-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
function ev(id: string, type: GovEvent["frontmatter"]["type"], body = "", related?: string[]): GovEvent {
  return { frontmatter: { id, type, source: "system", actor: "user", tags: [], ...(related ? { related_to: related } : {}) }, body };
}

describe("suggest — INVARIANT #1: no verdict, no advance (negative)", () => {
  it("emits no decision_*/task_*/session_* event even when every rule fires", async () => {
    // Seed a scenario that triggers all 5 rules at once.
    await writeEvent(dir, ev("evt_t1", "task_created", "active no-session"), at(0));
    await writeEvent(dir, ev("evt_t1s", "task_started", "S", ["evt_t1"]), at(1)); // rule 2
    await writeEvent(dir, ev("evt_t2", "task_created", "blocked task"), at(2));
    await writeEvent(dir, ev("evt_t2s", "task_started", "S", ["evt_t2"]), at(3));
    await writeEvent(dir, ev("evt_t2b", "task_blocked", "B", ["evt_t2"]), at(4));
    await writeEvent(dir, ev("evt_b1", "decision_blocked", JSON.stringify({ question: "?" }), ["evt_decX", "evt_t2"]), at(5)); // rule 4 (proposal absent → open)
    await writeEvent(dir, ev("evt_t3", "task_created", "done task"), at(6));
    await writeEvent(dir, ev("evt_t3s", "task_started", "S", ["evt_t3"]), at(7));
    await writeEvent(dir, ev("evt_t3d", "task_completed", "D", ["evt_t3"]), at(8));
    await writeEvent(dir, ev("evt_s1", "session_spawned", JSON.stringify({ surface: "9" }), ["evt_t3"]), at(9));
    await writeEvent(dir, ev("evt_s1o", "session_observed", "obs", ["evt_s1"]), at(10)); // active, bound to done task → rule 3
    await writeEvent(dir, ev("evt_s2", "session_opened", JSON.stringify({ surface: "8", ownership: "external_owned" })), at(11));
    await writeEvent(dir, ev("evt_s2o", "session_observed", "obs", ["evt_s2"]), at(12)); // orphan active → rule 5
    await writeEvent(dir, ev("evt_s3", "session_opened", JSON.stringify({ surface: "7", ownership: "user_owned" })), at(13));
    await writeEvent(dir, ev("evt_s3p", "session_context_pressure_changed", JSON.stringify({ level: "high" }), ["evt_s3"]), at(14)); // rule 1

    const before = await readAllEvents(dir);
    const r = await suggest(dir, at(20), 0.5);
    const after = await readAllEvents(dir);

    // Every NEW event is an orchestrator_suggestion_created — nothing else.
    const newEvents = after.slice(before.length);
    expect(newEvents.length).toBe(r.created);
    expect(newEvents.length).toBeGreaterThanOrEqual(5); // all 5 rules fired
    for (const e of newEvents) {
      expect(e.frontmatter.type).toBe("orchestrator_suggestion_created");
      expect(e.frontmatter.actor).toBe("system"); // never actor=user — mints no verdict
    }
    // Explicitly: zero new decision_*/task_*/session_* events.
    const forbidden = (t: string) => t.startsWith("decision_") || t.startsWith("task_") || t.startsWith("session_");
    expect(newEvents.some((e) => forbidden(e.frontmatter.type))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd governance && pnpm exec vitest run test/orchestrator/negative.test.ts`
Expected: PASS. (If it fails because fewer than 5 rules fired, fix the seed — do NOT relax the assertion; the negative guarantee is the point.)

- [ ] **Step 3: Commit (local, no-verify)**

```bash
git add governance/test/orchestrator/negative.test.ts
git commit --no-verify -m "test(governance): Phase E negative — suggest mints no verdict, advances nothing (INVARIANT #1)"
```

---

## Task 7: Wire `suggest` + `suggestions` MCP tools

**Files:**
- Modify: `src/mcp/server.ts` (imports near top; tool registration near `observe_sessions`, OUTSIDE the executor-role gate block)

- [ ] **Step 1: Add imports**

Near the other `../<module>/...` imports at the top of `src/mcp/server.ts`, add:

```ts
import { suggest } from "../orchestrator/suggest.ts";
import { listSuggestions } from "../orchestrator/project.ts";
```

- [ ] **Step 2: Register the two tools (verdict-free → not executor-gated)**

Add near the `observe_sessions`/`sessions` registrations (these are registered unconditionally, outside the `if (!IS_EXECUTOR)` verdict-tool blocks):

```ts
// v3 Phase E — Orchestrator read-half. suggest mints NO verdict (suggestion-class only), so it is
// registered unconditionally like observe_sessions. It touches no cmux/network — folds only.
server.registerTool(
  "suggest",
  { description: "교차-fold 관찰 → advisory 제안 방출 (orchestrator_suggestion_created만; on-demand 1패스)", inputSchema: {} },
  async () => {
    const r = await suggest(WORKSPACE, nowFn(), randFn());
    return { content: [{ type: "text", text: `suggestions created ${r.created} / skipped ${r.skipped}` }] };
  },
);
server.registerTool(
  "suggestions",
  { description: "open orchestrator 제안 목록 (read-only)", inputSchema: {} },
  async () => {
    const list = await listSuggestions(WORKSPACE);
    const text = list.length
      ? list.map((s) => `${s.id} [${s.rule}] ${s.subjectType}=${s.subject} ${s.detail}`).join("\n")
      : "(no open suggestions)";
    return { content: [{ type: "text", text }] };
  },
);
```

(Confirm `WORKSPACE`, `nowFn`, `randFn` are the same identifiers used by the `start_task`/`observe_sessions` registrations already in this file — reuse them verbatim.)

- [ ] **Step 3: Typecheck + full test run**

Run: `cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run`
Expected: tsc 0; ALL tests green (354 baseline + the new orchestrator tests).

- [ ] **Step 4: Assert `bindings.ts` untouched (INVARIANT #4 — MCP is stdio)**

Run: `git -C <repo-root> status --short src/bindings.ts`
Expected: empty output (no change). Governance MCP is stdio → not a specta IPC surface.

- [ ] **Step 5: Commit (local, no-verify)**

```bash
git add governance/src/mcp/server.ts
git commit --no-verify -m "feat(governance): Phase E MCP wiring — suggest + suggestions (verdict-free)"
```

---

## Task 8: Final verification + Done-criteria evidence

**Files:** none (verification + handoff).

- [ ] **Step 1: Full gate sweep (capture output as evidence)**

Run: `cd governance && pnpm exec tsc --noEmit && pnpm exec vitest run`
Record: tsc = 0 errors; vitest = N files / M tests green (M = 354 baseline + ~14 new). "could not run" ≠ "passed".

- [ ] **Step 2: Walk the spec §7 Done-criteria and tick each against observed output**

- [ ] (1) `task_needs_session` fires for an active task with no session — Task 4 test + `suggestions` lists it.
- [ ] (2) `session_checkpoint` fires for a `context_pressure_high` session — Task 3 rule-1 test (+ negative-test seed).
- [ ] (3) all 5 rules fire/no-fire — Task 3 (8 assertions).
- [ ] (4) idempotent: run2 `created: 0` — Task 4 idempotency test.
- [ ] (5) NEGATIVE: no `decision_*`/`task_*`/`session_*` emission — Task 6.
- [ ] (6) keystone property: render byte-identical after `state/` wipe — Task 5.
- [ ] (7) `bindings.ts` unchanged; no Postgres — Task 7 Step 4.

- [ ] **Step 3: Separate critic pass (REQUIRED — self-approve 금지)**

Dispatch an independent `oh-my-claudecode:critic` (opus) pass over the full slice against INVARIANTS #1/#4/#5/#6 and the spec. Do NOT mark DONE until critic ACCEPT with 0 blockers. (This step is gated on explicit user go for execution.)

- [ ] **Step 4: After critic ACCEPT — mark INDEX (standing directive)**

In `governance/docs/INDEX.md` v3 master-phase table, change Phase **E** row to:
`✅ DONE (critic ACCEPT, vitest <M>)` with plan link `plans/2026-06-03-boule-v3-phase-e-orchestrator-projector.md` + the final commit hash. Update the header line "A–D built / E–I planned" → "A–E built / F–I planned". Commit `--no-verify` (local; keep INDEX reconciled to git).

```bash
git add governance/docs/INDEX.md
git commit --no-verify -m "docs(governance): mark v3 Phase E DONE in INDEX (orchestrator projector)"
```

- [ ] **Step 5: STOP.** No push / merge / delete — branch is PARKED. Report evidence + await user direction on integration.

---

## Self-Review (writing-plans)

- **Spec coverage:** §1 view → Task 2; §2 components → Tasks 2/3/4/5; §3 five rules → Task 3 (+ negative seed Task 6); §4 event type + dedup/idempotent → Tasks 1/4; §5 MCP commands → Task 7; §6 storage (`state/orchestrator-view.json`) → Task 5; §7 done-criteria → Task 8; §8 INVARIANTS → Task 6 (#1), Task 7 (#4/#6), suggest doc (#5). No gaps.
- **Placeholder scan:** none — every code step is complete; no "TBD"/"add error handling"/"similar to Task N".
- **Type consistency:** `OrchestratorView`/`TaskView` (Task 2) ↔ consumed in `policy.ts` (Task 3) and `project.ts` (Task 5); `SuggestSummary{created,skipped}` (Task 4) ↔ asserted in Task 4 tests + reported in Task 7; `RuleId` union (Task 3) ↔ rule assertions (Tasks 3/6); `keyOf(rule,subject)` dedup key consistent within Task 4. `evaluateSuggestions`/`projectOrchestratorView`/`suggest`/`renderOrchestrator`/`listSuggestions` names identical across tasks. `hasOpenBlock(all, taskId)` reused from `src/task/handlers.ts` (not redefined). `generateId("evt", date, rand)` + `writeEvent(ws, evt, now)` signatures match the codebase.

## Notes / deferred (spec §4, §10)

- **Suggestion lifecycle deferred:** no acknowledge/dismiss event and no condition-cleared re-arm in this slice. A `(ruleId, subjectId)` that has ever been suggested will not re-fire even if its condition clears and recurs. Next slice adds the lifecycle + filters `listSuggestions` to truly-open.
- **Dispatch half deferred to Phase I:** `instruction_*`/`orchestrator_action_*`/`action_denied`/`projection_rebuilt` are intentionally NOT added to the `EventType` union here.
- **No rule priority/suppression:** one subject may fire multiple distinct-key suggestions (by design for this slice).
