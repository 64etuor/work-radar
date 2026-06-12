import { createHash } from "node:crypto";
import {
  appendFile as fsAppendFile,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  rm as fsRm,
  stat as fsStat,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { makeNodeSpawnSync } from "../repo/spawn.ts";
import { cliEntrypoint } from "../repo/configIo.ts";
import { parseArgs, type ParsedArgs } from "./args.ts";

// P3(a) T5 — `boule schedule install|uninstall|status`: a per-repo launchd LaunchAgent that runs
// `boule tick` on a fixed StartInterval. The OS is the clock (plan §5: cron-is-clock, NO bespoke
// daemon); the tick keeps ALL of its own gates (readiness/halt/autonomy/mutex), so the scheduler
// adds cadence and nothing else (INVARIANT #1). ADR-0006 external-dir rails: writing
// ~/Library/LaunchAgents is USER-INVOKED (this CLI only), REVERSIBLE (uninstall = bootout + rm,
// idempotent), and AUDITED (one line per install/uninstall in <repo>/.boule/schedule-audit.log).
// The plist pins NO CMUX_SOCKET_PATH — the P1c resolver discovers the live socket at tick time
// (a pinned path would rot whenever cmux restarts).

export interface ScheduleExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ScheduleFsLike {
  mkdir(path: string): Promise<void>; // recursive
  writeFile(path: string, data: string): Promise<void>;
  rm(path: string): Promise<void>; // force (missing = ok)
  readFile(path: string): Promise<string>;
  pathExists(path: string): Promise<boolean>;
  appendFile(path: string, data: string): Promise<void>;
}

/** Everything side-effecting is injected — tests NEVER run real launchctl. */
export interface ScheduleDeps {
  exec: (command: string, args: string[]) => ScheduleExecResult;
  fs: ScheduleFsLike;
  homeDir: string;
  uid: number;
  /** absolute node executable (launchd has no PATH magic — pin the binary that runs today). */
  nodePath: string;
  /** absolute path to this install's src/cli/boule.ts. */
  cliPath: string;
  now: () => Date;
}

export function nodeScheduleDeps(): ScheduleDeps {
  const spawn = makeNodeSpawnSync();
  return {
    exec: (command, args) => spawn(command, args),
    fs: {
      mkdir: async (path) => {
        await fsMkdir(path, { recursive: true });
      },
      writeFile: (path, data) => fsWriteFile(path, data),
      rm: (path) => fsRm(path, { force: true }),
      readFile: (path) => fsReadFile(path, "utf8"),
      pathExists: async (path) => {
        try {
          await fsStat(path);
          return true;
        } catch {
          return false;
        }
      },
      appendFile: (path, data) => fsAppendFile(path, data),
    },
    homeDir: homedir(),
    uid: process.getuid?.() ?? 501,
    nodePath: process.execPath,
    cliPath: cliEntrypoint(),
    now: () => new Date(),
  };
}

/** Sanitized basename + 8-hex sha256 of the ABS path: human-greppable AND collision-free across
 *  same-named repos. Pure + deterministic (label == identity for bootout/uninstall). */
export function scheduleSlug(repoAbs: string): string {
  const base =
    basename(repoAbs)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "repo";
  const hash = createHash("sha256").update(repoAbs).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

export function scheduleLabel(repoAbs: string): string {
  return `kr.boule.tick.${scheduleSlug(repoAbs)}`;
}

function plistPathFor(homeDir: string, label: string): string {
  return join(homeDir, "Library", "LaunchAgents", `${label}.plist`);
}

function auditPathFor(repo: string): string {
  return join(repo, ".boule", "schedule-audit.log");
}

function logPathFor(repo: string): string {
  return join(repo, ".boule", "logs", "launchd-tick.log");
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface TickPlistOpts {
  label: string;
  nodePath: string;
  cliPath: string;
  repo: string;
  intervalSec: number;
  maxSteps?: number;
  logPath: string;
}

/** Pure plist rendering (snapshot-tested). PATH = the node bin dir + the system sbin/bin set —
 *  enough for node/git/launchctl-spawned children without inheriting a user shell environment. */
export function renderTickPlist(opts: TickPlistOpts): string {
  const argv = [
    opts.nodePath,
    "--experimental-strip-types",
    opts.cliPath,
    "tick",
    "--repo",
    opts.repo,
    ...(opts.maxSteps !== undefined ? ["--max-steps", String(opts.maxSteps)] : []),
    "--json",
  ];
  const argvXml = argv.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");
  const pathEnv = `${dirname(opts.nodePath)}:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(opts.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argvXml}
  </array>
  <key>StartInterval</key>
  <integer>${opts.intervalSec}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(opts.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(pathEnv)}</string>
  </dict>
</dict>
</plist>
`;
}

function reqAbsRepo(flags: ParsedArgs["flags"]): string {
  const repo = flags.repo;
  if (typeof repo !== "string" || !repo) throw new Error("--repo <abs path> is required");
  if (!isAbsolute(repo)) throw new Error(`--repo must be absolute (got ${repo})`);
  return repo;
}

function parseIntervalSec(flags: ParsedArgs["flags"]): number {
  const raw = flags["interval-sec"];
  if (raw === undefined) return 300;
  const n = Number(raw);
  if (typeof raw !== "string" || !Number.isInteger(n) || n < 60)
    throw new Error("--interval-sec must be an integer >= 60");
  return n;
}

function parseMaxSteps(flags: ParsedArgs["flags"]): number | undefined {
  const raw = flags["max-steps"];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (typeof raw !== "string" || !Number.isInteger(n) || n < 1)
    throw new Error("--max-steps must be an integer >= 1");
  return n;
}

async function appendAudit(deps: ScheduleDeps, repo: string, line: string): Promise<void> {
  await deps.fs.appendFile(auditPathFor(repo), `${deps.now().toISOString()} ${line}\n`);
}

async function installSchedule(flags: ParsedArgs["flags"], deps: ScheduleDeps): Promise<string> {
  const repo = reqAbsRepo(flags);
  const intervalSec = parseIntervalSec(flags);
  const maxSteps = parseMaxSteps(flags);
  const label = scheduleLabel(repo);
  const plistPath = plistPathFor(deps.homeDir, label);
  const logPath = logPathFor(repo);

  await deps.fs.mkdir(dirname(logPath));
  await deps.fs.mkdir(dirname(plistPath));
  await deps.fs.writeFile(
    plistPath,
    renderTickPlist({
      label,
      nodePath: deps.nodePath,
      cliPath: deps.cliPath,
      repo,
      intervalSec,
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      logPath,
    }),
  );

  // Replace semantics: an already-loaded label refuses bootstrap, so boot it out first
  // (failure = "wasn't loaded" — fine, ignored).
  deps.exec("launchctl", ["bootout", `gui/${deps.uid}/${label}`]);
  const boot = deps.exec("launchctl", ["bootstrap", `gui/${deps.uid}`, plistPath]);
  if (boot.status !== 0) {
    throw new Error(
      `launchctl bootstrap failed (exit ${boot.status}): ${boot.stderr.trim().slice(0, 300)}`,
    );
  }
  await appendAudit(deps, repo, `install ${label} interval=${intervalSec}`);
  return [
    `installed ${label} (tick every ${intervalSec}s${maxSteps !== undefined ? `, max-steps ${maxSteps}` : ""})`,
    `  plist: ${plistPath}`,
    `  logs:  ${logPath}`,
    `  audit: ${auditPathFor(repo)}`,
    `  uninstall: boule schedule uninstall --repo ${repo}`,
    `  note: the agent pins this node binary (${deps.nodePath}) — re-run install after a node upgrade`,
  ].join("\n");
}

async function uninstallSchedule(flags: ParsedArgs["flags"], deps: ScheduleDeps): Promise<string> {
  const repo = reqAbsRepo(flags);
  const label = scheduleLabel(repo);
  const plistPath = plistPathFor(deps.homeDir, label);
  const out = deps.exec("launchctl", ["bootout", `gui/${deps.uid}/${label}`]);
  await deps.fs.rm(plistPath); // force — already-missing is ok (idempotent)
  await appendAudit(deps, repo, `uninstall ${label}`);
  return `uninstalled ${label} (bootout ${out.status === 0 ? "ok" : "was not loaded"}; plist removed)`;
}

async function statusSchedule(flags: ParsedArgs["flags"], deps: ScheduleDeps): Promise<string> {
  const repo = reqAbsRepo(flags);
  const label = scheduleLabel(repo);
  const plistPath = plistPathFor(deps.homeDir, label);
  const exists = await deps.fs.pathExists(plistPath);
  const loaded = deps.exec("launchctl", ["print", `gui/${deps.uid}/${label}`]).status === 0;
  let interval = "unknown";
  if (exists) {
    const m = (await deps.fs.readFile(plistPath)).match(
      /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/,
    );
    if (m) interval = `${m[1]}s`;
  }
  return [
    `label: ${label}`,
    `plist: ${exists ? "installed" : "not installed"} (${plistPath})`,
    `loaded: ${loaded ? "yes" : "no"}`,
    `interval: ${exists ? interval : "n/a"}`,
    `logs: ${logPathFor(repo)}`,
  ].join("\n");
}

/** Dispatch `boule schedule <install|uninstall|status> --repo <abs> …`. `argv` is everything after
 *  the `schedule` token; deps default to the real node/launchctl boundary. */
export async function cmdSchedule(
  argv: string[],
  deps: ScheduleDeps = nodeScheduleDeps(),
): Promise<string> {
  const { cmd, flags } = parseArgs(argv);
  switch (cmd) {
    case "install":
      return await installSchedule(flags, deps);
    case "uninstall":
      return await uninstallSchedule(flags, deps);
    case "status":
      return await statusSchedule(flags, deps);
    default:
      throw new Error(`schedule requires a subcommand: install|uninstall|status (got "${cmd}")`);
  }
}
