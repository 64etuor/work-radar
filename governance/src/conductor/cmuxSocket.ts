import { readdir as fsReaddir, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { boulePaths } from "../repo/paths.ts";

// P1(c) cmux socket resolver (master plan 2026-06-12). Preflight REQUIRES CMUX_SOCKET_PATH
// (live/preflight.ts), but a Dock-launched app or a launchd tick inherits no terminal env — so the
// loop was permanently infra_failed outside a cmux shell. Resolve order:
//   (1) env CMUX_SOCKET_PATH — wins iff it points at a LIVE socket,
//   (2) `cmuxSocketPath` in <repo>/.boule/boule.config.json (explicit machine-local pin),
//   (3) discovery over the observed on-disk convention: ~/.local/state/cmux/*.sock
//       (this machine 2026-06-12: cmux.sock srw- next to cmux.sock.lock / last-socket-path
//       regular files), newest-mtime-first, liveness = stat().isSocket.
// All-fail ⇒ null and the caller's env is left UNTOUCHED — readiness fails exactly as before
// (no headless degrade; the visible pane is the operating SSOT — plan §5 기각).

export const CMUX_STATE_DIR_SEGMENTS = [".local", "state", "cmux"] as const;

export interface CmuxSocketStatLike {
  isSocket: boolean;
  mtimeMs: number;
}

/** Injected fs seam (mirrors adapter.ts FsLike style) — tests use fakes, no real sockets. */
export interface CmuxSocketFs {
  stat(path: string): Promise<CmuxSocketStatLike>;
  readdir(dir: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
}

export interface CmuxSocketResolution {
  path: string;
  source: "env" | "config" | "discovery";
}

function nodeCmuxSocketFs(): CmuxSocketFs {
  return {
    stat: async (path) => {
      const s = await fsStat(path);
      return { isSocket: s.isSocket(), mtimeMs: s.mtimeMs };
    },
    readdir: (dir) => fsReaddir(dir),
    readFile: (path) => fsReadFile(path, "utf8"),
  };
}

async function isLiveSocket(fs: CmuxSocketFs, path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isSocket;
  } catch {
    return false;
  }
}

/** Best-effort read of the optional `cmuxSocketPath` config field. Deliberately tolerant (a broken
 *  reviewQuorum must not kill socket resolution) — schema-level validation lives in repo/config.ts. */
async function configSocketPath(fs: CmuxSocketFs, repoRoot: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(boulePaths(repoRoot).config)) as {
      cmuxSocketPath?: unknown;
    };
    const value = typeof parsed.cmuxSocketPath === "string" ? parsed.cmuxSocketPath.trim() : "";
    return value || null;
  } catch {
    return null;
  }
}

/** Resolve a live cmux socket path, or null. Pure over the injected deps (no process globals). */
export async function resolveCmuxSocket(deps: {
  env: Record<string, string | undefined>;
  repoRoot?: string;
  homeDir: string;
  fs: CmuxSocketFs;
}): Promise<CmuxSocketResolution | null> {
  const fromEnv = (deps.env.CMUX_SOCKET_PATH ?? "").trim();
  if (fromEnv && (await isLiveSocket(deps.fs, fromEnv))) return { path: fromEnv, source: "env" };

  if (deps.repoRoot) {
    const fromConfig = await configSocketPath(deps.fs, deps.repoRoot);
    if (fromConfig && (await isLiveSocket(deps.fs, fromConfig)))
      return { path: fromConfig, source: "config" };
  }

  const dir = join(deps.homeDir, ...CMUX_STATE_DIR_SEGMENTS);
  let names: string[];
  try {
    names = await deps.fs.readdir(dir);
  } catch {
    return null;
  }
  const statJobs: Array<Promise<{ path: string; mtimeMs: number } | null>> = [];
  for (const name of names) {
    if (!name.endsWith(".sock")) continue;
    statJobs.push(
      (async () => {
        const path = join(dir, name);
        try {
          const s = await deps.fs.stat(path);
          return s.isSocket ? { path, mtimeMs: s.mtimeMs } : null;
        } catch {
          return null; // vanished between readdir and stat — skip
        }
      })(),
    );
  }
  const candidates = (await Promise.all(statJobs)).filter(
    (candidate): candidate is { path: string; mtimeMs: number } => candidate !== null,
  );
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const newest = candidates[0];
  return newest ? { path: newest.path, source: "discovery" } : null;
}

/** Resolve and INJECT into the given env map (default: process.env, which `cmux` child spawns
 *  inherit — makeNodeSpawnSync passes no env). env-source resolutions are no-ops (env already
 *  correct); all-fail leaves the map untouched so preflight fails exactly as today. */
export async function ensureCmuxSocketEnv(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
  overrides: { homeDir?: string; fs?: CmuxSocketFs } = {},
): Promise<CmuxSocketResolution | null> {
  const resolved = await resolveCmuxSocket({
    env,
    repoRoot,
    homeDir: overrides.homeDir ?? homedir(),
    fs: overrides.fs ?? nodeCmuxSocketFs(),
  });
  if (resolved && resolved.source !== "env") env.CMUX_SOCKET_PATH = resolved.path;
  return resolved;
}
