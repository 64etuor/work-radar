import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  cmdSchedule,
  renderTickPlist,
  scheduleLabel,
  scheduleSlug,
  type ScheduleDeps,
} from "../../src/cli/schedule.js";

const HOME = "/Users/u";
const UID = 501;
const NODE = "/opt/node/bin/node";
const CLI = "/install/governance/src/cli/boule.ts";

interface ExecCall {
  command: string;
  args: string[];
}

function fakeDeps(over: {
  execResults?: Array<{ status: number; stdout?: string; stderr?: string }>;
  files?: Record<string, string>;
} = {}): {
  deps: ScheduleDeps;
  execs: ExecCall[];
  written: Record<string, string>;
  appended: Record<string, string[]>;
  mkdirs: string[];
  removed: string[];
} {
  const execs: ExecCall[] = [];
  const written: Record<string, string> = {};
  const appended: Record<string, string[]> = {};
  const mkdirs: string[] = [];
  const removed: string[] = [];
  const files = { ...(over.files ?? {}) };
  const execResults = [...(over.execResults ?? [])];
  return {
    execs,
    written,
    appended,
    mkdirs,
    removed,
    deps: {
      exec: (command, args) => {
        execs.push({ command, args });
        const r = execResults.shift() ?? { status: 0 };
        return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      },
      fs: {
        mkdir: async (path) => {
          mkdirs.push(path);
        },
        writeFile: async (path, data) => {
          written[path] = data;
          files[path] = data;
        },
        rm: async (path) => {
          removed.push(path);
          delete files[path];
        },
        readFile: async (path) => {
          const content = files[path];
          if (content === undefined) throw new Error(`ENOENT: ${path}`);
          return content;
        },
        pathExists: async (path) => path in files,
        appendFile: async (path, data) => {
          (appended[path] ??= []).push(data);
        },
      },
      homeDir: HOME,
      uid: UID,
      nodePath: NODE,
      cliPath: CLI,
      now: () => new Date("2026-06-12T10:00:00Z"),
    },
  };
}

describe("scheduleSlug / scheduleLabel", () => {
  it("is deterministic: sanitized basename + 8-hex hash of the ABS path (distinct repos, same name)", () => {
    const a = scheduleSlug("/Users/u/work-radar");
    const b = scheduleSlug("/Users/u/elsewhere/work-radar");
    expect(a).toMatch(/^work-radar-[0-9a-f]{8}$/);
    expect(b).toMatch(/^work-radar-[0-9a-f]{8}$/);
    expect(a).not.toBe(b); // same basename, different path → different label
    expect(scheduleSlug("/Users/u/work-radar")).toBe(a); // stable
    expect(scheduleLabel("/Users/u/work-radar")).toBe(`kr.boule.tick.${a}`);
  });

  it("sanitizes spaces/case/specials in the basename", () => {
    expect(scheduleSlug("/Users/u/My Repo & Stuff")).toMatch(/^my-repo-stuff-[0-9a-f]{8}$/);
  });
});

describe("renderTickPlist — pure, XML-escaped", () => {
  const repo = "/Users/u/My Repo & Co";
  const logPath = join(repo, ".boule", "logs", "launchd-tick.log");

  it("renders the full LaunchAgent (snapshot; spaces + & escaped; PATH pinned; NO CMUX_SOCKET_PATH)", () => {
    const xml = renderTickPlist({
      label: "kr.boule.tick.my-repo-co-abcd1234",
      nodePath: NODE,
      cliPath: CLI,
      repo,
      intervalSec: 300,
      maxSteps: 2,
      logPath,
    });
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>kr.boule.tick.my-repo-co-abcd1234</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node/bin/node</string>
    <string>--experimental-strip-types</string>
    <string>/install/governance/src/cli/boule.ts</string>
    <string>tick</string>
    <string>--repo</string>
    <string>/Users/u/My Repo &amp; Co</string>
    <string>--max-steps</string>
    <string>2</string>
    <string>--json</string>
  </array>
  <key>StartInterval</key>
  <integer>300</integer>
  <key>StandardOutPath</key>
  <string>/Users/u/My Repo &amp; Co/.boule/logs/launchd-tick.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/u/My Repo &amp; Co/.boule/logs/launchd-tick.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`);
    // the resolver discovers the socket AT TICK TIME — a pinned env would rot across cmux restarts
    expect(xml).not.toContain("CMUX_SOCKET_PATH");
  });

  it("omits --max-steps when not given", () => {
    const xml = renderTickPlist({
      label: "l",
      nodePath: NODE,
      cliPath: CLI,
      repo: "/r",
      intervalSec: 600,
      logPath: "/r/.boule/logs/launchd-tick.log",
    });
    expect(xml).not.toContain("--max-steps");
    expect(xml).toContain("<integer>600</integer>");
  });
});

describe("cmdSchedule install", () => {
  const repo = "/Users/u/work-radar";
  const label = scheduleLabel(repo);
  const plistPath = join(HOME, "Library", "LaunchAgents", `${label}.plist`);
  const auditPath = join(repo, ".boule", "schedule-audit.log");

  it("writes the plist, bootout-then-bootstrap (replace semantics), and appends an audit line", async () => {
    const f = fakeDeps({ execResults: [{ status: 3 }, { status: 0 }] }); // bootout may fail (not loaded)
    const out = await cmdSchedule(["install", "--repo", repo, "--interval-sec", "120"], f.deps);
    expect(out).toContain(label);
    // dirs ensured: LaunchAgents + the repo's .boule/logs
    expect(f.mkdirs).toContain(join(HOME, "Library", "LaunchAgents"));
    expect(f.mkdirs).toContain(join(repo, ".boule", "logs"));
    // plist written with the requested interval
    expect(f.written[plistPath]).toContain("<integer>120</integer>");
    // replace semantics: bootout FIRST (ignored failure), bootstrap SECOND
    expect(f.execs).toEqual([
      { command: "launchctl", args: ["bootout", `gui/${UID}/${label}`] },
      { command: "launchctl", args: ["bootstrap", `gui/${UID}`, plistPath] },
    ]);
    // audited (ADR-0006: user-invoked, reversible, audited)
    expect(f.appended[auditPath]).toEqual([
      `2026-06-12T10:00:00.000Z install ${label} interval=120\n`,
    ]);
  });

  it("defaults the interval to 300s and accepts --max-steps", async () => {
    const f = fakeDeps();
    await cmdSchedule(["install", "--repo", repo, "--max-steps", "3"], f.deps);
    expect(f.written[plistPath]).toContain("<integer>300</integer>");
    expect(f.written[plistPath]).toContain("<string>--max-steps</string>");
    expect(f.written[plistPath]).toContain("<string>3</string>");
  });

  it("rejects interval < 60, non-integer interval, bad max-steps, and a relative repo", async () => {
    const f = fakeDeps();
    await expect(
      cmdSchedule(["install", "--repo", repo, "--interval-sec", "30"], f.deps),
    ).rejects.toThrow(/interval-sec/);
    await expect(
      cmdSchedule(["install", "--repo", repo, "--interval-sec", "1.5"], f.deps),
    ).rejects.toThrow(/interval-sec/);
    await expect(
      cmdSchedule(["install", "--repo", repo, "--max-steps", "0"], f.deps),
    ).rejects.toThrow(/max-steps/);
    await expect(cmdSchedule(["install", "--repo", "rel/path"], f.deps)).rejects.toThrow(
      /absolute/,
    );
    expect(f.execs).toHaveLength(0); // nothing launched on validation failure
  });

  it("a failed bootstrap throws (with stderr) and writes NO audit line", async () => {
    const f = fakeDeps({
      execResults: [{ status: 0 }, { status: 5, stderr: "Bootstrap failed: 5: Input/output error" }],
    });
    await expect(cmdSchedule(["install", "--repo", repo], f.deps)).rejects.toThrow(
      /Bootstrap failed/,
    );
    expect(f.appended[auditPath]).toBeUndefined();
  });
});

describe("cmdSchedule uninstall — idempotent + reversible", () => {
  const repo = "/Users/u/work-radar";
  const label = scheduleLabel(repo);
  const plistPath = join(HOME, "Library", "LaunchAgents", `${label}.plist`);
  const auditPath = join(repo, ".boule", "schedule-audit.log");

  it("boots the job out, removes the plist, audits", async () => {
    const f = fakeDeps({ files: { [plistPath]: "<plist/>" } });
    const out = await cmdSchedule(["uninstall", "--repo", repo], f.deps);
    expect(out).toContain(label);
    expect(f.execs).toEqual([{ command: "launchctl", args: ["bootout", `gui/${UID}/${label}`] }]);
    expect(f.removed).toContain(plistPath);
    expect(f.appended[auditPath]).toEqual([`2026-06-12T10:00:00.000Z uninstall ${label}\n`]);
  });

  it("install → uninstall → uninstall: the second uninstall is a clean no-op success", async () => {
    const f = fakeDeps({ execResults: [{ status: 0 }, { status: 0 }, { status: 0 }, { status: 5 }] });
    await cmdSchedule(["install", "--repo", repo], f.deps);
    await cmdSchedule(["uninstall", "--repo", repo], f.deps);
    // not loaded + plist already gone — still succeeds (missing = ok)
    const out = await cmdSchedule(["uninstall", "--repo", repo], f.deps);
    expect(out).toContain("uninstalled");
    expect(f.appended[auditPath]).toHaveLength(3); // install + uninstall + uninstall
  });
});

describe("cmdSchedule status", () => {
  const repo = "/Users/u/work-radar";
  const label = scheduleLabel(repo);
  const plistPath = join(HOME, "Library", "LaunchAgents", `${label}.plist`);

  it("reports installed + loaded + interval from the plist", async () => {
    const f = fakeDeps({ execResults: [{ status: 0 }] });
    await (async () => {
      // seed a rendered plist on "disk"
      const xml = renderTickPlist({
        label,
        nodePath: NODE,
        cliPath: CLI,
        repo,
        intervalSec: 450,
        logPath: join(repo, ".boule", "logs", "launchd-tick.log"),
      });
      await f.deps.fs.writeFile(plistPath, xml);
    })();
    const out = await cmdSchedule(["status", "--repo", repo], f.deps);
    expect(out).toContain(`label: ${label}`);
    expect(out).toContain("plist: installed");
    expect(out).toContain("loaded: yes");
    expect(out).toContain("interval: 450s");
    expect(out).toContain(join(repo, ".boule", "logs", "launchd-tick.log"));
    expect(f.execs).toEqual([{ command: "launchctl", args: ["print", `gui/${UID}/${label}`] }]);
  });

  it("reports a clean not-installed state", async () => {
    const f = fakeDeps({ execResults: [{ status: 113 }] });
    const out = await cmdSchedule(["status", "--repo", repo], f.deps);
    expect(out).toContain("plist: not installed");
    expect(out).toContain("loaded: no");
  });

  it("rejects an unknown subcommand", async () => {
    const f = fakeDeps();
    await expect(cmdSchedule(["enable", "--repo", repo], f.deps)).rejects.toThrow(
      /install\|uninstall\|status/,
    );
  });
});
