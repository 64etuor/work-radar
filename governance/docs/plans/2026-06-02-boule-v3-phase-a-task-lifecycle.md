# Boule v3 Phase A — Task Lifecycle SSOT Implementation Plan

> **Status:** ✅ DONE (2026-06-02) — commits `f4e7a3c..83aa965`, opus critic ACCEPT, vitest 214. 완료 정본: [INDEX](../INDEX.md) + `docs/decisions.md`.
>
> 체크박스 = 빌드 시점 기록(사람용). 런타임 task 상태는 이벤트 파생(오케스트레이터 정본) — `governance/workspace/HARNESS.md` §3.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Task a first-class, event-sourced execution-plane object with a lifecycle state machine derived purely from L0 events — observable by the (future) orchestrator, with status that is never hand-edited.

**Architecture:** Mirror the proven `src/decision/` module exactly. Lifecycle transitions are append-only L0 events (`task_started`/`task_blocked`/`task_completed`/`task_cancelled`); `deriveTaskState` is a pure fold (clone of `deriveDecisionState`); guards are refusal functions (clone of `guardian.ts`); a pure projector renders `state/tasks.json`. No Postgres, no UI, no orchestrator dispatch. MCP stdio only → no `bindings.ts` change.

**Tech Stack:** TypeScript (Node 24 `--experimental-strip-types`, runtime src imports use `.ts`; test imports use `.js`), vitest, gray-matter. Same toolchain as `governance/src/decision/`.

> **Two tracking mechanisms — do not conflate (the user's question):**
> **(1) THIS plan's checkboxes = human/build tracking.** You tick them as you implement.
> **(2) The runtime Task state machine = the orchestrator's truth.** It reads *events → derived state*, never these checkboxes. Each task below names its **Orchestrator-observable done-criterion** = the event/evidence that makes completion machine-visible. Tick the checkbox only when that evidence is real (test green / event written).

---

## File Structure

New module `governance/src/task/` (mirrors `src/decision/`):

- `src/task/task.ts` — `deriveTaskState` pure fold + `TaskState`/`TaskPhase` types + `tasksOf` helper.
- `src/task/guards.ts` — `canStart`/`canComplete`/`canCancel` refusal functions (clone of `guardian.ts`). `canComplete` carries the INVARIANT-#1 open-block coupling.
- `src/task/handlers.ts` — write commands (`startTask`/`blockTask`/`completeTask`/`cancelTask`) + read commands (`listTasks`/`taskTrail`). Reuses `readEvents.ts` + `writeEvent.ts`.
- `src/task/project.ts` — pure `projectTasks(events)` + `renderTasks(workspaceDir)` (writes `state/tasks.json`).

Modified:
- `src/event/event.ts:3` — add 4 lifecycle event types to the `EventType` union.
- `src/mcp/server.ts` — register 6 new tools.
- `governance/.gitignore` — ignore the derived `state/*.json` projection.

Reused unchanged: `src/decision/readEvents.ts` (`readAllEvents`, `eventsForDecision`), `src/event/{id,writeEvent}.ts`, `src/decision/decision.ts` (`deriveDecisionState`, for the open-block check). `create_task` already exists (`src/mcp/handlers.ts createTask`) — a task's id is its `task_created` event id; we add only the lifecycle + read commands.

Tests (mirror `test/decision/`): `test/task/{task,guards,handlers,project}.test.ts`.

---

### Task 1: Add task lifecycle event types

**Files:**
- Modify: `governance/src/event/event.ts:3-16` (the `EventType` union)

**Orchestrator-observable done-criterion:** the four lifecycle event types exist in the union so they can be written/read by the fold.

- [x] **Step 1: Add the four lifecycle types to the union**

In `src/event/event.ts`, the `EventType` union currently ends with `| "task_created";`. Replace that final line with:

```ts
  | "task_created"
  | "task_started"      // v3 Phase A: task ready/blocked → active
  | "task_blocked"      // v3 Phase A: task active → blocked (carries reason)
  | "task_completed"    // v3 Phase A: task active → done (guarded: no open decision_blocked)
  | "task_cancelled";   // v3 Phase A: task → cancelled (terminal)
```

- [x] **Step 2: Typecheck**

Run: `pnpm --dir governance exec tsc --noEmit`
Expected: exits 0 (no output).

- [x] **Step 3: Commit**

```bash
git add governance/src/event/event.ts
git commit -m "feat(governance): add task lifecycle event types (Phase A)"
```

---

### Task 2: `deriveTaskState` pure fold

**Files:**
- Create: `governance/src/task/task.ts`
- Test: `governance/test/task/task.test.ts`

**Orchestrator-observable done-criterion:** `deriveTaskState(created, related)` returns `phase` ∈ {ready, active, blocked, done, cancelled}, derived purely from events; the orchestrator reads this, not a checkbox.

- [x] **Step 1: Write the failing test**

Create `test/task/task.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { deriveTaskState, tasksOf } from "../../src/task/task.js";
import type { GovEvent, EventType } from "../../src/event/event.js";

let seq = 0;
function evt(type: EventType, id: string, relatedTo?: string[], body = "Title line\n\nrest"): GovEvent {
  return { frontmatter: { id, type, source: "hermes", actor: "user", tags: ["task"], related_to: relatedTo }, body };
}
const created = evt("task_created", "evt_t1", undefined, "Build the thing\n\ndetails");

describe("deriveTaskState", () => {
  it("a bare task_created is ready", () => {
    expect(deriveTaskState(created, []).phase).toBe("ready");
  });
  it("title is the first body line", () => {
    expect(deriveTaskState(created, []).title).toBe("Build the thing");
  });
  it("task_started → active", () => {
    expect(deriveTaskState(created, [evt("task_started", "evt_a2", ["evt_t1"])]).phase).toBe("active");
  });
  it("latest of started/blocked wins (block after start → blocked)", () => {
    const r = [evt("task_started", "evt_a2", ["evt_t1"]), evt("task_blocked", "evt_a3", ["evt_t1"])];
    expect(deriveTaskState(created, r).phase).toBe("blocked");
  });
  it("re-start after block → active (unblock)", () => {
    const r = [evt("task_started", "evt_a2", ["evt_t1"]), evt("task_blocked", "evt_a3", ["evt_t1"]), evt("task_started", "evt_a4", ["evt_t1"])];
    expect(deriveTaskState(created, r).phase).toBe("active");
  });
  it("task_completed → done (terminal, verdict set)", () => {
    const s = deriveTaskState(created, [evt("task_started", "evt_a2", ["evt_t1"]), evt("task_completed", "evt_a5", ["evt_t1"])]);
    expect(s.phase).toBe("done"); expect(s.verdict).toBe("done");
  });
  it("task_cancelled wins over completed (cancel precedence)", () => {
    const s = deriveTaskState(created, [evt("task_completed", "evt_a5", ["evt_t1"]), evt("task_cancelled", "evt_a6", ["evt_t1"])]);
    expect(s.phase).toBe("cancelled");
  });
  it("tasksOf filters task_created only, chronological", () => {
    const all = [evt("task_created", "evt_t2"), created, evt("task_started", "evt_a2", ["evt_t1"])];
    expect(tasksOf(all).map((e) => e.frontmatter.id)).toEqual(["evt_t1", "evt_t2"]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir governance exec vitest run test/task/task.test.ts`
Expected: FAIL — cannot find module `../../src/task/task.js`.

- [x] **Step 3: Write `src/task/task.ts`**

```ts
import type { GovEvent } from "../event/event.ts";

export type TaskPhase = "ready" | "active" | "blocked" | "done" | "cancelled";

export interface TaskState {
  taskId: string;
  title: string;
  phase: TaskPhase;
  verdict: "done" | "cancelled" | null; // terminal marker (mirrors DecisionState.verdict)
}

/** Pure fold: a task_created event + its related lifecycle events → phase.
 *  `related` = events whose related_to includes the task id (any order).
 *  Precedence: cancelled > done; otherwise the LATEST started/blocked transition wins
 *  (event ids are chronological — generateId stamps UTC time). */
export function deriveTaskState(created: GovEvent, related: GovEvent[]): TaskState {
  const taskId = created.frontmatter.id;
  const title = created.body.split("\n", 1)[0]?.trim() || taskId;
  const cancelled = related.some((e) => e.frontmatter.type === "task_cancelled");
  const done = related.some((e) => e.frontmatter.type === "task_completed");

  let phase: TaskPhase;
  let verdict: TaskState["verdict"];
  if (cancelled) {
    phase = "cancelled";
    verdict = "cancelled";
  } else if (done) {
    phase = "done";
    verdict = "done";
  } else {
    let latest: GovEvent | null = null;
    for (const e of related) {
      if (e.frontmatter.type !== "task_started" && e.frontmatter.type !== "task_blocked") continue;
      if (!latest || e.frontmatter.id.localeCompare(latest.frontmatter.id) > 0) latest = e;
    }
    phase = !latest ? "ready" : latest.frontmatter.type === "task_blocked" ? "blocked" : "active";
    verdict = null;
  }
  return { taskId, title, phase, verdict };
}

/** All task_created events (chronological by id). */
export function tasksOf(all: GovEvent[]): GovEvent[] {
  return all
    .filter((e) => e.frontmatter.type === "task_created")
    .sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir governance exec vitest run test/task/task.test.ts`
Expected: PASS (8 tests).

- [x] **Step 5: Commit**

```bash
git add governance/src/task/task.ts governance/test/task/task.test.ts
git commit -m "feat(governance): deriveTaskState pure fold (Phase A)"
```

---

### Task 3: Lifecycle guards (incl. INVARIANT-#1 open-block coupling)

**Files:**
- Create: `governance/src/task/guards.ts`
- Test: `governance/test/task/guards.test.ts`

**Orchestrator-observable done-criterion:** `canComplete` returns `{ok:false}` when a task sits on an open `decision_blocked` — the structural guarantee that a task cannot be "done" over an unanswered Type-0 fork.

- [x] **Step 1: Write the failing test**

Create `test/task/guards.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { canStart, canComplete, canCancel } from "../../src/task/guards.js";
import type { TaskState } from "../../src/task/task.js";

const st = (phase: TaskState["phase"], verdict: TaskState["verdict"] = null): TaskState =>
  ({ taskId: "evt_t1", title: "t", phase, verdict });

describe("task guards", () => {
  it("canStart: ready → ok", () => expect(canStart(st("ready")).ok).toBe(true));
  it("canStart: blocked → ok (unblock)", () => expect(canStart(st("blocked")).ok).toBe(true));
  it("canStart: active → refused", () => expect(canStart(st("active")).ok).toBe(false));
  it("canStart: done → refused", () => expect(canStart(st("done", "done")).ok).toBe(false));

  it("canComplete: active + no open block → ok", () => expect(canComplete(st("active"), false).ok).toBe(true));
  it("canComplete: active + OPEN block → REFUSED (INVARIANT #1)", () => {
    const g = canComplete(st("active"), true);
    expect(g.ok).toBe(false);
    expect(g.reason).toMatch(/decision_blocked|escalation/i);
  });
  it("canComplete: ready → refused (must be active)", () => expect(canComplete(st("ready"), false).ok).toBe(false));

  it("canCancel: active → ok", () => expect(canCancel(st("active")).ok).toBe(true));
  it("canCancel: done → refused (terminal)", () => expect(canCancel(st("done", "done")).ok).toBe(false));
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir governance exec vitest run test/task/guards.test.ts`
Expected: FAIL — cannot find module `../../src/task/guards.js`.

- [x] **Step 3: Write `src/task/guards.ts`**

```ts
import type { TaskState } from "./task.ts";

export interface TaskGate { ok: boolean; reason: string; }

/** Start is allowed from ready or blocked (the latter = unblock). */
export function canStart(s: TaskState): TaskGate {
  if (s.verdict) return { ok: false, reason: `task already ${s.verdict}` };
  if (s.phase === "active") return { ok: false, reason: "task already active" };
  return { ok: true, reason: s.phase === "blocked" ? "unblocking" : "starting" };
}

/** A task may complete ONLY from active AND with no unresolved decision_blocked in its
 *  chain. The open-block clause is the structural INVARIANT #1 coupling: a task cannot be
 *  marked done while it sits on an unanswered Type-0 fork. `hasOpenBlock` is computed by the
 *  handler (I/O); this guard stays pure. */
export function canComplete(s: TaskState, hasOpenBlock: boolean): TaskGate {
  if (s.verdict) return { ok: false, reason: `task already ${s.verdict}` };
  if (s.phase !== "active") return { ok: false, reason: `task must be active to complete (is ${s.phase})` };
  if (hasOpenBlock) return { ok: false, reason: "task has an unresolved decision_blocked; resolve the escalation first" };
  return { ok: true, reason: "completing" };
}

/** Cancel is allowed at any non-terminal phase. */
export function canCancel(s: TaskState): TaskGate {
  if (s.verdict) return { ok: false, reason: `task already ${s.verdict}` };
  return { ok: true, reason: "cancelling" };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir governance exec vitest run test/task/guards.test.ts`
Expected: PASS (9 tests).

- [x] **Step 5: Commit**

```bash
git add governance/src/task/guards.ts governance/test/task/guards.test.ts
git commit -m "feat(governance): task lifecycle guards + open-block coupling (Phase A)"
```

---

### Task 4: Write + read handlers (with negative + open-block integration tests)

**Files:**
- Create: `governance/src/task/handlers.ts`
- Test: `governance/test/task/handlers.test.ts`

**Orchestrator-observable done-criterion:** each command writes exactly one immutable lifecycle event with `related_to:[taskId]` and **no `decision_*` event**; `complete_task` is refused (writes nothing) while a related `decision_blocked` is unresolved.

- [x] **Step 1: Write the failing test**

Create `test/task/handlers.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask } from "../../src/mcp/handlers.js";
import { startTask, blockTask, completeTask, cancelTask, listTasks, taskTrail } from "../../src/task/handlers.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));
const rand = () => (n++ % 16) / 16;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-task-")); n = 0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("task handlers", () => {
  it("create → start → complete writes 3 immutable events; trail shows ready→active→done", async () => {
    const { id } = await createTask(dir, { description: "Build the thing" }, at(0), 0.1);
    expect((await startTask(dir, { taskId: id }, at(1), 0.2)).ok).toBe(true);
    expect((await completeTask(dir, { taskId: id }, at(2), 0.3)).ok).toBe(true);
    const trail = await taskTrail(dir, { taskId: id });
    expect(trail.phase).toBe("done");
    expect(trail.chain.map((c) => c.type)).toEqual(["task_created", "task_started", "task_completed"]);
  });

  it("NEGATIVE: task commands write ZERO decision_* events", async () => {
    const { id } = await createTask(dir, { description: "t" }, at(0), 0.1);
    await startTask(dir, { taskId: id }, at(1), 0.2);
    await blockTask(dir, { taskId: id, reason: "waiting" }, at(2), 0.3);
    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type.startsWith("decision_"))).toBe(false);
  });

  it("INVARIANT #1: complete is REFUSED while a related decision_blocked is unresolved, and writes nothing", async () => {
    const { id } = await createTask(dir, { description: "t" }, at(0), 0.1);
    await startTask(dir, { taskId: id }, at(1), 0.2);
    // a proposal + a block referencing BOTH the decision and the task, with no verdict
    await writeEvent(dir, { frontmatter: { id: "evt_decX", type: "decision_proposed", source: "hermes", actor: "user", tags: ["decision"] }, body: "Fork?" }, at(2));
    await writeEvent(dir, { frontmatter: { id: "evt_blkX", type: "decision_blocked", source: "agent_run", actor: "session:1", tags: ["type0"], related_to: ["evt_decX", id] }, body: '{"question":"q","options":[]}' }, at(3));
    const r = await completeTask(dir, { taskId: id }, at(4), 0.4);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/decision_blocked|escalation/i);
    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type === "task_completed")).toBe(false); // gate held
  });

  it("listTasks omits terminal tasks", async () => {
    const a = await createTask(dir, { description: "alive" }, at(0), 0.1);
    const b = await createTask(dir, { description: "gone" }, at(1), 0.2);
    await cancelTask(dir, { taskId: b.id }, at(2), 0.3);
    const open = await listTasks(dir);
    expect(open.map((t) => t.taskId)).toEqual([a.id]);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir governance exec vitest run test/task/handlers.test.ts`
Expected: FAIL — cannot find module `../../src/task/handlers.js`.

- [x] **Step 3: Write `src/task/handlers.ts`**

```ts
import { generateId } from "../event/id.ts";
import { writeEvent } from "../event/writeEvent.ts";
import type { GovEvent, EventType } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveDecisionState } from "../decision/decision.ts";
import { deriveTaskState, tasksOf, type TaskState } from "./task.ts";
import { canStart, canComplete, canCancel } from "./guards.ts";

export interface TaskGateResult { ok: boolean; reason: string; eventId?: string; }

async function loadTask(workspaceDir: string, taskId: string): Promise<{ state: TaskState; all: GovEvent[] }> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, taskId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "task_created")
    throw new Error(`unknown task: ${taskId}`);
  return { state: deriveTaskState(grp.proposal, grp.related), all };
}

async function writeLifecycle(
  workspaceDir: string, type: EventType, taskId: string, body: string, now: Date, rand: number,
): Promise<string> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", now, rand),
      type, source: "hermes", actor: "user",
      tags: ["task"], related_to: [taskId],
    },
    body,
  };
  await writeEvent(workspaceDir, evt, now);
  return evt.frontmatter.id;
}

/** True if a decision_blocked related to this task escalates a decision with NO verdict yet.
 *  Conservative: a block whose decision proposal cannot be found counts as open. */
function hasOpenBlock(all: GovEvent[], taskId: string): boolean {
  const blocks = all.filter(
    (e) => e.frontmatter.type === "decision_blocked" && (e.frontmatter.related_to ?? []).includes(taskId),
  );
  for (const b of blocks) {
    const relatedIds = b.frontmatter.related_to ?? [];
    const decId = relatedIds.find((rid) => {
      const p = all.find((e) => e.frontmatter.id === rid);
      return p?.frontmatter.type === "decision_proposed";
    });
    if (!decId) return true; // cannot prove resolved → conservative
    const grp = eventsForDecision(all, decId);
    if (grp.proposal && !deriveDecisionState(grp.proposal, grp.related).verdict) return true;
  }
  return false;
}

/** start_task — ready/blocked → active. */
export async function startTask(workspaceDir: string, input: { taskId: string }, now: Date, rand: number): Promise<TaskGateResult> {
  const { state } = await loadTask(workspaceDir, input.taskId);
  const gate = canStart(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "task_started", input.taskId, `Started ${input.taskId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

/** block_task — active → blocked (records reason). */
export async function blockTask(workspaceDir: string, input: { taskId: string; reason: string }, now: Date, rand: number): Promise<TaskGateResult> {
  const { state } = await loadTask(workspaceDir, input.taskId);
  if (state.verdict) return { ok: false, reason: `task already ${state.verdict}` };
  const eventId = await writeLifecycle(workspaceDir, "task_blocked", input.taskId, `Blocked ${input.taskId}: ${input.reason}`, now, rand);
  return { ok: true, reason: "blocked", eventId };
}

/** complete_task — active → done. Guarded by canComplete (incl. open-block coupling). */
export async function completeTask(workspaceDir: string, input: { taskId: string }, now: Date, rand: number): Promise<TaskGateResult> {
  const { state, all } = await loadTask(workspaceDir, input.taskId);
  const gate = canComplete(state, hasOpenBlock(all, input.taskId));
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "task_completed", input.taskId, `Completed ${input.taskId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

/** cancel_task — any non-terminal → cancelled. */
export async function cancelTask(workspaceDir: string, input: { taskId: string }, now: Date, rand: number): Promise<TaskGateResult> {
  const { state } = await loadTask(workspaceDir, input.taskId);
  const gate = canCancel(state);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const eventId = await writeLifecycle(workspaceDir, "task_cancelled", input.taskId, `Cancelled ${input.taskId}`, now, rand);
  return { ok: true, reason: gate.reason, eventId };
}

export interface TaskSummary { taskId: string; title: string; phase: TaskState["phase"]; }

/** tasks — non-terminal tasks (clone of conflicts). */
export async function listTasks(workspaceDir: string): Promise<TaskSummary[]> {
  const all = await readAllEvents(workspaceDir);
  const out: TaskSummary[] = [];
  for (const t of tasksOf(all)) {
    const grp = eventsForDecision(all, t.frontmatter.id);
    const s = deriveTaskState(grp.proposal!, grp.related);
    if (s.phase !== "done" && s.phase !== "cancelled") out.push({ taskId: s.taskId, title: s.title, phase: s.phase });
  }
  return out;
}

export interface TaskTrailEntry { id: string; type: GovEvent["frontmatter"]["type"]; actor: string; summary: string; }
export interface TaskTrail { taskId: string; title: string; phase: TaskState["phase"]; chain: TaskTrailEntry[]; }

/** task <id> — full chronological trail (clone of why). */
export async function taskTrail(workspaceDir: string, input: { taskId: string }): Promise<TaskTrail> {
  const all = await readAllEvents(workspaceDir);
  const grp = eventsForDecision(all, input.taskId);
  if (!grp.proposal || grp.proposal.frontmatter.type !== "task_created") throw new Error(`unknown task: ${input.taskId}`);
  const s = deriveTaskState(grp.proposal, grp.related);
  const chain: TaskTrailEntry[] = [grp.proposal, ...grp.related].map((e) => ({
    id: e.frontmatter.id, type: e.frontmatter.type, actor: e.frontmatter.actor,
    summary: e.body.split("\n", 1)[0] ?? "",
  }));
  return { taskId: s.taskId, title: s.title, phase: s.phase, chain };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir governance exec vitest run test/task/handlers.test.ts`
Expected: PASS (4 tests). The INVARIANT-#1 test proves `complete_task` is refused and writes no `task_completed`.

- [x] **Step 5: Commit**

```bash
git add governance/src/task/handlers.ts governance/test/task/handlers.test.ts
git commit -m "feat(governance): task lifecycle handlers + open-block refusal (Phase A)"
```

---

### Task 5: Pure projector + keystone property test

**Files:**
- Create: `governance/src/task/project.ts`
- Test: `governance/test/task/project.test.ts`
- Modify: `governance/.gitignore`

**Orchestrator-observable done-criterion:** wiping `state/` and re-running `renderTasks` reproduces a byte-identical `state/tasks.json` — proving the projection is a pure function of the event log (derived, never authored).

- [x] **Step 1: Write the failing test**

Create `test/task/project.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTask } from "../../src/mcp/handlers.js";
import { startTask, blockTask, completeTask } from "../../src/task/handlers.js";
import { projectTasks, renderTasks } from "../../src/task/project.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
let n = 0;
const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));
const rand = () => (n++ % 16) / 16;

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-proj-")); n = 0; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function seed() {
  const a = await createTask(dir, { description: "alpha" }, at(0), 0.1);
  await startTask(dir, { taskId: a.id }, at(1), 0.2);
  const b = await createTask(dir, { description: "beta" }, at(2), 0.3);
  await startTask(dir, { taskId: b.id }, at(3), 0.4);
  await blockTask(dir, { taskId: b.id, reason: "x" }, at(4), 0.5);
  return { a, b };
}

describe("task projector", () => {
  it("projectTasks is pure: no I/O, emits no events, stable across calls", async () => {
    await seed();
    const all = await readAllEvents(dir);
    const before = all.length;
    const r1 = projectTasks(all);
    const r2 = projectTasks(all);
    expect(r1).toEqual(r2);
    expect((await readAllEvents(dir)).length).toBe(before); // projecting wrote nothing
  });

  it("KEYSTONE: wipe state/ and re-render → byte-identical (projection = f(events))", async () => {
    await seed();
    const p = await renderTasks(dir);
    const first = await readFile(p, "utf8");
    await rm(join(dir, "state"), { recursive: true, force: true });
    const p2 = await renderTasks(dir);
    const second = await readFile(p2, "utf8");
    expect(second).toBe(first);
  });

  it("projection reflects derived phases", async () => {
    const { a, b } = await seed();
    await completeTask(dir, { taskId: a.id }, at(5), 0.6);
    const states = projectTasks(await readAllEvents(dir));
    const byId = Object.fromEntries(states.map((s) => [s.taskId, s.phase]));
    expect(byId[a.id]).toBe("done");
    expect(byId[b.id]).toBe("blocked");
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --dir governance exec vitest run test/task/project.test.ts`
Expected: FAIL — cannot find module `../../src/task/project.js`.

- [x] **Step 3: Write `src/task/project.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GovEvent } from "../event/event.ts";
import { readAllEvents, eventsForDecision } from "../decision/readEvents.ts";
import { deriveTaskState, tasksOf, type TaskState } from "./task.ts";

/** PURE: events → task states (sorted by task id via tasksOf). No I/O, emits no events. */
export function projectTasks(all: GovEvent[]): TaskState[] {
  return tasksOf(all).map((t) => {
    const grp = eventsForDecision(all, t.frontmatter.id);
    return deriveTaskState(grp.proposal!, grp.related);
  });
}

/** Render the derived projection to state/tasks.json. Overwrites; fully rebuildable from
 *  events. Deterministic field + element order → byte-stable output. This is the ONLY writer
 *  of task status; no command/agent/human edits status directly (HARNESS keystone invariant). */
export async function renderTasks(workspaceDir: string): Promise<string> {
  const states = projectTasks(await readAllEvents(workspaceDir));
  const stateDir = join(workspaceDir, "state");
  await mkdir(stateDir, { recursive: true });
  const path = join(stateDir, "tasks.json");
  const rows = states.map((s) => ({ taskId: s.taskId, title: s.title, phase: s.phase }));
  await writeFile(path, JSON.stringify(rows, null, 2) + "\n");
  return path;
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --dir governance exec vitest run test/task/project.test.ts`
Expected: PASS (3 tests).

- [x] **Step 5: Gitignore the derived projection**

In `governance/.gitignore`, add below the existing derived-dirs block:

```
# Derived task projection (rebuildable from events via renderTasks)
workspace/state/*.json
```

- [x] **Step 6: Commit**

```bash
git add governance/src/task/project.ts governance/test/task/project.test.ts governance/.gitignore
git commit -m "feat(governance): pure task projector + keystone property test (Phase A)"
```

---

### Task 6: Wire the MCP command surface

**Files:**
- Modify: `governance/src/mcp/server.ts` (imports near line 10 + new `registerTool` blocks after the existing `create_task` block ~line 74)

**Orchestrator-observable done-criterion:** a headless MCP round-trip drives `create_task → start_task → complete_task` and `task`/`tasks` reflect the derived phase — the surface the orchestrator (Phase E) will call.

- [x] **Step 1: Add imports**

In `src/mcp/server.ts`, after the existing `import { createTask, status, observations } from "./handlers.ts";` (line 10), add:

```ts
import { startTask, blockTask, completeTask, cancelTask, listTasks, taskTrail } from "../task/handlers.ts";
```

- [x] **Step 2: Register the six tools**

Immediately after the existing `create_task` `registerTool(...)` block (ends ~line 74), insert:

```ts
server.registerTool(
  "start_task",
  { description: "task를 active로 전이 (ready/blocked→active)", inputSchema: { taskId: z.string() } },
  async ({ taskId }) => {
    const r = await startTask(WORKSPACE, { taskId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `started: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "block_task",
  { description: "task를 blocked로 전이 (사유 기록)", inputSchema: { taskId: z.string(), reason: z.string() } },
  async ({ taskId, reason }) => {
    const r = await blockTask(WORKSPACE, { taskId, reason }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `blocked: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "complete_task",
  { description: "task를 done으로 전이 (미해소 decision_blocked 있으면 거부)", inputSchema: { taskId: z.string() } },
  async ({ taskId }) => {
    const r = await completeTask(WORKSPACE, { taskId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `completed: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "cancel_task",
  { description: "task를 cancelled로 전이 (terminal)", inputSchema: { taskId: z.string() } },
  async ({ taskId }) => {
    const r = await cancelTask(WORKSPACE, { taskId }, nowFn(), randFn());
    return { content: [{ type: "text", text: r.ok ? `cancelled: ${r.eventId}` : `REFUSED: ${r.reason}` }] };
  },
);

server.registerTool(
  "tasks",
  { description: "비종료(non-terminal) task 목록", inputSchema: {} },
  async () => {
    const list = await listTasks(WORKSPACE);
    const text = list.length ? list.map((t) => `${t.taskId} [${t.phase}] ${t.title}`).join("\n") : "(no open tasks)";
    return { content: [{ type: "text", text }] };
  },
);

server.registerTool(
  "task",
  { description: "task 상태 + audit chain", inputSchema: { taskId: z.string() } },
  async ({ taskId }) => {
    const t = await taskTrail(WORKSPACE, { taskId });
    const chain = t.chain.map((c) => `  ${c.type} (${c.actor})`).join("\n");
    return { content: [{ type: "text", text: `${t.taskId} [${t.phase}] ${t.title}\n${chain}` }] };
  },
);
```

- [x] **Step 3: Typecheck + full test suite (no regressions)**

Run: `pnpm --dir governance exec tsc --noEmit && pnpm --dir governance test`
Expected: tsc 0; vitest all green (prior suite + new task tests).

- [x] **Step 4: Headless MCP round-trip smoke**

Run (drives the real stdio server end-to-end via the one-shot client used by the bridge):

```bash
cd governance
node bridge/boule-mcp.mjs create_task '{"description":"smoke task"}'
# copy the returned task id (evt_...), then:
node bridge/boule-mcp.mjs start_task '{"taskId":"<id>"}'
node bridge/boule-mcp.mjs complete_task '{"taskId":"<id>"}'
node bridge/boule-mcp.mjs task '{"taskId":"<id>"}'
```

Expected: `task` prints phase `[done]` with chain `task_created → task_started → task_completed`.
(If `bridge/boule-mcp.mjs` arg-passing differs, fall back to an inline `@modelcontextprotocol/sdk` Client over `StdioClientTransport` spawning `node --experimental-strip-types src/mcp/server.ts` — same handshake the P1/P2a smokes used.)
Then clean the smoke events: `git status` shows only gitignored `workspace/events/**` additions (no tracked changes).

- [x] **Step 5: Commit**

```bash
git add governance/src/mcp/server.ts
git commit -m "feat(governance): register task lifecycle MCP commands (Phase A)"
```

---

### Task 7: Integration verification + done-criteria evidence + breadcrumb

**Files:**
- Modify: `docs/decisions.md` (append one Phase-A breadcrumb line)

**Orchestrator-observable done-criterion:** all Phase-A done-criteria from the design (§7.5) are green with observed evidence; no `bindings.ts` drift; app/Rust/migrations untouched.

- [x] **Step 1: Run the full governance suite + typecheck**

Run: `pnpm --dir governance test && pnpm --dir governance exec tsc --noEmit`
Expected: all vitest green (record the count), tsc 0.

- [x] **Step 2: Confirm no work-radar app surface changed (INVARIANT #4/#6)**

Run: `git diff --stat origin/dev -- src/bindings.ts src-tauri/ src/`
Expected: empty (governance is outside the Tauri build graph; MCP is stdio, not Tauri IPC).

- [x] **Step 3: Verify the five design done-criteria (§7.5) with evidence**

Confirm each, citing the test that proves it:
- (1) create→start→complete = 3 events, phases advance → `handlers.test.ts` "create → start → complete".
- (2) complete refused on open `decision_blocked`, writes nothing → `handlers.test.ts` "INVARIANT #1".
- (3) wipe `state/`, re-render byte-identical → `project.test.ts` "KEYSTONE".
- (4) task commands write no `decision_*` → `handlers.test.ts` "NEGATIVE".
- (5) vitest green; no Postgres; no `bindings.ts` change → Steps 1–2.

- [x] **Step 4: Append the decisions.md breadcrumb**

Add one line (Type 2 Phase log) to `docs/decisions.md`, citing this plan and the evidence (vitest count, the 4 keystone/negative/invariant tests, bindings drift 0). Follow the existing entry style.

- [x] **Step 5: Commit**

```bash
git add docs/decisions.md
git commit -m "docs(governance): Phase A task lifecycle done-criteria + breadcrumb"
```

---

## Self-Review

- **Spec coverage (design §7):** event types (T1), `deriveTaskState` fold + state machine (T2), guards incl. open-block coupling (T3), MCP commands + write/read handlers (T4, T6), pure projector + keystone property test (T5), all five done-criteria §7.5 (T7). Covered.
- **Append-only / propose-only:** all writes are immutable `writeEvent` calls; no command writes a `decision_*` (negative test T4); projector is pure and emits nothing (T5).
- **Type consistency:** `TaskState`/`TaskPhase` defined in T2 and used identically in guards (T3), handlers (T4), projector (T5); `TaskGateResult` shape consistent across handlers; `eventsForDecision`/`readAllEvents`/`writeEvent`/`generateId` reused with their real signatures (verified against source).
- **No placeholders:** every step has runnable code/commands and expected output.
- **Out of scope (correctly deferred):** no Plan/Session/Spec lifecycle, no orchestrator dispatch, no Postgres, no UI, no `bindings.ts` — those are Phases B+.
