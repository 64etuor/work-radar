import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposeSpec } from "../../src/spec/handlers.js";
import { proposePlan } from "../../src/plan/handlers.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { autoAccept } from "../../src/orchestrator/autoAccept.js";
import type { AutonomyLevel } from "../../src/repo/config.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 7, 12, 0, s));
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-autoaccept-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed() {
  const { specId } = await proposeSpec(dir, { title: "S", summary: "sum" }, at(0), 0.1);
  const { planId } = await proposePlan(dir, { intent: "I", steps: ["a"], specId }, at(1), 0.2);
  return { specId, planId };
}
async function accepts() {
  const all = await readAllEvents(dir);
  const ev = (t: string) => all.filter((e) => e.frontmatter.type === t);
  return { specAccepted: ev("spec_accepted"), planAccepted: ev("plan_accepted") };
}

describe("autoAccept — orchestrator gate opened only by autonomyLevel (INVARIANT #1 surface)", () => {
  it("manual / dispatch accept NOTHING (human gate intact)", async () => {
    await seed();
    for (const level of ["manual", "dispatch"] as AutonomyLevel[]) {
      const s = await autoAccept(dir, level, at(10), 0.3);
      expect(s).toEqual({ specsAccepted: 0, plansAccepted: 0 });
    }
    const a = await accepts();
    expect(a.specAccepted).toHaveLength(0);
    expect(a.planAccepted).toHaveLength(0);
  });

  it("auto_plan accepts the PLAN only (spec stays human-gated)", async () => {
    await seed();
    const s = await autoAccept(dir, "auto_plan", at(10), 0.3);
    expect(s).toEqual({ specsAccepted: 0, plansAccepted: 1 });
    const a = await accepts();
    expect(a.specAccepted).toHaveLength(0);
    expect(a.planAccepted).toHaveLength(1);
  });

  it("full accepts BOTH spec and plan", async () => {
    await seed();
    const s = await autoAccept(dir, "full", at(10), 0.3);
    expect(s).toEqual({ specsAccepted: 1, plansAccepted: 1 });
    const a = await accepts();
    expect(a.specAccepted).toHaveLength(1);
    expect(a.planAccepted).toHaveLength(1);
  });

  it("auto-accepts are actor:system + autonomy-auto tag — NEVER forged as a human (actor:user)", async () => {
    await seed();
    await autoAccept(dir, "full", at(10), 0.3);
    const all = await readAllEvents(dir);
    for (const t of ["spec_accepted", "plan_accepted"]) {
      const e = all.find((x) => x.frontmatter.type === t)!;
      expect(e.frontmatter.actor).toBe("system");
      expect(e.frontmatter.actor).not.toBe("user");
      expect(e.frontmatter.tags).toContain("autonomy-auto");
    }
  });

  it("is idempotent — a second pass accepts nothing (already-accepted skipped via canAccept)", async () => {
    await seed();
    const first = await autoAccept(dir, "full", at(10), 0.3);
    expect(first).toEqual({ specsAccepted: 1, plansAccepted: 1 });
    const second = await autoAccept(dir, "full", at(20), 0.4);
    expect(second).toEqual({ specsAccepted: 0, plansAccepted: 0 });
    // exactly one accepted event of each type total
    const all = await readAllEvents(dir);
    expect(all.filter((e) => e.frontmatter.type === "spec_accepted")).toHaveLength(1);
    expect(all.filter((e) => e.frontmatter.type === "plan_accepted")).toHaveLength(1);
  });
});
