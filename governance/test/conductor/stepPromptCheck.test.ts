import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan } from "../../src/conductor/handlers.js";
import { stubAdapter, type ConductorAdapter } from "../../src/conductor/adapter.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 12, 12, 0, s));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-stepprompt-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Capture the prompt the conductor writes for the spawned session. */
function capturingAdapter(prompts: string[]): ConductorAdapter {
  return {
    ...stubAdapter,
    async writeEnvelopeFile(_worktreePath, _envelope, prompt) {
      prompts.push(prompt);
    },
  };
}

async function promptFor(
  step: string | { text: string; check?: { command?: string; artifact?: string; kind?: "human" } },
): Promise<string> {
  const prompts: string[] = [];
  const { planId } = await proposePlan(dir, { intent: "I", steps: [step] }, at(0), 0.1);
  await acceptPlan(dir, { planId }, at(1), 0.2);
  await conductPlan(dir, { planId }, { adapter: capturingAdapter(prompts) }, at(10), 0.3);
  expect(prompts).toHaveLength(1);
  return prompts[0]!;
}

describe("step-prompt completion-certification injection (P2c) — the executor is told its contract", () => {
  it("a machine-checked step gets its check command AND artifact verbatim", async () => {
    const p = await promptFor({
      text: "implement the slice",
      check: { command: "pnpm vitest run --silent", artifact: "out/report.json" },
    });
    expect(p).toContain("## Completion certification");
    expect(p).toContain("pnpm vitest run --silent");
    expect(p).toContain("out/report.json");
  });

  it("a CHECKLESS step is told completion requires human certification", async () => {
    const p = await promptFor("do something unverifiable");
    expect(p).toContain("## Completion certification");
    expect(p.toLowerCase()).toContain("human certification");
  });

  it("an explicit check:{kind:'human'} step is told the same (and not given a fake machine contract)", async () => {
    const p = await promptFor({ text: "review the docs", check: { kind: "human" } });
    expect(p).toContain("## Completion certification");
    expect(p.toLowerCase()).toContain("human certification");
    expect(p).not.toContain("exit 0");
  });

  it("the certification section coexists with the envelope + escalate contract (appended, not replacing)", async () => {
    const p = await promptFor({ text: "implement", check: { command: "true" } });
    expect(p).toContain("## Autonomy envelope");
    expect(p).toContain("## Required final action");
    expect(p).toContain("## Completion certification");
  });
});
