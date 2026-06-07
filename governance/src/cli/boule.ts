import { spawn } from "node:child_process";
import { boulePaths } from "../repo/paths.ts";
import {
  defaultConfig,
  parseBouleConfig,
  resolvePolicy,
  type BouleConfig,
  type Kind,
} from "../repo/config.ts";
import { initRepo } from "../repo/scaffold.ts";
import {
  readConfig,
  writeConfig,
  writeMcpConfig,
  loadPolicyOrStrict,
  repoEnv,
  serverEntrypoint,
} from "../repo/configIo.ts";

// `boule` CLI (spec 2026-06-07 §D): per-repo launcher + settings admin. DB-free — the work-radar
// app drives discovery of designated local repos and calls `init`/`set` per repo with explicit
// args (keeps the governance package decoupled from the app sqlite, decision #3).

export interface ParsedArgs {
  cmd: string;
  flags: Record<string, string | boolean>;
}

/** Tiny arg parser: `--key value` | `--key=value` | `--flag` (boolean). First non-flag = command. */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let cmd = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      if (!cmd) cmd = a;
      continue;
    }
    const eq = a.indexOf("=");
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      flags[a.slice(2)] = argv[++i]!;
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { cmd, flags };
}

function reqRepo(flags: ParsedArgs["flags"]): string {
  const repo = flags.repo;
  if (typeof repo !== "string" || !repo) throw new Error("--repo <path> is required");
  return repo;
}
function asKind(v: unknown): Kind {
  if (v !== "personal" && v !== "work")
    throw new Error(`--kind must be personal|work (got ${String(v)})`);
  return v;
}

/** init: scaffold <repo>/.boule for a kind. kind via --kind (the app passes it from the DB). */
export async function cmdInit(flags: ParsedArgs["flags"]): Promise<string> {
  const repo = reqRepo(flags);
  const kind = asKind(flags.kind);
  const config = defaultConfig(kind, {
    projectId: typeof flags["project-id"] === "string" ? flags["project-id"] : undefined,
    projectName: typeof flags["project-name"] === "string" ? flags["project-name"] : undefined,
  });
  const r = await initRepo(repo, config, { overwrite: flags.overwrite === true });
  return `${r.created ? "initialized" : "refreshed"} ${r.paths.dir} (kind=${kind})`;
}

/** set: mutate boule.config.json (the CLI half of "changeable from settings") + regen mcp.json. */
export async function cmdSet(flags: ParsedArgs["flags"]): Promise<string> {
  const repo = reqRepo(flags);
  const current: BouleConfig = await readConfig(repo);
  const overrides = { ...(current.overrides ?? {}) };
  if (flags["autonomy-level"] !== undefined) {
    const l = flags["autonomy-level"];
    if (l !== "manual" && l !== "dispatch" && l !== "auto_plan" && l !== "full")
      throw new Error("--autonomy-level must be manual|dispatch|auto_plan|full");
    overrides.autonomyLevel = l;
  }
  if (flags["review-quorum"] !== undefined) {
    const n = Number(flags["review-quorum"]);
    if (!Number.isInteger(n) || n < 1) throw new Error("--review-quorum must be an integer >= 1");
    overrides.reviewQuorum = n;
  }
  const next: BouleConfig = {
    ...current,
    kind: flags.kind !== undefined ? asKind(flags.kind) : current.kind,
    overrides: Object.keys(overrides).length ? overrides : undefined,
  };
  parseBouleConfig(next); // validate before persisting
  await writeConfig(repo, next);
  await writeMcpConfig(repo, resolvePolicy(next));
  return `updated ${boulePaths(repo).config} (kind=${next.kind})`;
}

/** status: print the resolved policy + paths (read-only; shows fail-closed fallback if config bad). */
export async function cmdStatus(flags: ParsedArgs["flags"]): Promise<string> {
  const repo = reqRepo(flags);
  const loaded = await loadPolicyOrStrict(repo);
  const p = boulePaths(repo);
  const lines = [
    `repo: ${repo}`,
    `policy source: ${loaded.source}${loaded.reason ? ` (${loaded.reason})` : ""}`,
    `kind: ${loaded.policy.kind}`,
    `autonomyLevel: ${loaded.policy.autonomyLevel}${
      loaded.policy.autonomyLevel === "auto_plan" || loaded.policy.autonomyLevel === "full"
        ? "  ⚠️ AI accepts plan/spec (INVARIANT #1 opened — test/dev)"
        : ""
    }`,
    `autoMode: ${loaded.policy.autoMode}  reviewQuorum: ${loaded.policy.reviewQuorum}`,
    `forbiddenDecisionClasses: ${loaded.policy.forbiddenDecisionClasses.join(", ")}`,
    `allowedType2Actions: ${loaded.policy.allowedType2Actions.join(", ")}`,
    `workspace: ${p.workspace}`,
    `worktrees: ${p.worktrees}`,
    `mcp.json: ${p.mcp}`,
  ];
  return lines.join("\n");
}

/** run: exec the governance MCP server scoped to this repo's policy env (stdio passthrough). */
export async function cmdRun(flags: ParsedArgs["flags"]): Promise<number> {
  const repo = reqRepo(flags);
  const loaded = await loadPolicyOrStrict(repo);
  if (loaded.source === "fallback") {
    process.stderr.write(
      `boule: WARN config unreadable, using STRICT fallback policy (${loaded.reason})\n`,
    );
  }
  const env = { ...process.env, ...repoEnv(repo, loaded.policy) };
  return await new Promise<number>((res) => {
    const child = spawn("node", ["--experimental-strip-types", serverEntrypoint()], {
      env,
      stdio: "inherit",
    });
    child.on("exit", (code) => res(code ?? 0));
    child.on("error", (e) => {
      process.stderr.write(`boule: failed to launch server: ${e.message}\n`);
      res(1);
    });
  });
}

const USAGE = `boule <command> --repo <path>
  init   --repo <p> --kind <personal|work> [--project-id X] [--project-name Y] [--overwrite]
  set    --repo <p> [--kind k] [--autonomy-level manual|dispatch|auto_plan|full] [--review-quorum n]
  status --repo <p>
  run    --repo <p>   # exec the per-repo governance MCP server (stdio)`;

export async function main(argv: string[]): Promise<number> {
  const { cmd, flags } = parseArgs(argv);
  try {
    switch (cmd) {
      case "init":
        process.stdout.write((await cmdInit(flags)) + "\n");
        return 0;
      case "set":
        process.stdout.write((await cmdSet(flags)) + "\n");
        return 0;
      case "status":
        process.stdout.write((await cmdStatus(flags)) + "\n");
        return 0;
      case "run":
        return await cmdRun(flags);
      default:
        process.stderr.write(USAGE + "\n");
        return cmd ? 1 : 0;
    }
  } catch (err) {
    process.stderr.write(`boule: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

// Entrypoint guard: run only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
