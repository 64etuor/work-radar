import { describe, it, expect } from "vitest";
import {
  buildEnvelope,
  canonicalEnvelopeJson,
  envelopeHash,
  DEFAULT_FORBIDDEN_DECISION_CLASSES,
} from "../../src/conductor/envelope.js";

const base = { planId: "evt_p1", stepIndex: 0, taskId: "evt_t0", worktreePath: "/wt/step0" };

describe("buildEnvelope", () => {
  it("populates required fields + escalateOnAnyBoundaryCrossing literal true", () => {
    const env = buildEnvelope(base);
    expect(env.planId).toBe("evt_p1");
    expect(env.stepIndex).toBe(0);
    expect(env.taskId).toBe("evt_t0");
    expect(env.worktreePath).toBe("/wt/step0");
    expect(env.escalateOnAnyBoundaryCrossing).toBe(true);
    expect(env.forbiddenDecisionClasses).toEqual(DEFAULT_FORBIDDEN_DECISION_CLASSES);
    expect(env.allowedPathGlobs.length).toBeGreaterThan(0);
  });

  it("honors explicit advisory overrides", () => {
    const env = buildEnvelope({ ...base, allowedPathGlobs: ["src/**"], allowedType2Actions: ["edit"] });
    expect(env.allowedPathGlobs).toEqual(["src/**"]);
    expect(env.allowedType2Actions).toEqual(["edit"]);
  });
});

describe("canonical JSON + hash", () => {
  it("canonical JSON has top-level keys in sorted order (stable regardless of construction order)", () => {
    const env = buildEnvelope(base);
    const json = canonicalEnvelopeJson(env);
    const keys = Object.keys(JSON.parse(json));
    expect(keys).toEqual([...keys].sort());
  });

  it("hash is deterministic for the same envelope", () => {
    const h1 = envelopeHash(buildEnvelope(base));
    const h2 = envelopeHash(buildEnvelope(base));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hash changes when a field changes (tamper-evident)", () => {
    const h1 = envelopeHash(buildEnvelope(base));
    const h2 = envelopeHash(buildEnvelope({ ...base, worktreePath: "/wt/step1" }));
    expect(h1).not.toBe(h2);
  });
});
