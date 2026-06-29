import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proposePlan, acceptPlan } from "../../src/plan/handlers.js";
import { conductPlan, resumeChosenEscalation } from "../../src/conductor/handlers.js";
import { stubAdapter } from "../../src/conductor/adapter.js";
import { escalate } from "../../src/escalate/escalate.js";
import { chooseOption } from "../../src/decision/handlers.js";
import { readAllEvents } from "../../src/decision/readEvents.js";
import { writeEvent } from "../../src/event/writeEvent.js";
import { generateId } from "../../src/event/id.js";
import type { GovEvent } from "../../src/event/event.js";

let dir: string;
const at = (s: number) => new Date(Date.UTC(2026, 5, 10, 12, 0, s));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boule-resume-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Materialize step 0 of a one-step plan (active task + spawned session) via the stub adapter. */
async function activeStep(base = 0) {
  const { planId } = await proposePlan(dir, { intent: "I", steps: ["step a"] }, at(base), 0.1);
  await acceptPlan(dir, { planId }, at(base + 1), 0.2);
  const r = await conductPlan(dir, { planId }, { adapter: stubAdapter }, at(base + 10), 0.3);
  const all = await readAllEvents(dir);
  const session = all.find((e) => e.frontmatter.type === "session_spawned")!;
  return { planId, taskId: r.advanced!.taskId, sessionId: session.frontmatter.id };
}

async function crashSession(sessionId: string, second: number): Promise<void> {
  const evt: GovEvent = {
    frontmatter: {
      id: generateId("evt", at(second), 0.5),
      type: "session_crashed",
      source: "system",
      actor: "observer",
      tags: ["session"],
      related_to: [sessionId],
    },
    body: "crashed",
  };
  await writeEvent(dir, evt, at(second));
}

/** Escalate bound to the task, then resolve it as a human would. */
async function escalateAndChoose(taskId: string, second: number) {
  const esc = await escalate(
    dir,
    {
      question: "Which helper is canonical?",
      options: [{ label: "Use weeklyLifeWheel" }, { label: "Use weeklyScore" }],
      relatedTaskId: taskId,
    },
    at(second),
    0.4,
  );
  const choice = await chooseOption(
    dir,
    { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" },
    at(second + 5),
    0.6,
  );
  return { esc, choice };
}

describe("resumeChosenEscalation — post-choose re-dispatch", () => {
  it("re-dispatches the step with the chosen decision after escalate→close→choose", async () => {
    const { planId, taskId, sessionId } = await activeStep();
    await escalateAndChoose(taskId, 20);
    await crashSession(sessionId, 30);

    const r = await resumeChosenEscalation(dir, { planId }, { adapter: stubAdapter }, at(40), 0.7);

    expect(r.kind).toBe("advanced");
    if (r.kind !== "advanced") return;
    expect(r.advanced.taskId).toBe(taskId);
    expect(r.advanced.attemptIndex).toBe(1); // conduct started attempt 0; resume is attempt 1
    const all = await readAllEvents(dir);
    const resumes = all.filter(
      (e) => e.frontmatter.type === "session_spawned" && e.frontmatter.tags?.includes("resume"),
    );
    expect(resumes).toHaveLength(1);
    // The resumed session's prompt (in the envelope file write path) carries the decision context.
    const body = JSON.parse(resumes[0]!.body) as { envelope: { taskId: string } };
    expect(body.envelope.taskId).toBe(taskId);
  });

  it("consumes a resolution exactly once — the second pass is a no_action", async () => {
    const { planId, taskId, sessionId } = await activeStep();
    await escalateAndChoose(taskId, 20);
    await crashSession(sessionId, 30);

    const first = await resumeChosenEscalation(dir, { planId }, { adapter: stubAdapter }, at(40), 0.7);
    expect(first.kind).toBe("advanced");
    // The resumed session is LIVE (not terminal) and its spawn is newer than the chosen.
    const second = await resumeChosenEscalation(dir, { planId }, { adapter: stubAdapter }, at(50), 0.8);
    expect(second.kind).toBe("no_action");
  });

  it("does NOT resume while the fork is still open (no decision_chosen → halted)", async () => {
    const { planId, taskId, sessionId } = await activeStep();
    await escalate(
      dir,
      { question: "open fork", options: [{ label: "A" }, { label: "B" }], relatedTaskId: taskId },
      at(20),
      0.4,
    );
    await crashSession(sessionId, 30);

    const r = await resumeChosenEscalation(dir, { planId }, { adapter: stubAdapter }, at(40), 0.7);
    expect(r.kind).toBe("no_action");
  });

  it("does NOT resume beside a live session (latest session not terminal)", async () => {
    const { planId, taskId } = await activeStep();
    await escalateAndChoose(taskId, 20);
    // session never crashed/closed — still live

    const r = await resumeChosenEscalation(dir, { planId }, { adapter: stubAdapter }, at(40), 0.7);
    expect(r.kind).toBe("no_action");
  });

  it("consume-once survives a SAME-SECOND chosen↔resume-spawn collision (decision-keyed marker)", async () => {
    const { planId, taskId, sessionId } = await activeStep();
    await crashSession(sessionId, 30);
    // choose lands at t=40 — the SAME second the resume below spawns at, so the event-id ordering
    // between chosen and the resume session_spawned is arbitrary (second-granular ids). The
    // decision-keyed marker, not id ordering, must block the second resume.
    const esc = await escalate(
      dir,
      { question: "collide", options: [{ label: "A" }, { label: "B" }], relatedTaskId: taskId },
      at(35),
      0.4,
    );
    await chooseOption(
      dir,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt1" },
      at(40),
      0.9, // rand suffix ABOVE the resume spawn's 0.7 → chosen.id > spawn.id under pure id-ordering
    );

    const first = await resumeChosenEscalation(dir, { planId }, { adapter: stubAdapter }, at(40), 0.7);
    expect(first.kind).toBe("advanced");
    // Force the worst case for the legacy id filter: crash the resumed session in the same second
    // so the live-session guard cannot mask a double-resume either.
    const all = await readAllEvents(dir);
    const resumeSpawn = all.find(
      (e) => e.frontmatter.type === "session_spawned" && e.frontmatter.tags?.includes("resume"),
    )!;
    expect(resumeSpawn.frontmatter.related_to).toContain(esc.decisionId);
    await crashSession(resumeSpawn.frontmatter.id, 40);

    const second = await resumeChosenEscalation(dir, { planId }, { adapter: stubAdapter }, at(41), 0.8);
    expect(second.kind).toBe("no_action");
  });

  it("resumes an unresolved choice even when its event id predates the latest spawn", async () => {
    const { planId, taskId, sessionId } = await activeStep(0);
    // Resolve a fork BEFORE this (latest) spawn existed — simulate by choosing at t=2 (< spawn t=10).
    const esc = await escalate(
      dir,
      { question: "early fork", options: [{ label: "A" }, { label: "B" }], relatedTaskId: taskId },
      at(1),
      0.4,
    );
    await chooseOption(
      dir,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" },
      at(2),
      0.6,
    );
    await crashSession(sessionId, 30);

    const r = await resumeChosenEscalation(dir, { planId }, { adapter: stubAdapter }, at(40), 0.7);
    expect(r.kind).toBe("advanced");
    const all = await readAllEvents(dir);
    const resumes = all.filter(
      (e) => e.frontmatter.type === "session_spawned" && e.frontmatter.tags?.includes("resume"),
    );
    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.frontmatter.related_to).toContain(esc.decisionId);
  });
});
