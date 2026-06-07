import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, cmdInit, cmdSet, cmdStatus } from "../../src/cli/boule.js";
import { readConfig } from "../../src/repo/configIo.js";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "boule-cli-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("parses command + --key value / --key=value / boolean --flag", () => {
    const a = parseArgs(["init", "--repo", "/p", "--kind=work", "--overwrite"]);
    expect(a.cmd).toBe("init");
    expect(a.flags.repo).toBe("/p");
    expect(a.flags.kind).toBe("work");
    expect(a.flags.overwrite).toBe(true);
  });
});

describe("cmdInit / cmdSet / cmdStatus", () => {
  it("init requires --kind and scaffolds the repo", async () => {
    await expect(cmdInit({ repo })).rejects.toThrow(/kind/);
    const msg = await cmdInit({ repo, kind: "personal", "project-name": "Demo" });
    expect(msg).toMatch(/initialized/);
    expect((await readConfig(repo)).kind).toBe("personal");
  });

  it("set mutates kind + overrides and re-validates", async () => {
    await cmdInit({ repo, kind: "personal" });
    await cmdSet({ repo, kind: "work", "auto-mode": "type2", "review-quorum": "3" });
    const cfg = await readConfig(repo);
    expect(cfg.kind).toBe("work");
    expect(cfg.overrides?.autoMode).toBe("type2");
    expect(cfg.overrides?.reviewQuorum).toBe(3);
  });

  it("set rejects an invalid auto-mode", async () => {
    await cmdInit({ repo, kind: "work" });
    await expect(cmdSet({ repo, "auto-mode": "yolo" })).rejects.toThrow(/auto-mode/);
  });

  it("status reports the resolved policy from config", async () => {
    await cmdInit({ repo, kind: "personal" });
    const out = await cmdStatus({ repo });
    expect(out).toMatch(/policy source: config/);
    expect(out).toMatch(/kind: personal/);
    expect(out).toMatch(/autoMode: type2/);
  });

  it("status on an uninitialized repo shows the strict fallback", async () => {
    const out = await cmdStatus({ repo });
    expect(out).toMatch(/policy source: fallback/);
    expect(out).toMatch(/kind: work/);
  });

  it("requires --repo", async () => {
    await expect(cmdStatus({})).rejects.toThrow(/--repo/);
  });
});
