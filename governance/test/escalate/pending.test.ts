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
    // within the 72h TTL of the 2026-06-02 escalation (pendingEscalations defaults `now` to
    // wall-clock + filters expired blocks, so the test must pin time to stay deterministic).
    const pending = await pendingEscalations(ws, new Date("2026-06-02T10:05:00Z"));
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
    // within TTL → proves removal is due to the choose, not TTL expiry.
    expect(await pendingEscalations(ws, new Date("2026-06-02T10:06:00Z"))).toHaveLength(0);
  });

  it("surfaces the escalating session id (null for a manual/user escalate)", async () => {
    await escalate(
      ws,
      { question: "manual?", options: [{ label: "a" }, { label: "b" }] },
      new Date("2026-06-02T10:00:00Z"),
      0.5,
    );
    expect((await pendingEscalations(ws, new Date("2026-06-02T10:05:00Z")))[0].sessionId).toBeNull();
  });

  it("keeps an expired escalation LISTED with expired:true (the halt persists — hiding it was the bug)", async () => {
    const created = new Date("2026-06-02T10:00:00Z");
    await escalate(
      ws,
      { question: "stale?", options: [{ label: "a" }, { label: "b" }], ttlHours: 24 },
      created,
      0.5,
    );
    // 23h later — within TTL → pending, NOT expired
    const fresh = await pendingEscalations(ws, new Date("2026-06-03T09:00:00Z"));
    expect(fresh).toHaveLength(1);
    expect(fresh[0].expired).toBe(false);
    expect(fresh[0].expiredAt).toBeNull();
    // 48h later — past TTL → STILL listed, flagged expired (+ the expiry stamp). The unresolved
    // decision_blocked keeps its plan halted, so the operator list must keep showing it (P3d).
    const stale = await pendingEscalations(ws, new Date("2026-06-04T10:00:00Z"));
    expect(stale).toHaveLength(1);
    expect(stale[0].expired).toBe(true);
    // escalate stamps expires = blocked-event time (created+1s) + ttl
    expect(stale[0].expiredAt).toBe("2026-06-03T10:00:01.000Z");
  });

  it("a chosen escalation stays omitted even after its TTL (resolution, not expiry, removes entries)", async () => {
    const esc = await escalate(
      ws,
      { question: "q?", options: [{ label: "a" }, { label: "b" }], ttlHours: 24 },
      new Date("2026-06-02T10:00:00Z"),
      0.5,
    );
    await chooseOption(
      ws,
      { decisionId: esc.decisionId, blockedEventId: esc.blockedEventId, optionToken: "opt1" },
      new Date("2026-06-02T10:05:00Z"),
      0.5,
    );
    expect(await pendingEscalations(ws, new Date("2026-06-05T10:00:00Z"))).toHaveLength(0);
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
    expect(
      (await pendingEscalations(ws, new Date("2026-06-02T10:05:00Z")))[0].agentRecommendation,
    ).toBe("prefer a");
  });
});
