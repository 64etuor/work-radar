import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchGitignoreContent, initRepo } from "../../src/repo/scaffold.js";
import {
  readConfig,
  writeConfig,
  loadPolicyOrStrict,
  mcpConfigJson,
} from "../../src/repo/configIo.js";
import { defaultConfig } from "../../src/repo/config.js";

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "boule-repo-"));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const exists = async (p: string) => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

describe("patchGitignoreContent — additive + idempotent", () => {
  it("adds the boule lines to empty content", () => {
    const out = patchGitignoreContent("");
    expect(out).toContain(".boule/workspace/");
    expect(out).toContain(".boule/mcp.json");
  });
  it("does not duplicate already-present lines", () => {
    const once = patchGitignoreContent("node_modules\n.boule/workspace/\n");
    const twice = patchGitignoreContent(once);
    expect(twice).toBe(once);
    expect(once.match(/\.boule\/workspace\//g)).toHaveLength(1);
  });
  it("preserves existing content", () => {
    const out = patchGitignoreContent("dist\n");
    expect(out).toContain("dist");
  });
});

describe("initRepo — scaffolds the .boule tree, idempotent", () => {
  it("creates workspace + worktrees + config + mcp.json + patches .gitignore", async () => {
    const r = await initRepo(repo, defaultConfig("work"));
    expect(r.created).toBe(true);
    expect(await exists(join(repo, ".boule/workspace"))).toBe(true);
    expect(await exists(join(repo, ".boule/worktrees"))).toBe(true);
    expect(await exists(join(repo, ".boule/boule.config.json"))).toBe(true);
    expect(await exists(join(repo, ".boule/mcp.json"))).toBe(true);
    expect(await readFile(join(repo, ".gitignore"), "utf8")).toContain(".boule/workspace/");
  });

  it("re-init preserves an existing config (does not clobber edited settings)", async () => {
    await initRepo(repo, defaultConfig("personal"));
    // user edits kind via settings
    await writeConfig(repo, defaultConfig("work", { projectName: "edited" }));
    const r2 = await initRepo(repo, defaultConfig("personal")); // re-init with a different kind
    expect(r2.created).toBe(false);
    const cfg = await readConfig(repo);
    expect(cfg.kind).toBe("work"); // preserved, NOT overwritten
    expect(cfg.projectName).toBe("edited");
  });

  it("--overwrite replaces the config", async () => {
    await initRepo(repo, defaultConfig("personal"));
    await initRepo(repo, defaultConfig("work"), { overwrite: true });
    expect((await readConfig(repo)).kind).toBe("work");
  });
});

describe("configIo — read/write + fail-closed policy load", () => {
  it("loadPolicyOrStrict returns the config policy when valid", async () => {
    await initRepo(repo, defaultConfig("personal"));
    const loaded = await loadPolicyOrStrict(repo);
    expect(loaded.source).toBe("config");
    expect(loaded.policy.autoMode).toBe("type2");
  });

  it("loadPolicyOrStrict degrades to STRICT (work) when config is missing — never silently loose", async () => {
    const loaded = await loadPolicyOrStrict(repo); // no .boule yet
    expect(loaded.source).toBe("fallback");
    expect(loaded.policy.autoMode).toBe("off");
    expect(loaded.policy.reviewQuorum).toBe(2);
  });

  it("loadPolicyOrStrict degrades to STRICT when config is corrupt", async () => {
    await initRepo(repo, defaultConfig("personal"));
    await writeFile(join(repo, ".boule/boule.config.json"), "{ not json");
    const loaded = await loadPolicyOrStrict(repo);
    expect(loaded.source).toBe("fallback");
    expect(loaded.policy.kind).toBe("work");
  });

  it("writeConfig rejects an invalid in-memory config (re-validates)", async () => {
    await initRepo(repo, defaultConfig("work"));
    // @ts-expect-error deliberately invalid
    await expect(writeConfig(repo, { schemaVersion: 1, kind: "bogus" })).rejects.toThrow();
  });

  it("mcpConfigJson points at the server with this repo's policy env", async () => {
    const json = mcpConfigJson(repo, (await loadPolicyOrStrict(repo)).policy);
    const parsed = JSON.parse(json);
    const server = parsed.mcpServers["boule-governance"];
    expect(server.command).toBe("node");
    expect(server.args.join(" ")).toContain("mcp/server.ts");
    expect(server.env.BOULE_WORKSPACE).toContain(".boule/workspace");
    expect(server.env.BOULE_AUTO_MODE).toBe("off"); // fallback strict
  });
});
