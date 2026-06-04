import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubAdapter, type ConductorAdapter } from "../../../src/conductor/adapter.js";
import { canApprove } from "../../../src/decision/guardian.js";
import { readAllEvents } from "../../../src/decision/readEvents.js";
import { generateId } from "../../../src/event/id.js";
import type { GovEvent } from "../../../src/event/event.js";
import { writeEvent } from "../../../src/event/writeEvent.js";
import { autoDispatch } from "../../../src/orchestrator/dispatch/dispatch.js";

const RAND = 0.42;
let ws: string;
let seedSec = 0;

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-dispatch-"));
  seedSec = 0;
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

function at(): Date {
  return new Date(Date.UTC(2026, 5, 3, 0, 0, seedSec++));
}

function later(): Date {
  return new Date(Date.UTC(2026, 5, 3, 0, 1, seedSec++));
}

async function seed(evt: GovEvent, when: Date): Promise<void> {
  await writeEvent(ws, evt, when);
}

async function seedAcceptedPlan(steps: string[]): Promise<string> {
  const when = at();
  const planId = generateId("evt", when, RAND);
  await seed({
    frontmatter: {
      id: planId,
      type: "plan_proposed",
      source: "hermes",
      actor: "planner",
      tags: ["plan"],
      related_to: [],
    },
    body: ["intent line", "", ...steps.map((s, i) => `${i + 1}. ${s}`)].join("\n"),
  }, when);
  const acceptedAt = at();
  await seed({
    frontmatter: {
      id: generateId("evt", acceptedAt, RAND),
      type: "plan_accepted",
      source: "hermes",
      actor: "user",
      tags: ["plan"],
      related_to: [planId],
    },
    body: `Human accepted ${planId}`,
  }, acceptedAt);
  return planId;
}

function typesOf(all: GovEvent[]): string[] {
  return all.map((e) => e.frontmatter.type);
}

describe("autoDispatch", () => {
  it("off mode refuses and emits nothing", async () => {
    await seedAcceptedPlan(["a", "b"]);
    const before = (await readAllEvents(ws)).length;
    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "off", at(), RAND);

    expect(summary).toEqual({ executed: 0, failed: 0, denied: 0, skipped: 0 });
    expect((await readAllEvents(ws)).length).toBe(before);
  });

  it("type2 advances an accepted plan one step and records the dispatch trail", async () => {
    await seedAcceptedPlan(["a", "b"]);
    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.executed).toBe(1);
    const t = typesOf(await readAllEvents(ws));
    expect(t).toContain("instruction_planned");
    expect(t).toContain("orchestrator_action_executed");
    expect(t).toContain("task_created");
    expect(t).toContain("session_spawned");
    expect(t).toContain("task_started");
  });

  it("idempotently avoids rematerializing an in-flight step on a second pass", async () => {
    await seedAcceptedPlan(["a", "b"]);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    const boundBefore = (await readAllEvents(ws)).filter((e) => e.frontmatter.type === "step_bound").length;

    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.executed).toBe(0);
    expect(summary.denied).toBe(1);
    const boundAfter = (await readAllEvents(ws)).filter((e) => e.frontmatter.type === "step_bound").length;
    expect(boundAfter).toBe(boundBefore);
  });

  it("does not let orphan instruction_planned poison a step before step_bound materializes", async () => {
    const planId = await seedAcceptedPlan(["a", "b"]);
    const plannedAt = at();
    await seed({
      frontmatter: {
        id: generateId("evt", plannedAt, RAND),
        type: "instruction_planned",
        source: "system",
        actor: "system",
        tags: ["orchestrator", "dispatch"],
        related_to: [planId],
      },
      body: JSON.stringify({ planId, stepIndex: 0 }),
    }, plannedAt);

    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.executed).toBe(1);
    expect((await readAllEvents(ws)).some((e) => e.frontmatter.type === "step_bound")).toBe(true);
  });

  it("denies a fully-conducted plan with done rather than in_flight", async () => {
    await seedAcceptedPlan(["a"]);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    const taskId = (await readAllEvents(ws)).find((e) => e.frontmatter.type === "task_created")!.frontmatter.id;
    const completedAt = later();
    await seed({
      frontmatter: {
        id: generateId("evt", completedAt, RAND),
        type: "task_completed",
        source: "hermes",
        actor: "conductor",
        tags: ["task"],
        related_to: [taskId],
      },
      body: `Completed ${taskId}`,
    }, completedAt);

    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    const reasons = (await readAllEvents(ws))
      .filter((e) => e.frontmatter.type === "action_denied")
      .map((e) => JSON.parse(e.body).reason);
    expect(reasons).toContain("done");
  });

  it("denies a non-accepted plan without conductor events", async () => {
    const when = at();
    const planId = generateId("evt", when, RAND);
    await seed({
      frontmatter: {
        id: planId,
        type: "plan_proposed",
        source: "hermes",
        actor: "planner",
        tags: ["plan"],
        related_to: [],
      },
      body: "intent\n\n1. a",
    }, when);

    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.denied).toBe(1);
    const t = typesOf(await readAllEvents(ws));
    expect(t).toContain("action_denied");
    expect(t).not.toContain("session_spawned");
  });

  it("NEGATIVE #1: a full pass writes zero decision_* events", async () => {
    await seedAcceptedPlan(["a"]);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    const t = typesOf(await readAllEvents(ws));
    expect(t.filter((x) => x.startsWith("decision_"))).toEqual([]);
  });

  it("HALT-NO-RESOLVE: an open decision_blocked denies with halted and writes no decision_*", async () => {
    await seedAcceptedPlan(["a", "b"]);
    await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);
    const taskId = (await readAllEvents(ws)).find((e) => e.frontmatter.type === "task_created")!.frontmatter.id;
    const blockedAt = later();
    await seed({
      frontmatter: {
        id: generateId("evt", blockedAt, RAND),
        type: "decision_blocked",
        source: "agent_run",
        actor: "agent_run",
        tags: ["type0"],
        related_to: ["dec_x", taskId],
      },
      body: "needs a human",
    }, blockedAt);
    const before = (await readAllEvents(ws)).length;

    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.denied).toBe(1);
    const after = await readAllEvents(ws);
    expect(after.length).toBe(before + 1);
    const denials = after.filter((e) => e.frontmatter.type === "action_denied").map((e) => JSON.parse(e.body));
    expect(denials).toContainEqual(expect.objectContaining({ reason: "halted" }));
    expect(typesOf(after).filter((x) => x.startsWith("decision_")).sort()).toEqual(["decision_blocked"]);
  });

  it("turns a conductPlan adapter throw into orchestrator_action_failed and keeps going", async () => {
    await seedAcceptedPlan(["a"]);
    const throwingAdapter: ConductorAdapter = {
      createWorktree: async () => {
        throw new Error("worktree boom");
      },
      spawnSession: async () => ({ surface: "stub" }),
      writeEnvelopeFile: async () => {},
    };

    const summary = await autoDispatch(ws, { adapter: throwingAdapter }, "type2", at(), RAND);

    expect(summary.failed).toBe(1);
    expect(summary.executed).toBe(0);
    const t = typesOf(await readAllEvents(ws));
    expect(t).toContain("orchestrator_action_failed");
    expect(t).not.toContain("orchestrator_action_executed");
  });

  it("advances two plans in one pass without event id collisions", async () => {
    await seedAcceptedPlan(["a"]);
    await seedAcceptedPlan(["b"]);

    const summary = await autoDispatch(ws, { adapter: stubAdapter }, "type2", at(), RAND);

    expect(summary.executed).toBe(2);
    const ids = (await readAllEvents(ws)).map((e) => e.frontmatter.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("INVARIANT #1 — structural", () => {
  it("the dispatcher module imports zero decision write handlers", () => {
    const src = readFileSync(new URL("../../../src/orchestrator/dispatch/dispatch.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/decision\/handlers/);
  });

  it("the opt-in flag cannot touch the approval gate", () => {
    const unreviewed = { verdict: null, reviewed: false, phase: "proposed", title: "x" } as Parameters<typeof canApprove>[0];
    expect(canApprove(unreviewed).ok).toBe(false);
    expect(canApprove.length).toBe(1);
  });
});
