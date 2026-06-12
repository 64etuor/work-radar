import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  CMUX_STATE_DIR_SEGMENTS,
  ensureCmuxSocketEnv,
  resolveCmuxSocket,
  type CmuxSocketFs,
} from "../../src/conductor/cmuxSocket.js";

// Observed machine convention (2026-06-12): CMUX_SOCKET_PATH=~/.local/state/cmux/cmux.sock and the
// parent dir holds the live socket (srw-) next to cmux.sock.lock / last-socket-path regular files.
const HOME = "/home/u";
const STATE_DIR = join(HOME, ...CMUX_STATE_DIR_SEGMENTS);

/** Fake fs over a path → entry map. stat throws on unknown paths (like the real one). */
function fakeFs(entries: {
  sockets?: Record<string, number>; // path → mtimeMs (isSocket: true)
  files?: Record<string, string>; // path → content (isSocket: false, readable)
  dirs?: Record<string, string[]>; // dir → entry names
}): CmuxSocketFs {
  return {
    async stat(path) {
      if (entries.sockets && path in entries.sockets)
        return { isSocket: true, mtimeMs: entries.sockets[path]! };
      if (entries.files && path in entries.files) return { isSocket: false, mtimeMs: 0 };
      throw new Error(`ENOENT: ${path}`);
    },
    async readdir(dir) {
      const names = entries.dirs?.[dir];
      if (!names) throw new Error(`ENOENT: ${dir}`);
      return names;
    },
    async readFile(path) {
      const content = entries.files?.[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

const repoRoot = "/repo";
const configPath = "/repo/.boule/boule.config.json";
const configWith = (cmuxSocketPath: string) =>
  JSON.stringify({ schemaVersion: 1, kind: "personal", cmuxSocketPath });

describe("resolveCmuxSocket — env → config → discovery", () => {
  it("env wins when CMUX_SOCKET_PATH points at a live socket (config+discovery ignored)", async () => {
    const fs = fakeFs({
      sockets: {
        "/env/cmux.sock": 10,
        "/cfg/cmux.sock": 20,
        [join(STATE_DIR, "cmux.sock")]: 30,
      },
      files: { [configPath]: configWith("/cfg/cmux.sock") },
      dirs: { [STATE_DIR]: ["cmux.sock"] },
    });
    const r = await resolveCmuxSocket({
      env: { CMUX_SOCKET_PATH: "/env/cmux.sock" },
      repoRoot,
      homeDir: HOME,
      fs,
    });
    expect(r).toEqual({ path: "/env/cmux.sock", source: "env" });
  });

  it("falls through a dead env path to the config field", async () => {
    const fs = fakeFs({
      sockets: { "/cfg/cmux.sock": 20 },
      files: { [configPath]: configWith("/cfg/cmux.sock") },
    });
    const r = await resolveCmuxSocket({
      env: { CMUX_SOCKET_PATH: "/env/dead.sock" },
      repoRoot,
      homeDir: HOME,
      fs,
    });
    expect(r).toEqual({ path: "/cfg/cmux.sock", source: "config" });
  });

  it("config fallback: blank env + live cmuxSocketPath in boule.config.json", async () => {
    const fs = fakeFs({
      sockets: { "/cfg/cmux.sock": 20 },
      files: { [configPath]: configWith("/cfg/cmux.sock") },
    });
    const r = await resolveCmuxSocket({ env: {}, repoRoot, homeDir: HOME, fs });
    expect(r).toEqual({ path: "/cfg/cmux.sock", source: "config" });
  });

  it("discovery picks the newest LIVE *.sock under ~/.local/state/cmux (dead + non-sock skipped)", async () => {
    const old = join(STATE_DIR, "old.sock");
    const newest = join(STATE_DIR, "cmux.sock");
    const fs = fakeFs({
      sockets: { [old]: 100, [newest]: 200 },
      // cmux.sock.lock + last-socket-path are REGULAR files in the real dir; dead.sock is a
      // leftover regular file with a .sock name — all must be skipped.
      files: {
        [join(STATE_DIR, "cmux.sock.lock")]: "",
        [join(STATE_DIR, "last-socket-path")]: newest,
        [join(STATE_DIR, "dead.sock")]: "",
      },
      dirs: { [STATE_DIR]: ["cmux.sock.lock", "last-socket-path", "dead.sock", "old.sock", "cmux.sock"] },
    });
    const r = await resolveCmuxSocket({ env: {}, repoRoot, homeDir: HOME, fs });
    expect(r).toEqual({ path: newest, source: "discovery" });
  });

  it("ignores an unparseable/withheld config and still discovers", async () => {
    const sock = join(STATE_DIR, "cmux.sock");
    const fs = fakeFs({
      sockets: { [sock]: 10 },
      files: { [configPath]: "{ not json" },
      dirs: { [STATE_DIR]: ["cmux.sock"] },
    });
    const r = await resolveCmuxSocket({ env: {}, repoRoot, homeDir: HOME, fs });
    expect(r).toEqual({ path: sock, source: "discovery" });
  });

  it("all-fail ⇒ null (callers keep the EXACT current readiness-fail behavior)", async () => {
    const fs = fakeFs({});
    const r = await resolveCmuxSocket({ env: {}, repoRoot, homeDir: HOME, fs });
    expect(r).toBeNull();
  });
});

describe("ensureCmuxSocketEnv", () => {
  it("injects a non-env resolution into the env map; leaves env untouched on all-fail", async () => {
    const sock = join(STATE_DIR, "cmux.sock");
    const fs = fakeFs({ sockets: { [sock]: 10 }, dirs: { [STATE_DIR]: ["cmux.sock"] } });
    const env: Record<string, string | undefined> = {};
    const r = await ensureCmuxSocketEnv(repoRoot, env, { homeDir: HOME, fs });
    expect(r).toEqual({ path: sock, source: "discovery" });
    expect(env.CMUX_SOCKET_PATH).toBe(sock);

    const env2: Record<string, string | undefined> = {};
    expect(await ensureCmuxSocketEnv(repoRoot, env2, { homeDir: HOME, fs: fakeFs({}) })).toBeNull();
    expect("CMUX_SOCKET_PATH" in env2).toBe(false);
  });

  it("does not rewrite an env value that already resolves (env-wins, idempotent)", async () => {
    const fs = fakeFs({ sockets: { "/env/cmux.sock": 10 } });
    const env: Record<string, string | undefined> = { CMUX_SOCKET_PATH: "/env/cmux.sock" };
    const r = await ensureCmuxSocketEnv(repoRoot, env, { homeDir: HOME, fs });
    expect(r).toEqual({ path: "/env/cmux.sock", source: "env" });
    expect(env.CMUX_SOCKET_PATH).toBe("/env/cmux.sock");
  });
});
