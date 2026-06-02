import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalate } from "../../src/escalate/escalate.js";
import { chooseOption } from "../../src/decision/handlers.js";
import { pendingEscalations } from "../../src/escalate/pending.js";
import { parseToken } from "../../src/escalate/token.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-pending-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("pendingEscalations", () => {
  it("lists an unresolved escalation with bound reply tokens", async () => {
    const esc = await escalate(
      ws,
      { question: "DB: sqlite or postgres?", options: [{ label: "sqlite" }, { label: "postgres" }] },
      new Date("2026-06-02T10:00:00Z"),
      0.5,
    );
    const pending = await pendingEscalations(ws);
    expect(pending).toHaveLength(1);
    const p = pending[0];
    expect(p.decisionId).toBe(esc.decisionId);
    expect(p.blockedEventId).toBe(esc.blockedEventId);
    expect(p.question).toBe("DB: sqlite or postgres?");
    expect(p.options.map((o) => o.token)).toEqual(["opt0", "opt1"]);
    const parsed = parseToken(p.options[0].reply);
    expect(parsed!.decisionId).toBe(esc.decisionId);
    expect(parsed!.blockedEventId).toBe(esc.blockedEventId);
  });

  it("omits an escalation once it is chosen (no re-send on next sync)", async () => {
    const esc = await escalate(
      ws,
      { question: "q?", options: [{ label: "a" }, { label: "b" }] },
      new Date("2026-06-02T10:00:00Z"),
      0.5,
    );
    await chooseOption(
      ws,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt0" },
      new Date("2026-06-02T10:05:00Z"),
      0.5,
    );
    expect(await pendingEscalations(ws)).toHaveLength(0);
  });

  it("surfaces the escalating session id (null for a manual/user escalate)", async () => {
    await escalate(
      ws,
      { question: "manual?", options: [{ label: "a" }, { label: "b" }] },
      new Date("2026-06-02T10:00:00Z"),
      0.5,
    );
    expect((await pendingEscalations(ws))[0].sessionId).toBeNull();
  });

  it("surfaces the agent recommendation when one was given (null otherwise)", async () => {
    await escalate(
      ws,
      {
        question: "rec?",
        options: [{ label: "a" }, { label: "b" }],
        agentRecommendation: "prefer a",
      },
      new Date("2026-06-02T10:00:00Z"),
      0.5,
    );
    expect((await pendingEscalations(ws))[0].agentRecommendation).toBe("prefer a");
  });
});
