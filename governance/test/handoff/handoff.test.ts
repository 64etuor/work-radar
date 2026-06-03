import { describe, it, expect } from "vitest";
import { deriveHandoffState, handoffsOf, type HandoffPhase } from "../../src/handoff/handoff.js";
import type { GovEvent } from "../../src/event/event.js";

const ev = (id: string, type: GovEvent["frontmatter"]["type"], related?: string[]): GovEvent => ({
  frontmatter: { id, type, source: "system", actor: "system", tags: ["handoff"], related_to: related },
  body: "",
});
const birth = ev("evt_h1", "handoff_requested", ["evt_session_1"]);

describe("deriveHandoffState", () => {
  it("births at `requested`", () => {
    expect(deriveHandoffState(birth, []).phase).toBe<HandoffPhase>("requested");
    expect(deriveHandoffState(birth, []).sessionId).toBe("evt_session_1");
  });
  it("drafted → validating → pending → consumed (terminal wins)", () => {
    const related = [
      ev("evt_h1_a", "handoff_drafted", ["evt_h1"]),
      ev("evt_h1_b", "handoff_validated", ["evt_h1"]),
      ev("evt_h1_c", "handoff_consumed", ["evt_h1"]),
    ];
    const s = deriveHandoffState(birth, related);
    expect(s.phase).toBe<HandoffPhase>("consumed");
    expect(s.verdict).toBe("consumed");
  });
  it("invalid sends it back to `invalid`; latest substate by id wins", () => {
    const related = [
      ev("evt_h1_a", "handoff_drafted", ["evt_h1"]),
      ev("evt_h1_b", "handoff_invalid", ["evt_h1"]),
    ];
    expect(deriveHandoffState(birth, related).phase).toBe<HandoffPhase>("invalid");
  });
  it("ignores foreign event types (fail-closed)", () => {
    const related = [ev("evt_x", "task_completed", ["evt_h1"])];
    expect(deriveHandoffState(birth, related).phase).toBe<HandoffPhase>("requested");
  });
  it("handoffsOf returns births sorted, excludes re-reference", () => {
    const all = [birth, ev("evt_h0", "handoff_requested", ["evt_session_0"]), ev("evt_h1_a", "handoff_drafted", ["evt_h1"])];
    expect(handoffsOf(all).map((e) => e.frontmatter.id)).toEqual(["evt_h0", "evt_h1"]);
  });
});
