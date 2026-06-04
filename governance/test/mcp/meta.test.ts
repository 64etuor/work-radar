import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";
import { afterEach, beforeEach } from "vitest";
import { listHypotheses } from "../../src/hypotheses/tester.ts";
import { buildMetaObservation } from "../../src/meta/observer.ts";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-mcp-meta-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

async function seedHypothesis(id: string, status: "verified" | "refuted", scope: string) {
  const dir = join(ws, "hypotheses", "testing");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${id}.md`),
    matter.stringify(`Hypothesis ${id}.\n`, {
      id,
      from_pattern: `pat_${scope}`,
      kind: "commit_scope_hotspot_persists",
      scope,
      status,
      test_method: "current_l0_scope_count",
      baseline: 5,
      threshold: 5,
      expires: "2026-07-04",
    }),
    "utf8",
  );
}

describe("meta_observe MCP round-trip", () => {
  it("builds a proposal from verified hypotheses only", async () => {
    await seedHypothesis("hyp_verified", "verified", "governance");
    await seedHypothesis("hyp_refuted", "refuted", "shell");

    const result = buildMetaObservation({ hypotheses: await listHypotheses(ws) });

    expect(result.hasProposal).toBe(true);
    if (!result.hasProposal) throw new Error("expected proposal");
    expect(result.markdown).toContain("hyp_verified");
    expect(result.markdown).toContain("Scope: governance");
    expect(result.markdown).not.toContain("hyp_refuted");
  });
});

describe("meta_observe MCP tool surface", () => {
  it("registers a P5 propose-only tool with a stable no-verdict block", async () => {
    const source = await readFile(join(import.meta.dirname, "../../src/mcp/server.ts"), "utf8");

    expect(source).toContain("// ── P5: Meta Observer");
    expect(source).toContain('"meta_observe"');

    const p5Block = source.slice(source.indexOf("// ── P5: Meta Observer"), source.indexOf("const AUTHOR_MODEL"));
    expect(p5Block).toContain("buildMetaObservation");
    expect(p5Block).not.toContain('"approve"');
    expect(p5Block).not.toContain('"reject"');
    expect(p5Block).not.toContain('"choose"');
    expect(p5Block).not.toContain("decision_");
    expect(p5Block).not.toContain("decision-rails");
  });

  it("keeps the pure observer free of filesystem write APIs", async () => {
    const source = await readFile(join(import.meta.dirname, "../../src/meta/observer.ts"), "utf8");

    expect(source).not.toContain("node:fs");
    expect(source).not.toContain("node:fs/promises");
    expect(source).not.toContain("writeFile");
    expect(source).not.toContain("mkdir");
  });
});
