import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdSnapshot } from "../../src/cli/boule.ts";

let repo: string;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "cr-snap-infra-"));
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("cmdSnapshot infra/readiness", () => {
  it("emits infra checks + readiness gates even with zero events", async () => {
    const json = await cmdSnapshot({ repo });
    const snap = JSON.parse(json);
    expect(snap.tasks).toEqual([]);
    expect(snap.generatedAt).toBeNull();
    expect(Array.isArray(snap.infra)).toBe(true);
    const ids = snap.infra.map((c: { id: string }) => c.id);
    expect(ids).toContain("cmux_socket");
    expect(ids).toContain("git_worktree");
    expect(snap.readiness).toMatchObject({
      ready: expect.any(Boolean),
      blockers: expect.any(Array),
      warnings: expect.any(Array),
      gates: {
        preflight: expect.any(Boolean),
        conductor: expect.any(Boolean),
        observer: expect.any(Boolean),
        auto: expect.any(Boolean),
        stall: expect.any(Boolean),
      },
    });
  });
});
