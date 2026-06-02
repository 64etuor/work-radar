import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposePlan, acceptPlan, revisePlan, completePlan } from "../../src/plan/handlers.js";
import { projectPlans, renderPlans } from "../../src/plan/project.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-planproj-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function seed() {
  const a = await proposePlan(dir, { intent: "alpha", steps: ["s"] }, at(0), 0.1);
  await acceptPlan(dir, { planId: a.planId }, at(1), 0.2);
  const b = await proposePlan(dir, { intent: "beta", steps: ["s"] }, at(2), 0.3);
  await acceptPlan(dir, { planId: b.planId }, at(3), 0.4);
  await revisePlan(dir, { planId: b.planId, reason: "x" }, at(4), 0.5);
  return { a, b };
}

describe("plan projector", () => {
  it("projectPlans is pure: no I/O, emits no events, stable across calls", async () => {
    await seed();
    const all = await readAllEvents(dir);
    const before = all.length;
    const r1 = projectPlans(all);
    const r2 = projectPlans(all);
    expect(r1).toEqual(r2);
    expect((await readAllEvents(dir)).length).toBe(before);
  });

  it("KEYSTONE: wipe state/ and re-render → byte-identical (projection = f(events))", async () => {
    await seed();
    const p = await renderPlans(dir);
    const first = await readFile(p, "utf8");
    await rm(join(dir, "state"), { recursive: true, force: true });
    const p2 = await renderPlans(dir);
    const second = await readFile(p2, "utf8");
    expect(second).toBe(first);
  });

  it("projection reflects derived phases", async () => {
    const { a, b } = await seed();
    await completePlan(dir, { planId: a.planId }, at(5), 0.6);
    const states = projectPlans(await readAllEvents(dir));
    const byId = Object.fromEntries(states.map((s) => [s.planId, s.phase]));
    expect(byId[a.planId]).toBe("completed");
    expect(byId[b.planId]).toBe("needs_revision");
  });
});
