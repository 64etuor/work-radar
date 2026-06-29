import { describe, it, expect } from "vitest";
import {
  TASK_TRANSITIONS,
  isValidTransition,
  assertValidTransition,
  transitionFor,
} from "../../src/task/fsm.js";
import { canStart, canBlock, canComplete, canCancel } from "../../src/task/guards.js";
import type { TaskPhase, TaskState } from "../../src/task/task.js";

const ALL: TaskPhase[] = ["ready", "active", "blocked", "done", "cancelled"];
// Mirror deriveTaskState: terminal phases always carry their verdict (guards short-circuit on it).
const st = (phase: TaskPhase): TaskState => ({
  taskId: "evt_t1",
  title: "t",
  phase,
  verdict: phase === "done" ? "done" : phase === "cancelled" ? "cancelled" : null,
});

describe("task FSM — explicit transition table", () => {
  it("terminal phases have no outgoing transitions", () => {
    expect(TASK_TRANSITIONS.done).toEqual([]);
    expect(TASK_TRANSITIONS.cancelled).toEqual([]);
  });

  it("encodes the lifecycle the design state machine describes", () => {
    expect(new Set(TASK_TRANSITIONS.ready)).toEqual(new Set(["active", "cancelled"]));
    expect(new Set(TASK_TRANSITIONS.active)).toEqual(new Set(["blocked", "done", "cancelled"]));
    expect(new Set(TASK_TRANSITIONS.blocked)).toEqual(new Set(["active", "cancelled"]));
  });

  it("isValidTransition agrees with the table", () => {
    expect(isValidTransition("ready", "active")).toBe(true);
    expect(isValidTransition("active", "done")).toBe(true);
    expect(isValidTransition("done", "active")).toBe(false);
    expect(isValidTransition("ready", "done")).toBe(false); // cannot skip active
  });

  it("assertValidTransition throws only on illegal transitions", () => {
    expect(() => assertValidTransition("active", "done")).not.toThrow();
    expect(() => assertValidTransition("done", "active")).toThrow(/illegal task transition/i);
  });

  // The drift-lock: the scattered can* guards and the explicit table MUST agree, so neither can
  // be edited without the other. transitionFor maps a guard's target phase to its event semantics.
  it("the table and the can* guards agree for every (from → to) pair", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const guardOk = guardAllows(from, to);
        const tableOk = isValidTransition(from, to);
        expect(
          guardOk,
          `guard(${from}→${to})=${guardOk} but table=${tableOk}`,
        ).toBe(tableOk);
      }
    }
  });
});

/** Run the guard that owns the from→to edge; null when no guard maps to that target. */
function guardAllows(from: TaskPhase, to: TaskPhase): boolean {
  const edge = transitionFor(to);
  if (!edge) return false;
  const s = st(from);
  switch (edge) {
    case "start":
      return canStart(s).ok;
    case "block":
      return canBlock(s).ok;
    case "complete":
      return canComplete(s, false).ok;
    case "cancel":
      return canCancel(s).ok;
  }
}
