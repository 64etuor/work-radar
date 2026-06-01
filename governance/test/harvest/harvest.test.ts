import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harvest, makeWriteOne } from "../../src/harvest/harvest.js";
import { status } from "../../src/mcp/handlers.js";
import type { DecisionRow } from "../../src/index/types.js";

const US = "\x1f";
const RS = "\x1e";
const gitOut =
  ["a".repeat(40), "2026-06-01T00:00:00Z", "Alice", "feat: x"].join(US) + RS +
  ["b".repeat(40), "2026-05-30T00:00:00Z", "Bob", "fix: y"].join(US) + RS;

const rows: DecisionRow[] = [
  { id: "ADR-0007", kind: "adr", title: "Surface", status: "accepted", date: "2026-06-01",
    tags: [], supersedes: [], refs: [], excerpt: "", sourcePath: "docs/adr/0007.md" },
  { id: "DL-001", kind: "decision-log", title: "A tradeoff", status: undefined, date: undefined,
    tags: [], supersedes: [], refs: [], excerpt: "", sourcePath: "docs/decisions.md" },
];

describe("harvest (fakes)", () => {
  it("tallies written vs skipped and is idempotent on a second run", async () => {
    const seen = new Set<string>();
    const writeOne = async (item: { id: string }) => {
      if (seen.has(item.id)) return "skipped" as const;
      seen.add(item.id);
      return "written" as const;
    };
    const deps = {
      gitLog: async () => gitOut,
      loadDecisionRows: async () => rows,
      writeOne,
    };
    const first = await harvest(deps);
    expect(first.written).toBe(4); // 2 commits + 1 adr + 1 decision
    expect(first.skipped).toBe(0);

    const second = await harvest(deps);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(4);
  });

  it("fails soft when git is unavailable (0 commit events, no throw)", async () => {
    const deps = {
      gitLog: async () => { throw new Error("not a git repo"); },
      loadDecisionRows: async () => rows,
      writeOne: async () => "written" as const,
    };
    const s = await harvest(deps);
    expect(s.written).toBe(2); // only the 2 decision rows; commits contributed 0
  });
});

describe("makeWriteOne (real fs)", () => {
  let ws: string;
  beforeEach(async () => { ws = await mkdtemp(join(tmpdir(), "boule-harvest-")); });
  afterEach(async () => { await rm(ws, { recursive: true, force: true }); });

  it("writes events once, skips on re-harvest, and the store is rebuilt identically", async () => {
    const deps = {
      gitLog: async () => gitOut,
      loadDecisionRows: async () => rows,
      writeOne: makeWriteOne(ws),
    };
    const first = await harvest(deps);
    expect(first.written).toBe(4);
    expect((await status(ws)).eventCount).toBe(4);

    const second = await harvest(deps);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(4);
    expect((await status(ws)).eventCount).toBe(4); // no duplicates
  });
});
