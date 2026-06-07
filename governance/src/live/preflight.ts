import { parseAutoMode, parseConductorConfig, parseObserverMode } from "../mcp/config.ts";

// L0 — Live-loop preflight (master plan 2026-06-07, Phase L0).
//
// PURE CORE + injected IO. evaluatePreflight() is a total function over already-gathered signals
// (env + cheap probe booleans) so it is deterministic and unit-testable with zero processes. The
// thin runPreflight() IO shell (the only impure part) gathers the probes via an injected spawn and
// hands them to the pure core — mirroring conductor/adapter.ts and session/observer.ts.
//
// Scope: this answers "can the live autonomous loop PHYSICALLY run here, and is the flag posture
// armed?" — infrastructure + env posture only. The stricter "safe to run UNATTENDED" gate
// (envelope enforcement + bounds + halt-tested) is Phase L4 (readiness.ts), not here.

export type CheckLevel = "required" | "advisory";

export interface PreflightCheck {
  /** stable id (e.g. "cmux_socket") so callers/tests match without string-parsing detail. */
  id: string;
  ok: boolean;
  level: CheckLevel;
  /** PII-safe one-liner: names the env var / probe + its observed state, never secrets/paths-as-data. */
  detail: string;
}

export interface PreflightReport {
  /** true ⇔ every REQUIRED check passed. Advisory checks never block ready. */
  ready: boolean;
  checks: PreflightCheck[];
}

/** Already-gathered signals handed to the pure core. Booleans are cheap probe outcomes the IO
 *  shell computes; env is the raw process env (or a test fixture). */
export interface PreflightSignals {
  env: Record<string, string | undefined>;
  /** the `cmux` binary resolves + responds (e.g. `cmux --version` exited 0). */
  cmuxBinaryOk: boolean;
  /** repoRoot is a git work-area where `git worktree list` succeeds. */
  gitWorktreeOk: boolean;
}

function check(id: string, ok: boolean, level: CheckLevel, detail: string): PreflightCheck {
  return { id, ok, level, detail };
}

/** Pure, total classifier. REQUIRED checks gate `ready`; advisory checks only inform.
 *
 *  REQUIRED (physical ability to run the live loop):
 *   - cmux_socket:  CMUX_SOCKET_PATH set + non-empty (the live conductor/observer talk to cmux over it)
 *   - cmux_binary:  the cmux CLI resolves (new-workspace / send / tree)
 *   - git_worktree: git worktree add can run from repoRoot (per-step isolation, INVARIANT #6)
 *
 *  ADVISORY (flag posture — a preflight run BEFORE arming flags should still be useful, so a
 *  not-yet-live posture must not make ready=false; it just reports what to set):
 *   - conductor_mode / observer_mode / auto_mode / session_role
 */
export function evaluatePreflight(signals: PreflightSignals): PreflightReport {
  const { env } = signals;
  const socket = (env.CMUX_SOCKET_PATH ?? "").trim();
  const cond = parseConductorConfig(env);
  const observerLive = parseObserverMode(env.BOULE_OBSERVER_MODE);
  const auto = parseAutoMode(env.BOULE_AUTO_MODE);
  const role = (env.BOULE_SESSION_ROLE ?? "").trim().toLowerCase();

  const checks: PreflightCheck[] = [
    check(
      "cmux_socket",
      socket.length > 0,
      "required",
      `CMUX_SOCKET_PATH ${socket ? "set" : "MISSING"}`,
    ),
    check(
      "cmux_binary",
      signals.cmuxBinaryOk,
      "required",
      `cmux binary ${signals.cmuxBinaryOk ? "resolved" : "NOT found/responding"}`,
    ),
    check(
      "git_worktree",
      signals.gitWorktreeOk,
      "required",
      `git worktree ${signals.gitWorktreeOk ? "available" : "UNAVAILABLE in repoRoot"}`,
    ),
    check(
      "conductor_mode",
      cond.live,
      "advisory",
      `BOULE_CONDUCTOR_MODE=${env.BOULE_CONDUCTOR_MODE ?? "(unset)"} → ${cond.live ? "live" : "stub (set =live to spawn real sessions)"}`,
    ),
    check(
      "observer_mode",
      observerLive,
      "advisory",
      `BOULE_OBSERVER_MODE=${env.BOULE_OBSERVER_MODE ?? "(unset)"} → ${observerLive ? "live" : "stub (set =live to detect crashes/stalls)"}`,
    ),
    check(
      "auto_mode",
      auto === "type2",
      "advisory",
      `BOULE_AUTO_MODE=${env.BOULE_AUTO_MODE ?? "(unset)"} → ${auto} (set =type2 for unattended step advance)`,
    ),
    // The ORCHESTRATING server must NOT be executor-role (that would strip its own verdict tools).
    // executor-role belongs only to Conductor-spawned sessions. ok ⇔ not executor here.
    check(
      "session_role",
      role !== "executor",
      "advisory",
      `BOULE_SESSION_ROLE=${env.BOULE_SESSION_ROLE ?? "(unset)"}${role === "executor" ? " ⚠ orchestrator server is executor-role (verdict tools stripped)" : ""}`,
    ),
  ];

  const ready = checks.filter((c) => c.level === "required").every((c) => c.ok);
  return { ready, checks };
}

// ── IO shell (the only impure part) ─────────────────────────────────────────────────────────────

export interface SpawnResultLike {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type SpawnSyncLike = (command: string, args: string[]) => SpawnResultLike;

export interface PreflightDeps {
  env: Record<string, string | undefined>;
  spawn: SpawnSyncLike; // child_process.spawnSync-like
  repoRoot: string;
}

/** Gather cheap probes (cmux --version, git -C repoRoot worktree list) and classify. One-shot,
 *  no retry loop (INVARIANT #5), no mutation. A throwing/erroring probe degrades to a failed
 *  required check rather than crashing the preflight. */
export function runPreflight(deps: PreflightDeps): PreflightReport {
  const cmuxCmd = parseConductorConfig(deps.env).cmuxCmd;
  const probe = (command: string, args: string[]): boolean => {
    try {
      return deps.spawn(command, args).status === 0;
    } catch {
      return false;
    }
  };
  return evaluatePreflight({
    env: deps.env,
    cmuxBinaryOk: probe(cmuxCmd, ["--version"]),
    gitWorktreeOk: probe("git", ["-C", deps.repoRoot, "worktree", "list"]),
  });
}
