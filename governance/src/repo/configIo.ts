import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  parseBouleConfig,
  resolvePolicy,
  serializeConfig,
  policyEnv,
  STRICT_FALLBACK_POLICY,
  type BouleConfig,
  type ResolvedPolicy,
} from "./config.ts";
import { boulePaths } from "./paths.ts";

// Thin IO over the pure config core (spec 2026-06-07 §D). No policy logic here.

/** Absolute path to this governance package's MCP server entrypoint (for generated mcp.json /
 *  launcher exec). Resolved from this module so it is install-location independent. */
export function serverEntrypoint(): string {
  return resolve(fileURLToPath(new URL("..", import.meta.url)), "mcp", "server.ts");
}

/** Absolute path to this package's `boule` CLI entrypoint. The codex executor's completion wrapper
 *  shells `node <cliEntrypoint> report-exit` on clean exit, so resolve it install-relative (same
 *  install as serverEntrypoint), never under the target repo. */
export function cliEntrypoint(): string {
  return resolve(fileURLToPath(new URL("..", import.meta.url)), "cli", "boule.ts");
}

/** Read + strict-parse <repo>/.boule/boule.config.json. THROWS if missing/invalid. */
export async function readConfig(repoRoot: string): Promise<BouleConfig> {
  const text = await readFile(boulePaths(repoRoot).config, "utf8");
  return parseBouleConfig(JSON.parse(text));
}

export interface LoadedPolicy {
  policy: ResolvedPolicy;
  /** "config" when the repo's boule.config.json resolved; "fallback" when it was missing/invalid. */
  source: "config" | "fallback";
  /** present only when source==="fallback" — the reason (PII-safe). */
  reason?: string;
}

/** Fail-closed policy load: resolve the repo's config, or degrade to the STRICT (work) policy on
 *  ANY error. Never silently degrades to a LOOSER policy — the safe direction. */
export async function loadPolicyOrStrict(repoRoot: string): Promise<LoadedPolicy> {
  try {
    return { policy: resolvePolicy(await readConfig(repoRoot)), source: "config" };
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : String(err);
    return { policy: STRICT_FALLBACK_POLICY, source: "fallback", reason };
  }
}

/** Atomically write boule.config.json (write tmp + rename) after re-validating. */
export async function writeConfig(repoRoot: string, config: BouleConfig): Promise<void> {
  parseBouleConfig(config); // re-validate before persisting (reject a bad in-memory mutation)
  const p = boulePaths(repoRoot).config;
  const tmp = `${p}.tmp`;
  await mkdir(boulePaths(repoRoot).dir, { recursive: true });
  await writeFile(tmp, serializeConfig(config));
  await rename(tmp, p);
}

/** The env map a per-repo server runs under (pure mapping over loaded policy + repo dirs). */
export function repoEnv(repoRoot: string, policy: ResolvedPolicy): Record<string, string> {
  const p = boulePaths(repoRoot);
  return policyEnv(policy, { repoRoot, workspace: p.workspace, worktrees: p.worktrees });
}

/** Generated MCP client config (mcp.json) scoping a client to THIS repo's server + policy env.
 *  The user's claude/codex points --mcp-config here to talk to this repo's governance. */
export function mcpConfigJson(repoRoot: string, policy: ResolvedPolicy): string {
  const env = repoEnv(repoRoot, policy);
  return (
    JSON.stringify(
      {
        mcpServers: {
          "boule-governance": {
            command: "node",
            args: ["--experimental-strip-types", serverEntrypoint()],
            env,
          },
        },
      },
      null,
      2,
    ) + "\n"
  );
}

/** Write the generated mcp.json. */
export async function writeMcpConfig(repoRoot: string, policy: ResolvedPolicy): Promise<void> {
  await mkdir(boulePaths(repoRoot).dir, { recursive: true });
  await writeFile(boulePaths(repoRoot).mcp, mcpConfigJson(repoRoot, policy));
}
