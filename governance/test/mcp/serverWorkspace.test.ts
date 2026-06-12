import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// P3b — the MCP server must FAIL CLOSED without BOULE_WORKSPACE instead of silently defaulting to
// the retired governance/workspace store (frozen 2026-06-02; live = <repo>/.boule/workspace).
// Real subprocess: the check is module-top-level, so only an actual `node server.ts` run proves it.

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/mcp/server.ts");

function runServer(env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn("node", ["--experimental-strip-types", SERVER], {
      env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += String(c);
    });
    child.on("error", reject);
    child.on("close", (code) => resolveRun({ code, stderr }));
  });
}

describe("mcp/server.ts workspace fail-closed", () => {
  it("missing BOULE_WORKSPACE ⇒ exit 1 + guidance naming the two real entrypoints", async () => {
    const env = { ...process.env };
    delete env.BOULE_WORKSPACE; // delete, NOT undefined-assign (spawn stringifies undefined)
    const r = await runServer(env);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/BOULE_WORKSPACE is not set/);
    expect(r.stderr).toMatch(/\.boule\/mcp\.json/);
    expect(r.stderr).toMatch(/boule run --repo/);
    expect(r.stderr).toMatch(/governance\/workspace froze/); // names the retired default
  }, 30_000);

  it("a blank BOULE_WORKSPACE is treated as missing (trim — no accidental cwd-relative store)", async () => {
    const r = await runServer({ ...process.env, BOULE_WORKSPACE: "   " });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/BOULE_WORKSPACE is not set/);
  }, 30_000);
});
