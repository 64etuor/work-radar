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
