import { describe, it, expect } from "vitest";
import { evaluateReadiness, type ReadinessInput } from "../../src/live/readiness.js";
import type { PreflightSignals } from "../../src/live/preflight.js";

// infra present + every live flag armed
const ARMED_SIGNALS: PreflightSignals = {
  env: {
    CMUX_SOCKET_PATH: "/tmp/cmux.sock",
    BOULE_CONDUCTOR_MODE: "live",
    BOULE_OBSERVER_MODE: "live",
    BOULE_AUTO_MODE: "type2",
  },
  cmuxBinaryOk: true,
  gitWorktreeOk: true,
};
const armed = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
  signals: ARMED_SIGNALS,
  stalledCount: 0,
  ...over,
});

describe("evaluateReadiness — unattended gate (all blockers must clear)", () => {
  it("ready=true when infra ready, all live flags armed, and no stalls", () => {
    const r = evaluateReadiness(armed());
    expect(r.ready).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });

  it("infra not ready ⇒ blocked", () => {
    const r = evaluateReadiness({
      ...armed(),
      signals: { ...ARMED_SIGNALS, cmuxBinaryOk: false },
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/preflight infra/i);
  });

  it("conductor not live ⇒ blocked (nothing would spawn)", () => {
    const r = evaluateReadiness({
      ...armed(),
      signals: { ...ARMED_SIGNALS, env: { ...ARMED_SIGNALS.env, BOULE_CONDUCTOR_MODE: "stub" } },
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/CONDUCTOR_MODE/);
  });

  it("observer not live ⇒ blocked (crash/stall would be invisible — the key unattended guard)", () => {
    const r = evaluateReadiness({
      ...armed(),
      signals: { ...ARMED_SIGNALS, env: { ...ARMED_SIGNALS.env, BOULE_OBSERVER_MODE: "" } },
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/OBSERVER_MODE/);
  });

  it("auto not type2 ⇒ blocked (no unattended advance)", () => {
    const r = evaluateReadiness({
      ...armed(),
      signals: { ...ARMED_SIGNALS, env: { ...ARMED_SIGNALS.env, BOULE_AUTO_MODE: "off" } },
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/AUTO_MODE/);
  });

  it("open stalls ⇒ blocked (resolve before piling on dispatch)", () => {
    const r = evaluateReadiness(armed({ stalledCount: 2 }));
    expect(r.ready).toBe(false);
    expect(r.blockers.join(" ")).toMatch(/2 stalled/);
  });

  it("reports ALL blockers at once (not just the first)", () => {
    const r = evaluateReadiness({
      signals: { env: {}, cmuxBinaryOk: false, gitWorktreeOk: false },
      stalledCount: 1,
    });
    expect(r.ready).toBe(false);
    expect(r.blockers.length).toBeGreaterThanOrEqual(4);
    expect(r.preflight.ready).toBe(false);
  });
});
