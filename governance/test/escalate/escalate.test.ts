import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escalate } from "../../src/escalate/escalate.js";
import { readAllEvents, eventsForDecision } from "../../src/decision/readEvents.js";
import { parseToken } from "../../src/escalate/token.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "boule-esc-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

describe("escalate — Type 0 emission", () => {
  it("mints a decision_proposed + decision_blocked and binds tokens to both ids", async () => {
    const r = await escalate(
      ws,
      { question: "DB: sqlite or postgres?", options: [{ label: "sqlite" }, { label: "postgres" }], ambiguityKind: "architecture" },
      new Date("2026-06-01T10:00:00Z"),
      0.5,
    );
    expect(r.decisionId).toMatch(/^evt_/);
    expect(r.blockedEventId).toMatch(/^evt_/);
    expect(r.decisionId).not.toBe(r.blockedEventId);
    expect(r.options).toHaveLength(2);

    for (const o of r.options) {
      const parsed = parseToken(o.reply);
      expect(parsed).not.toBeNull();
      expect(parsed!.decisionId).toBe(r.decisionId);
      expect(parsed!.blockedEventId).toBe(r.blockedEventId);
    }
    expect(r.options.map((o) => o.token)).toEqual(["opt0", "opt1"]);

    const grp = eventsForDecision(await readAllEvents(ws), r.decisionId);
    expect(grp.proposal?.frontmatter.type).toBe("decision_proposed");
    expect(grp.proposal?.frontmatter.tags).toContain("type0");
    const blocked = grp.related.find((e) => e.frontmatter.type === "decision_blocked");
    expect(blocked).toBeDefined();
    expect(blocked!.frontmatter.related_to).toContain(r.decisionId);
    expect(blocked!.frontmatter.tags).toContain("ambiguity:architecture");
    const body = JSON.parse(blocked!.body);
    expect(body.options.map((x: { token: string }) => x.token)).toEqual(["opt0", "opt1"]);
  });

  it("rejects fewer than two options", async () => {
    await expect(
      escalate(ws, { question: "q?", options: [{ label: "only" }] }, new Date("2026-06-01T10:00:00Z"), 0.5),
    ).rejects.toThrow(/two options/);
  });
});
