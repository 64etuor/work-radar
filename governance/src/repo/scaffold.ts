import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { boulePaths, GITIGNORE_LINES } from "./paths.ts";
import { writeConfig, writeMcpConfig } from "./configIo.ts";
import { resolvePolicy, type BouleConfig } from "./config.ts";

// `boule init` scaffolding (spec 2026-06-07 §D). Idempotent: re-running never duplicates or clobbers.

const GITIGNORE_HEADER = "# Boule governance (derived state — boule.config.json stays committed)";

/** Pure: add any missing Boule lines to existing .gitignore content under a header. Idempotent —
 *  a line already present (anywhere) is not re-added. Returns the (possibly unchanged) content. */
export function patchGitignoreContent(existing: string): string {
  const present = new Set(existing.split("\n").map((l) => l.trim()));
  const missing = GITIGNORE_LINES.filter((l) => !present.has(l));
  if (missing.length === 0) return existing;
  const base = existing.length > 0 && !existing.endsWith("\n") ? existing + "\n" : existing;
  return `${base}${base.length ? "\n" : ""}${GITIGNORE_HEADER}\n${missing.join("\n")}\n`;
}

async function patchGitignore(repoRoot: string): Promise<void> {
  const path = join(repoRoot, ".gitignore");
  let existing = "";
  try {
    existing = await readFile(path, "utf8");
  } catch {
    existing = "";
  }
  const next = patchGitignoreContent(existing);
  if (next !== existing) await writeFile(path, next);
}

export interface InitResult {
  created: boolean; // false when config already existed (idempotent re-init refreshes derived state)
  paths: ReturnType<typeof boulePaths>;
}

/** Scaffold <repo>/.boule for a given config: create dirs, write config (idempotent — preserves an
 *  existing config unless `overwrite`), regenerate mcp.json from the resolved policy, patch
 *  .gitignore. Safe to re-run. */
export async function initRepo(
  repoRoot: string,
  config: BouleConfig,
  opts: { overwrite?: boolean } = {},
): Promise<InitResult> {
  const paths = boulePaths(repoRoot);
  await mkdir(paths.workspace, { recursive: true });
  await mkdir(paths.worktrees, { recursive: true });

  let existing: BouleConfig | null = null;
  try {
    const { readConfig } = await import("./configIo.ts");
    existing = await readConfig(repoRoot);
  } catch {
    existing = null;
  }
  const effective = existing && !opts.overwrite ? existing : config;
  if (!existing || opts.overwrite) await writeConfig(repoRoot, effective);

  await writeMcpConfig(repoRoot, resolvePolicy(effective));
  await patchGitignore(repoRoot);
  return { created: existing === null, paths };
}
