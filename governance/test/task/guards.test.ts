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
