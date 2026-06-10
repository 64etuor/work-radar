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
    const sourceP = readFile(join(import.meta.dirname, "../../src/mcp/server.ts"), "utf8");

    it("every verdict tool registers via registerVerdictTool — never via bare server.registerTool", async () => {
      const source = await sourceP;
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
      const source = await sourceP;
      const calls = source.match(/registerVerdictTool\(\s*"/g) ?? [];
      expect(calls.length).toBe(VERDICT_TOOL_NAMES.length);
    });

    it("no non-canonical tool sneaks through the gated helper", async () => {
      const source = await sourceP;
      for (const m of source.matchAll(/registerVerdictTool\(\s*"([^"]+)"/g)) {
        expect(VERDICT_TOOL_NAME_SET.has(m[1]!), `"${m[1]}" not in VERDICT_TOOL_NAMES`).toBe(true);
      }
    });

    it("the executor no-op gate lives inside the helper (single predicate site)", async () => {
      const source = await sourceP;
      // Exactly one registration-gating use of SESSION_ALLOWS_VERDICTS — inside registerVerdictTool.
      const uses = source.match(/if \(!?SESSION_ALLOWS_VERDICTS\)/g) ?? [];
      expect(uses).toEqual(["if (!SESSION_ALLOWS_VERDICTS)"]);
    });
  });
});
