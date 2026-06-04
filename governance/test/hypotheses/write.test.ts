import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { HypothesisRecord } from "../../src/hypotheses/types.ts";
import { makeWriteHypothesis, serializeHypothesis } from "../../src/hypotheses/write.ts";

const record: HypothesisRecord = {
  id: "hyp_12345678",
  fromPattern: "pat_scope_abcdef12",
  kind: "commit_scope_hotspot_persists",
  scope: "governance",
  status: "testing",
  testMethod: "current_l0_scope_count",
  baseline: 5,
  threshold: 5,
  expires: "2026-07-04",
  body: "Commit scope `governance` should remain a hotspot.\n",
};

describe("hypothesis writer", () => {
  it("serializes deterministic frontmatter and markdown", () => {
    expect(serializeHypothesis(record)).toMatchInlineSnapshot(`
      "---
      id: hyp_12345678
      from_pattern: pat_scope_abcdef12
      kind: commit_scope_hotspot_persists
      scope: governance
      status: testing
      test_method: current_l0_scope_count
      baseline: 5
      threshold: 5
      expires: '2026-07-04'
      ---
      Commit scope \`governance\` should remain a hotspot.
      "
    `);
  });

  it("writes only under hypotheses/testing and skips identical content", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "boule-hypotheses-"));
    const writeHypothesis = makeWriteHypothesis(workspace);

    await expect(writeHypothesis(record)).resolves.toBe("written");
    await expect(writeHypothesis(record)).resolves.toBe("skipped");

    const file = join(workspace, "hypotheses", "testing", "hyp_12345678.md");
    await expect(readFile(file, "utf8")).resolves.toBe(serializeHypothesis(record));
  });
});
