import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  proposePlan, acceptPlan, revisePlan, completePlan, archivePlan, supersedePlan, listPlans, planTrail,
} from "../../src/plan/handlers.js";
import { readAllEvents } from "../../src/decision/readEvents.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 2, 12, 0, s));

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "boule-plan-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("plan handlers — Planner + lifecycle", () => {
  it("propose writes EXACTLY ONE plan_proposed, actor=planner (NOT user), draft phase", async () => {
    const { planId } = await proposePlan(dir, { intent: "Load feature X", steps: ["a", "b"] }, at(0), 0.1);
    const all = await readAllEvents(dir);
    const proposals = all.filter((e) => e.frontmatter.type === "plan_proposed");
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.frontmatter.id).toBe(planId);
    expect(proposals[0]!.frontmatter.actor).toBe("planner");
    expect((await planTrail(dir, { planId })).phase).toBe("draft");
  });

  it("propose throws on empty intent or no steps", async () => {
    await expect(proposePlan(dir, { intent: "  ", steps: ["a"] }, at(0), 0.1)).rejects.toThrow(/intent/i);
    await expect(proposePlan(dir, { intent: "X", steps: [] }, at(1), 0.2)).rejects.toThrow(/step/i);
    await expect(proposePlan(dir, { intent: "X", steps: ["  "] }, at(2), 0.3)).rejects.toThrow(/step/i);
  });

  it("STRUCTURAL INVARIANT #1: the Planner's propose path writes ZERO plan_accepted (cannot self-accept)", async () => {
    await proposePlan(dir, { intent: "X", steps: ["a"] }, at(0), 0.1);
    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type === "plan_accepted")).toBe(false);
  });

  it("accept_plan writes plan_accepted with actor=user (human gate); draft → active", async () => {
    const { planId } = await proposePlan(dir, { intent: "X", steps: ["a"] }, at(0), 0.1);
    const r = await acceptPlan(dir, { planId }, at(1), 0.2);
    expect(r.ok).toBe(true);
    const all = await readAllEvents(dir);
    const acc = all.find((e) => e.frontmatter.type === "plan_accepted");
    expect(acc!.frontmatter.actor).toBe("user");
    expect((await planTrail(dir, { planId })).phase).toBe("active");
  });

  it("propose → accept → revise → re-accept → complete; trail in order", async () => {
    const { planId } = await proposePlan(dir, { intent: "X", steps: ["a"] }, at(0), 0.1);
    expect((await acceptPlan(dir, { planId }, at(1), 0.2)).ok).toBe(true);
    expect((await revisePlan(dir, { planId, reason: "scope" }, at(2), 0.3)).ok).toBe(true);
    expect((await acceptPlan(dir, { planId }, at(3), 0.4)).ok).toBe(true);
    expect((await completePlan(dir, { planId }, at(4), 0.5)).ok).toBe(true);
    const trail = await planTrail(dir, { planId });
    expect(trail.phase).toBe("completed");
    expect(trail.chain.map((c) => c.type)).toEqual([
      "plan_proposed", "plan_accepted", "plan_revised", "plan_accepted", "plan_completed",
    ]);
  });

  it("accept is REFUSED on an already-active plan, and writes nothing", async () => {
    const { planId } = await proposePlan(dir, { intent: "X", steps: ["a"] }, at(0), 0.1);
    await acceptPlan(dir, { planId }, at(1), 0.2);
    const r = await acceptPlan(dir, { planId }, at(2), 0.3);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/active/i);
    expect((await readAllEvents(dir)).filter((e) => e.frontmatter.type === "plan_accepted")).toHaveLength(1);
  });

  it("revise is REFUSED on a draft (never-accepted) plan", async () => {
    const { planId } = await proposePlan(dir, { intent: "X", steps: ["a"] }, at(0), 0.1);
    const r = await revisePlan(dir, { planId, reason: "x" }, at(1), 0.2);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/active/i);
  });

  it("NEGATIVE: plan commands write ZERO decision_* and ZERO task_* events", async () => {
    const { planId } = await proposePlan(dir, { intent: "X", steps: ["a"] }, at(0), 0.1);
    await acceptPlan(dir, { planId }, at(1), 0.2);
    await revisePlan(dir, { planId, reason: "x" }, at(2), 0.3);
    const all = await readAllEvents(dir);
    expect(all.some((e) => e.frontmatter.type.startsWith("decision_"))).toBe(false);
    expect(all.some((e) => e.frontmatter.type.startsWith("task_"))).toBe(false);
  });

  it("listPlans omits terminal plans", async () => {
    const a = await proposePlan(dir, { intent: "alive", steps: ["s"] }, at(0), 0.1);
    const b = await proposePlan(dir, { intent: "gone", steps: ["s"] }, at(1), 0.2);
    await archivePlan(dir, { planId: b.planId }, at(2), 0.3);
    const open = await listPlans(dir);
    expect(open.map((p) => p.planId)).toEqual([a.planId]);
  });

  it("supersede moves a draft to superseded (terminal)", async () => {
    const { planId } = await proposePlan(dir, { intent: "X", steps: ["a"] }, at(0), 0.1);
    expect((await supersedePlan(dir, { planId }, at(1), 0.2)).ok).toBe(true);
    expect((await planTrail(dir, { planId })).phase).toBe("superseded");
  });
});
