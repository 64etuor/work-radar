import { describe, it, expect } from "vitest";
import { computeContextPressure, type RuntimeSignals } from "../../src/steward/pressure.js";
import type { GovEvent } from "../../src/event/event.js";

const now = new Date(Date.UTC(2026, 5, 3, 14, 0, 0));
const idle: RuntimeSignals = { estimatedTokenRatio: 0, turnCount: 0, wallClockMs: 0, filesTouched: 0 };
const saturatedRt: RuntimeSignals = { estimatedTokenRatio: 1, turnCount: 200, wallClockMs: 7_200_000, filesTouched: 100 };

const ev = (id: string, type: GovEvent["frontmatter"]["type"], related?: string[]): GovEvent => ({
  frontmatter: { id, type, source: "agent_run", actor: "a", tags: [], related_to: related }, body: "",
});
// Maxed log: 5 unresolved decision_blocked + 5 in-flight tasks (started, not terminal) → BOTH
// event-derived components saturate (each normalizes /5). No handoff → lastHandoffAge maxed too.
const maxedLog: GovEvent[] = [
  ...Array.from({ length: 5 }, (_, i) => ev(`evt_db_${i}`, "decision_blocked", [`evt_dp_${i}`])),
  ...Array.from({ length: 5 }, (_, i) => ev(`evt_t_${i}`, "task_created")),
  ...Array.from({ length: 5 }, (_, i) => ev(`evt_ts_${i}`, "task_started", [`evt_t_${i}`])),
];

describe("computeContextPressure", () => {
  it("idle signals + empty log → low", () => {
    const r = computeContextPressure(idle, [], now);
    expect(r.level).toBe("low");
    expect(r.score).toBeLessThan(0.5);
  });
  it("fully saturated (runtime + maxed log) → critical, score 1.0", () => {
    const r = computeContextPressure(saturatedRt, maxedLog, now);
    expect(r.level).toBe("critical");
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });
  it("maxed runtime ALONE (empty log) is `high`, not `critical` (event-derived must corroborate)", () => {
    const r = computeContextPressure(saturatedRt, [], now);
    expect(r.level).toBe("high"); // by design: ~0.75 — see design §3
  });
  it("a recent handoff lowers the lastHandoffAge component", () => {
    const recent = ev("evt_20260603_135900_0001", "handoff_requested", ["evt_s1"]); // 1 min before `now`
    const withRecent = computeContextPressure(idle, [recent], now);
    const without = computeContextPressure(idle, [], now);
    expect(withRecent.components.lastHandoffAgeMs).toBeLessThan(without.components.lastHandoffAgeMs);
  });
  it("an open decision_blocked raises the unresolvedDecisions component", () => {
    const log: GovEvent[] = [
      { frontmatter: { id: "evt_dp", type: "decision_proposed", source: "agent_run", actor: "a", tags: [] }, body: "" },
      { frontmatter: { id: "evt_db", type: "decision_blocked", source: "agent_run", actor: "a", tags: [], related_to: ["evt_dp"] }, body: "" },
    ];
    const withBlock = computeContextPressure(idle, log, now);
    const without = computeContextPressure(idle, [], now);
    expect(withBlock.components.unresolvedDecisions).toBeGreaterThan(without.components.unresolvedDecisions);
  });
  it("emits nothing (pure) — returns a value only", () => {
    const r = computeContextPressure(idle, [], now);
    expect(Object.keys(r).sort()).toEqual(["components", "level", "score"]);
  });
});
