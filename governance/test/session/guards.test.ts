import { describe, it, expect } from "vitest";
import {
  canRecover,
  canWait,
  canBlock,
  canHandoffReady,
  canPressure,
  canCheckpoint,
  canRequestClose,
  canClose,
} from "../../src/session/guards.js";
import type { SessionState, SessionPhase } from "../../src/session/session.js";

function st(phase: SessionPhase): SessionState {
  return {
    sessionId: "evt_s1",
    surface: "7",
    ownership: "user_owned",
    taskId: null,
    phase,
    verdict: phase === "closed" ? "closed" : null,
  };
}

describe("canRecover", () => {
  it("ok only from crashed", () => expect(canRecover(st("crashed")).ok).toBe(true));
  it("refuses active", () => expect(canRecover(st("active")).ok).toBe(false));
  it("refuses closed", () => expect(canRecover(st("closed")).ok).toBe(false));
});

describe("canWait / canBlock / canHandoffReady (non-terminal)", () => {
  it("ok from active", () => {
    expect(canWait(st("active")).ok).toBe(true);
    expect(canBlock(st("active")).ok).toBe(true);
    expect(canHandoffReady(st("active")).ok).toBe(true);
  });
  it("refuse closed", () => {
    expect(canWait(st("closed")).ok).toBe(false);
    expect(canBlock(st("closed")).ok).toBe(false);
    expect(canHandoffReady(st("closed")).ok).toBe(false);
  });
});

describe("canPressure / canCheckpoint (refuse terminal AND crashed)", () => {
  it("ok from active", () => {
    expect(canPressure(st("active")).ok).toBe(true);
    expect(canCheckpoint(st("active")).ok).toBe(true);
  });
  it("refuse crashed", () => {
    expect(canPressure(st("crashed")).ok).toBe(false);
    expect(canCheckpoint(st("crashed")).ok).toBe(false);
  });
  it("refuse closed", () => {
    expect(canPressure(st("closed")).ok).toBe(false);
    expect(canCheckpoint(st("closed")).ok).toBe(false);
  });
});

describe("canRequestClose / canClose", () => {
  it("canRequestClose ok non-terminal, refuse closed", () => {
    expect(canRequestClose(st("active")).ok).toBe(true);
    expect(canRequestClose(st("closed")).ok).toBe(false);
  });
  it("canClose ok ONLY from closing", () => {
    expect(canClose(st("closing")).ok).toBe(true);
    expect(canClose(st("active")).ok).toBe(false);
    expect(canClose(st("closed")).ok).toBe(false);
  });
  it("canClose refusal names the missing close request", () => {
    expect(canClose(st("active")).reason).toMatch(/session_close_requested/);
  });
});
