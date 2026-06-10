import { spawnSync as nodeSpawnSync } from "node:child_process";

// ── cmux tree-walk shared helper ─────────────────────────────────────────────

/** A terminal surface entry from `cmux tree --json` output. */
export interface TerminalSurfaceEntry {
  /** The surface ref string (e.g. "surface:9"). */
  ref: string;
  /** The workspace ref that contains this surface, if available. */
  workspaceRef: string | undefined;
}

/** Walk the windows[].workspaces[].panes[].surfaces[] tree from `cmux tree --json` output,
 *  yielding each surface whose `type === "terminal"`. Shared by the Conductor
 *  (`firstTerminalSurface`, scoped to one workspace + throws) and the Observer
 *  (`parseSurfaces`, global + returns set). Returns [] on malformed/empty JSON (defensive). */
export function walkTerminalSurfaces(treeJson: string): TerminalSurfaceEntry[] {
  let tree: unknown;
  try {
    tree = JSON.parse(treeJson);
  } catch {
    return [];
  }
  const rec = (x: unknown): Record<string, unknown> =>
    x && typeof x === "object" ? (x as Record<string, unknown>) : {};
  const asArray = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const out: TerminalSurfaceEntry[] = [];
  for (const w of asArray(rec(tree).windows)) {
    for (const ws of asArray(rec(w).workspaces)) {
      const workspaceRef = typeof rec(ws).ref === "string" ? (rec(ws).ref as string) : undefined;
      for (const p of asArray(rec(ws).panes)) {
        for (const s of asArray(rec(p).surfaces)) {
          const node = rec(s);
          if (typeof node.ref === "string" && node.ref.length > 0 && node.type === "terminal") {
            out.push({ ref: node.ref as string, workspaceRef });
          }
        }
      }
    }
  }
  return out;
}

/** Minimal structural seam over a child process — satisfied by node's spawnSync at the
 *  boundary and by a fake in tests. Synchronous capture keeps command SEQUENCE assertable. */
export interface SpawnResultLike {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type SpawnSyncLike = (command: string, args: string[]) => SpawnResultLike;

/** Single factory that wraps node's spawnSync with the standard nullish-coalesce defaults.
 *  Use at DI boundaries (server.ts, fromEnv.ts, etc.) instead of repeating the inline adapter. */
export function makeNodeSpawnSync(): SpawnSyncLike {
  return (cmd, args) => {
    const r = nodeSpawnSync(cmd, args, { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
}
