import { makeNodeSpawnSync } from "../repo/spawn.ts";

import { ensureCmuxSocketEnv } from "../conductor/cmuxSocket.ts";
import { parseConductorConfig, type ConductorConfig } from "../mcp/config.ts";
import { listStalledTasks } from "../orchestrator/stall.ts";
import { loadPolicyOrStrict, repoEnv } from "../repo/configIo.ts";
import { boulePaths } from "../repo/paths.ts";
import type { ResolvedPolicy } from "../repo/config.ts";
import { evaluateReadiness, type ReadinessReport } from "./readiness.ts";

export interface RepoReadiness {
  policy: ResolvedPolicy;
  env: Record<string, string | undefined>;
  cfg: ConductorConfig;
  stalledCount: number;
  readiness: ReadinessReport;
  /** "ok" | "fallback" — config load posture (callers may warn on fallback). */
  source: string;
  reason?: string;
}

/** Gather the per-repo readiness EXACTLY as `boule tick` does: policy-derived env (autonomyLevel →
 *  autoMode, etc.) + cheap cmux/git probes + stall count → evaluateReadiness. One-shot, read-only,
 *  no retry (INVARIANT #5). Used by BOTH `cmdTick` and `cmdSnapshot` so the Control Room verdict
 *  always equals what a real tick would gate on. */
export async function computeRepoReadiness(repoRoot: string): Promise<RepoReadiness> {
  const loaded = await loadPolicyOrStrict(repoRoot);
  // P1c — resolve a cmux socket (env → boule.config.json → ~/.local/state/cmux discovery) BEFORE
  // folding env: a Dock/launchd context inherits no CMUX_SOCKET_PATH, and the cmux child spawns
  // read process.env. Shared by tick AND snapshot so the dashboard verdict equals the tick's.
  // All-fail ⇒ env untouched ⇒ the exact current readiness-fail behavior (no degrade).
  await ensureCmuxSocketEnv(repoRoot);
  const env = { ...process.env, ...repoEnv(repoRoot, loaded.policy) };
  const cfg = parseConductorConfig(env);
  const nodeSpawn = makeNodeSpawnSync();
  const probe = (cmd: string, args: string[]): boolean => {
    try {
      return nodeSpawn(cmd, args).status === 0;
    } catch {
      return false;
    }
  };
  const stalledCount = (await listStalledTasks(boulePaths(repoRoot).workspace)).length;
  const readiness = evaluateReadiness({
    signals: {
      env,
      cmuxBinaryOk: probe(cfg.cmuxCmd, ["--version"]),
      gitWorktreeOk: probe("git", ["-C", repoRoot, "worktree", "list"]),
    },
    stalledCount,
  });
  return {
    policy: loaded.policy,
    env,
    cfg,
    stalledCount,
    readiness,
    source: loaded.source,
    reason: loaded.reason,
  };
}
