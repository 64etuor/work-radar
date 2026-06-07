import { join } from "node:path";

// Per-repo governance layout (spec 2026-06-07 §A). All derived state lives under <repo>/.boule/;
// only boule.config.json is committed. Pure path computation — no IO.

export interface BoulePaths {
  /** <repo>/.boule */
  dir: string;
  /** <repo>/.boule/boule.config.json (COMMITTED) */
  config: string;
  /** <repo>/.boule/workspace (GITIGNORED — governance event store / BOULE_WORKSPACE) */
  workspace: string;
  /** <repo>/.boule/worktrees (GITIGNORED — conductor per-step worktrees / BOULE_CONDUCTOR_WORKTREES_ROOT) */
  worktrees: string;
  /** <repo>/.boule/mcp.json (GITIGNORED — generated MCP client config) */
  mcp: string;
}

export function boulePaths(repoRoot: string): BoulePaths {
  const dir = join(repoRoot, ".boule");
  return {
    dir,
    config: join(dir, "boule.config.json"),
    workspace: join(dir, "workspace"),
    worktrees: join(dir, "worktrees"),
    mcp: join(dir, "mcp.json"),
  };
}

/** .gitignore lines added by `boule init` (derived state only; boule.config.json stays committed).
 *  Repo-relative + trailing slash so they are additive and unambiguous. */
export const GITIGNORE_LINES = [".boule/workspace/", ".boule/worktrees/", ".boule/mcp.json"];
