import { spawnSync as nodeSpawnSync } from "node:child_process";
import { mkdir as fsMkdir, writeFile as fsWriteFile } from "node:fs/promises";
import {
  stubAdapter,
  makeLiveAdapter,
  projectLabelFromRepoRoot,
  type ConductorAdapter,
  type SpawnSyncLike,
} from "./adapter.ts";
import { parseConductorConfig } from "../mcp/config.ts";

/** Build the Conductor adapter from an env map — the single place that wires the LIVE adapter
 *  (real git worktree + cmux + envelope fs) vs the deterministic stub. Default (BOULE_CONDUCTOR_MODE
 *  unset) ⇒ stub (CI-safe, no side effects). Shared by the MCP server and the `boule tick` CLI so
 *  both conduct identically. `serverEntrypoint` is the Boule INSTALL path (NOT under the target
 *  repo) that spawned sessions point their executor MCP at. */
export function makeConductorAdapterFromEnv(
  env: Record<string, string | undefined>,
  paths: { workspace: string; repoRoot: string; serverEntrypoint: string },
): ConductorAdapter {
  const cfg = parseConductorConfig(env);
  if (!cfg.live) return stubAdapter;
  const spawn: SpawnSyncLike = (cmd, args) => {
    const r = nodeSpawnSync(cmd, args, { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return makeLiveAdapter({
    spawn,
    fs: { mkdir: (p, o) => fsMkdir(p, o), writeFile: (p, d) => fsWriteFile(p, d) },
    repoRoot: paths.repoRoot,
    worktreesRoot: cfg.worktreesRoot,
    cmuxCmd: cfg.cmuxCmd,
    governanceWorkspace: paths.workspace,
    serverEntrypoint: paths.serverEntrypoint,
    projectLabel: projectLabelFromRepoRoot(paths.repoRoot),
    log: (line) => process.stderr.write(`${line}\n`),
  });
}
