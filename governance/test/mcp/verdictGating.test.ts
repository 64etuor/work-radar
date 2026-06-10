import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  VERDICT_TOOL_NAMES,
  VERDICT_TOOL_NAME_SET,
  sessionDeniedTools,
} from "../../src/mcp/verdictTools.js";
import { SESSION_DENIED_TOOLS } from "../../src/conductor/adapter.js";

/** INVARIANT #1 structural-wall drift guards. The canonical verdict-tool list
 *  (`verdictTools.ts`) feeds BOTH the server's role-gated registration
 *  (`registerVerdictTool`) and the session CLI denylist (`SESSION_DENIED_TOOLS`).
 *  These tests pin (a) the derivation, (b) that every canonical tool registers ONLY
 *  through the gated helper in server.ts — a bare `server.registerTool("approve", …)`
 *  would silently expose a verdict to executor sessions. */
describe("verdict gating — single source, no drift (INVARIANT #1)", () => {
  it("SESSION_DENIED_TOOLS is exactly the canonical list under the boule-governance alias", () => {
    expect(SESSION_DENIED_TOOLS).toEqual(sessionDeniedTools("boule-governance"));
    expect(SESSION_DENIED_TOOLS).toEqual(
      VERDICT_TOOL_NAMES.map((n) => `mcp__boule-governance__${n}`),
    );
  });

  it("the canonical list still names the nine gate-opening tools", () => {
    expect([...VERDICT_TOOL_NAMES].sort()).toEqual(
      [
        "approve",
        "reject",
        "choose",
        "accept_plan",
        "accept_spec",
        "auto_dispatch",
        "activate_pattern",
        "archive_pattern",
        "archive_prune",
      ].sort(),
    );
    expect(VERDICT_TOOL_NAME_SET.size).toBe(VERDICT_TOOL_NAMES.length); // no dupes
  });

  describe("server.ts registration surface", () => {
    const SRC_MCP = join(import.meta.dirname, "../../src/mcp");
    const TOOLS_DIR = join(SRC_MCP, "tools");

    // Concatenation of server.ts + every file in src/mcp/tools/ (sorted for determinism).
    // This is the full registration surface after the split.
    async function readRegistrationSurface(): Promise<string> {
      const { readdir } = await import("node:fs/promises");
      const toolFiles = (await readdir(TOOLS_DIR)).filter((f) => f.endsWith(".ts")).sort();
      const parts = [await readFile(join(SRC_MCP, "server.ts"), "utf8")];
      for (const f of toolFiles) parts.push(await readFile(join(TOOLS_DIR, f), "utf8"));
      return parts.join("\n");
    }

    it("every verdict tool registers via registerVerdictTool — never via bare server.registerTool", async () => {
      const source = await readRegistrationSurface();
      for (const name of VERDICT_TOOL_NAMES) {
        const gated = new RegExp(`registerVerdictTool\\(\\s*"${name}"`);
        const bare = new RegExp(`server\\.registerTool\\(\\s*"${name}"`);
        expect(source, `${name} must be registered via registerVerdictTool`).toMatch(gated);
        expect(
          bare.test(source),
          `${name} must NOT be registered via bare server.registerTool`,
        ).toBe(false);
      }
    });

    it("gated registration count equals the canonical list (none dropped, none duplicated)", async () => {
      const source = await readRegistrationSurface();
      const calls = source.match(/registerVerdictTool\(\s*"/g) ?? [];
      expect(calls.length).toBe(VERDICT_TOOL_NAMES.length);
    });

    it("no non-canonical tool sneaks through the gated helper", async () => {
      const source = await readRegistrationSurface();
      for (const m of source.matchAll(/registerVerdictTool\(\s*"([^"]+)"/g)) {
        expect(VERDICT_TOOL_NAME_SET.has(m[1]!), `"${m[1]}" not in VERDICT_TOOL_NAMES`).toBe(true);
      }
    });

    it("the executor no-op gate lives inside the helper (single predicate site)", async () => {
      // The predicate must appear exactly once — inside registerVerdictTool in server.ts.
      // No tools/*.ts file may contain it (the gate is the helper's job alone).
      const serverSource = await readFile(join(SRC_MCP, "server.ts"), "utf8");
      const uses = serverSource.match(/if \(!?SESSION_ALLOWS_VERDICTS\)/g) ?? [];
      expect(uses).toEqual(["if (!SESSION_ALLOWS_VERDICTS)"]);

      const { readdir } = await import("node:fs/promises");
      const toolFiles = (await readdir(TOOLS_DIR)).filter((f) => f.endsWith(".ts")).sort();
      for (const f of toolFiles) {
        const s = await readFile(join(TOOLS_DIR, f), "utf8");
        expect(
          s.includes("SESSION_ALLOWS_VERDICTS"),
          `tools/${f} must not mention SESSION_ALLOWS_VERDICTS`,
        ).toBe(false);
      }
    });
  });
});
