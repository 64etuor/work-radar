import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalate } from "../../src/escalate/escalate.js";
import { chooseOption, why, approve, requestReview } from "../../src/decision/handlers.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-choose-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("chooseOption — Type 0 human resolution", () => {
  it("resolves a Type 0 to chosen and lands an actor:user decision_chosen", async () => {
    const esc = await escalate(
      ws,
      { question: "DB: sqlite or postgres?", options: [{ label: "sqlite" }, { label: "postgres" }] },
      new Date("2026-06-01T10:00:00Z"),
      0.5,
    );
    const r = await chooseOption(
      ws,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" },
      new Date("2026-06-01T10:05:00Z"),
      0.5,
    );
    expect(r.ok).toBe(true);
    expect(r.chosenOption).toBe("opt0");

    const trail = await why(ws, { decisionId: esc.decisionId });
    expect(trail.phase).toBe("chosen");
    const types = trail.chain.map((c) => c.type);
    expect(types).toContain("decision_blocked");
    expect(types).toContain("decision_chosen");
    const chosen = trail.chain.find((c) => c.type === "decision_chosen");
    expect(chosen?.actor).toBe("user");
  });

  it("double-tap is an idempotent friendly no-op (no second decision_chosen)", async () => {
    const esc = await escalate(
      ws,
      { question: "q?", options: [{ label: "a" }, { label: "b" }] },
      new Date("2026-06-01T10:00:00Z"),
      0.5,
    );
    const first = await chooseOption(
      ws,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" },
      new Date("2026-06-01T10:05:00Z"),
      0.5,
    );
    expect(first.ok).toBe(true);
    const second = await chooseOption(
      ws,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt1" },
      new Date("2026-06-01T10:06:00Z"),
      0.5,
    );
    expect(second.ok).toBe(false);
    expect(second.reason).toMatch(/already chosen/);
    expect(second.reason).toMatch(/opt0/); // names the option that actually won
    expect(second.chosenOption).toBe("opt0");
    const trail = await why(ws, { decisionId: esc.decisionId });
    expect(trail.chain.filter((c) => c.type === "decision_chosen")).toHaveLength(1);
  });

  it("re-tapping the SAME option (redelivery) is a friendly idempotent ok, not an error", async () => {
    const esc = await escalate(
      ws,
      { question: "q?", options: [{ label: "a" }, { label: "b" }] },
      new Date("2026-06-01T10:00:00Z"),
      0.5,
    );
    const tap = { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" };
    const first = await chooseOption(ws, tap, new Date("2026-06-01T10:05:00Z"), 0.5);
    expect(first.ok).toBe(true);
    expect(first.idempotent ?? false).toBe(false); // the fresh choice is not idempotent

    const redelivered = await chooseOption(ws, tap, new Date("2026-06-01T10:05:30Z"), 0.5);
    expect(redelivered.ok).toBe(true); // friendly, NOT an "already chosen" error
    expect(redelivered.idempotent).toBe(true);
    expect(redelivered.chosenOption).toBe("opt0");

    const trail = await why(ws, { decisionId: esc.decisionId });
    expect(trail.chain.filter((c) => c.type === "decision_chosen")).toHaveLength(1); // still no 2nd event
  });

  it("refuses a tap whose blockedEventId or option does not belong to the decision (binding guard)", async () => {
    const esc = await escalate(
      ws,
      { question: "q?", options: [{ label: "a" }, { label: "b" }] },
      new Date("2026-06-01T10:00:00Z"),
      0.5,
    );
    const stamp = new Date("2026-06-01T10:05:00Z");
    // fabricated option token
    const badOpt = await chooseOption(ws, { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt99" }, stamp, 0.5);
    expect(badOpt.ok).toBe(false);
    expect(badOpt.reason).toMatch(/unknown option token/);
    // mismatched blocked event id
    const badBlocked = await chooseOption(ws, { decisionId: esc.decisionId, blockedEventId: "evt_does_not_exist", optionToken: "opt0" }, stamp, 0.5);
    expect(badBlocked.ok).toBe(false);
    expect(badBlocked.reason).toMatch(/does not belong/);
    // a real, bound tap still resolves
    const good = await chooseOption(ws, { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" }, stamp, 0.5);
    expect(good.ok).toBe(true);
  });

  it("a chosen Type 0 is terminal — approve and request_review refuse it", async () => {
    const esc = await escalate(
      ws,
      { question: "q?", options: [{ label: "a" }, { label: "b" }] },
      new Date("2026-06-01T10:00:00Z"),
      0.5,
    );
    await chooseOption(ws, { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" }, new Date("2026-06-01T10:05:00Z"), 0.5);
    const a = await approve(ws, { decisionId: esc.decisionId }, new Date("2026-06-01T10:06:00Z"), 0.5);
    expect(a.ok).toBe(false);
    expect(a.reason).toMatch(/already chosen/);
    await expect(
      requestReview(ws, { decisionId: esc.decisionId, authorModel: "claude" }, [], new Date("2026-06-01T10:07:00Z"), 0.5),
    ).rejects.toThrow(/already chosen/);
  });
});
