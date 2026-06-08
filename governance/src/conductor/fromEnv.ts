import { spawnSync as nodeSpawnSync } from "node:child_process";
import {
  lstat as fsLstat,
  mkdir as fsMkdir,
  rm as fsRm,
  symlink as fsSymlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  stubAdapter,
  makeLiveAdapter,
  projectLabelFromRepoRoot,
  type ConductorAdapter,
  type SpawnSyncLike,
} from "./adapter.ts";
import { parseConductorConfig } from "../mcp/config.ts";
import { cliEntrypoint } from "../repo/configIo.ts";

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
  // Operator codex auth (for the clean-CODEX_HOME symlink fallback): honour an already-set CODEX_HOME,
  // else the default ~/.codex. Read at wire time so the adapter stays env-pure.
  const codexAuthPath = join(env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  return makeLiveAdapter({
    spawn,
    fs: {
      mkdir: (p, o) => fsMkdir(p, o),
      writeFile: (p, d) => fsWriteFile(p, d),
      pathExists: async (p) => {
        try {
          await fsLstat(p);
          return true;
        } catch {
          return false;
        }
      },
      symlink: (target, link) => fsSymlink(target, link),
      rm: (p) => fsRm(p, { force: true }),
    },
    repoRoot: paths.repoRoot,
    worktreesRoot: cfg.worktreesRoot,
    cmuxCmd: cfg.cmuxCmd,
    governanceWorkspace: paths.workspace,
    serverEntrypoint: paths.serverEntrypoint,
    // install-relative (same resolution as serverEntrypoint); the codex completion wrapper shells it.
    completeEntrypoint: cliEntrypoint(),
    codexAuthPath,
    env,
    projectLabel: projectLabelFromRepoRoot(paths.repoRoot),
    log: (line) => process.stderr.write(`${line}\n`),
  });
}
