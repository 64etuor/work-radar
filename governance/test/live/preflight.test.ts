import { describe, it, expect } from "vitest";
import {
  evaluatePreflight,
  runPreflight,
  type PreflightCheck,
  type PreflightSignals,
  type SpawnResultLike,
} from "../../src/live/preflight.js";

// Fully-armed, infra-present signals — the happy path.
const ARMED: PreflightSignals = {
  env: {
    CMUX_SOCKET_PATH: "/tmp/cmux.sock",
    BOULE_CONDUCTOR_MODE: "live",
    BOULE_OBSERVER_MODE: "live",
    BOULE_AUTO_MODE: "type2",
  },
  cmuxBinaryOk: true,
  gitWorktreeOk: true,
};

function checkById(checks: PreflightCheck[], id: string): PreflightCheck {
  return checks.find((c) => c.id === id)!;
}

describe("evaluatePreflight — required infra gates ready", () => {
  it("ready=true when all required infra present (advisory flags irrelevant to ready)", () => {
    const r = evaluatePreflight({ ...ARMED, env: {} });
    // env empty ⇒ advisory flags all false, but the 3 required infra checks (socket/binary/git)…
    // socket comes from env so it's MISSING here → not ready. Use ARMED for the true happy path.
    expect(r.ready).toBe(false);
    const armed = evaluatePreflight(ARMED);
    expect(armed.ready).toBe(true);
  });

  it("missing CMUX_SOCKET_PATH ⇒ not ready (required)", () => {
    const r = evaluatePreflight({ ...ARMED, env: { ...ARMED.env, CMUX_SOCKET_PATH: "" } });
    expect(r.ready).toBe(false);
    expect(checkById(r.checks, "cmux_socket").ok).toBe(false);
    expect(checkById(r.checks, "cmux_socket").level).toBe("required");
  });

  it("cmux binary not resolving ⇒ not ready (required)", () => {
    const r = evaluatePreflight({ ...ARMED, cmuxBinaryOk: false });
    expect(r.ready).toBe(false);
    expect(checkById(r.checks, "cmux_binary").ok).toBe(false);
  });

  it("git worktree unavailable ⇒ not ready (required)", () => {
    const r = evaluatePreflight({ ...ARMED, gitWorktreeOk: false });
    expect(r.ready).toBe(false);
    expect(checkById(r.checks, "git_worktree").ok).toBe(false);
  });
});

describe("evaluatePreflight — flag posture is advisory (never blocks ready)", () => {
  it("infra present but flags unset ⇒ still ready; flag checks advisory+false", () => {
    const r = evaluatePreflight({
      ...ARMED,
      env: { CMUX_SOCKET_PATH: "/tmp/cmux.sock" }, // infra present, no live flags
    });
    expect(r.ready).toBe(true); // advisory flags do not block
    for (const id of ["conductor_mode", "observer_mode", "auto_mode"]) {
      expect(checkById(r.checks, id).level).toBe("advisory");
      expect(checkById(r.checks, id).ok).toBe(false);
    }
  });

  it("armed flags ⇒ advisory checks pass", () => {
    const r = evaluatePreflight(ARMED);
    expect(checkById(r.checks, "conductor_mode").ok).toBe(true);
    expect(checkById(r.checks, "observer_mode").ok).toBe(true);
    expect(checkById(r.checks, "auto_mode").ok).toBe(true);
  });

  it("orchestrator server running as executor-role is flagged (advisory, not ready-blocking)", () => {
    const r = evaluatePreflight({
      ...ARMED,
      env: { ...ARMED.env, BOULE_SESSION_ROLE: "executor" },
    });
    expect(r.ready).toBe(true); // advisory
    expect(checkById(r.checks, "session_role").ok).toBe(false);
    expect(checkById(r.checks, "session_role").detail).toMatch(/executor/);
  });

  it("auto_mode junk fails closed to off (advisory false)", () => {
    const r = evaluatePreflight({ ...ARMED, env: { ...ARMED.env, BOULE_AUTO_MODE: "yolo" } });
    expect(checkById(r.checks, "auto_mode").ok).toBe(false);
  });
});

describe("runPreflight — IO shell probes via injected spawn (no real processes)", () => {
  const ok: SpawnResultLike = { status: 0, stdout: "", stderr: "" };
  const fail: SpawnResultLike = { status: 1, stdout: "", stderr: "nope" };

  it("probes cmux --version and git worktree list, then classifies", () => {
    const calls: string[] = [];
    const spawn = (cmd: string, args: string[]): SpawnResultLike => {
      calls.push(`${cmd} ${args.join(" ")}`);
      return ok;
    };
    const r = runPreflight({
      env: { CMUX_SOCKET_PATH: "/tmp/cmux.sock", BOULE_CONDUCTOR_CMUX_CMD: "cmux" },
      spawn,
      repoRoot: "/repo",
    });
    expect(calls).toContain("cmux --version");
    expect(calls).toContain("git -C /repo worktree list");
    expect(r.ready).toBe(true);
  });

  it("a throwing probe degrades to a failed required check (no crash)", () => {
    const spawn = (): SpawnResultLike => {
      throw new Error("ENOENT");
    };
    const r = runPreflight({
      env: { CMUX_SOCKET_PATH: "/tmp/cmux.sock" },
      spawn,
      repoRoot: "/repo",
    });
    expect(r.ready).toBe(false);
    expect(checkById(r.checks, "cmux_binary").ok).toBe(false);
    expect(checkById(r.checks, "git_worktree").ok).toBe(false);
  });

  it("non-zero git probe ⇒ git_worktree check fails", () => {
    const spawn = (cmd: string): SpawnResultLike => (cmd === "git" ? fail : ok);
    const r = runPreflight({
      env: { CMUX_SOCKET_PATH: "/tmp/cmux.sock" },
      spawn,
      repoRoot: "/repo",
    });
    expect(checkById(r.checks, "git_worktree").ok).toBe(false);
    expect(checkById(r.checks, "cmux_binary").ok).toBe(true);
  });
});
