import { describe, it, expect } from "vitest";
import { evaluateReadiness } from "../../src/live/readiness.ts";

const baseSignals = (env: Record<string, string | undefined>) => ({
  env,
  cmuxBinaryOk: true,
  gitWorktreeOk: true,
});

describe("evaluateReadiness gates", () => {
  it("all gates pass when fully armed and no stalls", () => {
    const r = evaluateReadiness({
      signals: baseSignals({
        CMUX_SOCKET_PATH: "/tmp/cmux.sock",
        BOULE_CONDUCTOR_MODE: "live",
        BOULE_OBSERVER_MODE: "live",
        BOULE_AUTO_MODE: "type2",
      }),
      stalledCount: 0,
    });
    expect(r.ready).toBe(true);
    expect(r.gates).toEqual({ preflight: true, conductor: true, observer: true, auto: true, stall: true });
  });

  it("gates fail granularly for an un-armed posture with a stall", () => {
    const r = evaluateReadiness({
      signals: baseSignals({ CMUX_SOCKET_PATH: "/tmp/cmux.sock" }),
      stalledCount: 2,
    });
    expect(r.ready).toBe(false);
    expect(r.gates).toEqual({ preflight: true, conductor: false, observer: false, auto: false, stall: false });
  });
});
