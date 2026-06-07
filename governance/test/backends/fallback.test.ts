import { describe, it, expect } from "vitest";

import {
  backendsConfigSchema,
  backendSpecSchema,
  assertProviderAllowed,
} from "../../src/backends/config.js";
import {
  classifyAttempt,
  exhaustedTerminal,
  runWithFallback,
  type AttemptError,
} from "../../src/backends/fallback.js";

describe("backendsConfigSchema", () => {
  it("accepts per-role chains incl. an array of reviewer chains", () => {
    const cfg = backendsConfigSchema.parse({
      executor: { chain: [{ provider: "claude" }, { provider: "codex" }] },
      reviewers: [{ chain: [{ provider: "claude", model: "opus" }] }, { chain: [{ provider: "codex" }] }],
      evaluator: { chain: [{ provider: "codex" }, { provider: "deterministic" }] },
    });
    expect(cfg.executor?.chain).toHaveLength(2);
    expect(cfg.reviewers).toHaveLength(2);
  });

  it("rejects unknown fields and empty chains", () => {
    expect(() => backendsConfigSchema.parse({ executor: { chain: [] } })).toThrow();
    expect(() => backendsConfigSchema.parse({ bogus: 1 })).toThrow();
  });

  it("requires a command for provider 'command'", () => {
    expect(() => backendSpecSchema.parse({ provider: "command" })).toThrow();
    expect(backendSpecSchema.parse({ provider: "command", command: "gemini" }).command).toBe("gemini");
  });
});

describe("assertProviderAllowed", () => {
  it("rejects deterministic for executor/reviewer, allows it for evaluator", () => {
    expect(() => assertProviderAllowed("executor", { provider: "deterministic" })).toThrow();
    expect(() => assertProviderAllowed("reviewer", { provider: "deterministic" })).toThrow();
    expect(() => assertProviderAllowed("evaluator", { provider: "deterministic" })).not.toThrow();
  });
});

describe("classifyAttempt", () => {
  it("maps clean exit to ok", () => {
    expect(classifyAttempt(0, "")).toBe("ok");
  });
  it("maps token/quota signatures to token_exhausted", () => {
    for (const s of ["Usage limit reached", "insufficient_quota", "HTTP 429", "credit balance too low"]) {
      expect(classifyAttempt(1, s)).toEqual({ kind: "token_exhausted" });
    }
  });
  it("maps network/timeout (or null exit) to transient", () => {
    expect(classifyAttempt(1, "ETIMEDOUT")).toEqual({ kind: "transient" });
    expect(classifyAttempt(null, "killed")).toEqual({ kind: "transient" });
  });
  it("maps unknown non-zero exit to fatal (fail-closed, not assumed retryable)", () => {
    const r = classifyAttempt(2, "command not found: gemini");
    expect(r).toMatchObject({ kind: "fatal" });
  });
});

describe("exhaustedTerminal", () => {
  it("is fail-closed per role — never approve/complete", () => {
    expect(exhaustedTerminal("executor")).toEqual({ role: "executor", outcome: "stall" });
    expect(exhaustedTerminal("reviewer")).toEqual({ role: "reviewer", outcome: "blocked" });
    expect(exhaustedTerminal("evaluator")).toEqual({ role: "evaluator", outcome: "needs_human" });
  });
});

describe("runWithFallback", () => {
  const tokenOut: AttemptError = { kind: "token_exhausted" };

  it("returns the first success and the backend that produced it", async () => {
    const tried: string[] = [];
    const r = await runWithFallback("evaluator", [{ provider: "codex" }, { provider: "claude" }], async (spec) => {
      tried.push(spec.provider);
      return spec.provider === "claude" ? { ok: true, value: "done" } : { ok: false, error: tokenOut };
    });
    expect(r).toMatchObject({ ok: true, value: "done", via: { provider: "claude" } });
    expect(tried).toEqual(["codex", "claude"]); // advanced past the exhausted codex
  });

  it("exhausted chain → role-correct fail-closed terminal (never auto-complete)", async () => {
    const r = await runWithFallback(
      "evaluator",
      [{ provider: "codex" }, { provider: "claude" }],
      async () => ({ ok: false, error: tokenOut }),
    );
    expect(r).toEqual({ ok: false, terminal: { role: "evaluator", outcome: "needs_human" } });
  });

  it("reviewer chain exhausted → blocked (never auto-approve)", async () => {
    const r = await runWithFallback("reviewer", [{ provider: "claude" }], async () => ({
      ok: false,
      error: tokenOut,
    }));
    expect(r).toEqual({ ok: false, terminal: { role: "reviewer", outcome: "blocked" } });
  });

  it("a fatal error stops the chain early but still terminates fail-closed", async () => {
    const tried: string[] = [];
    const r = await runWithFallback(
      "executor",
      [{ provider: "codex" }, { provider: "claude" }],
      async (spec) => {
        tried.push(spec.provider);
        return { ok: false, error: { kind: "fatal", detail: "boom" } };
      },
    );
    expect(tried).toEqual(["codex"]); // did not waste the second rung
    expect(r).toEqual({ ok: false, terminal: { role: "executor", outcome: "stall" } });
  });

  it("rejects a deterministic rung in a non-evaluator chain", async () => {
    await expect(
      runWithFallback("executor", [{ provider: "deterministic" }], async () => ({ ok: true, value: 1 })),
    ).rejects.toThrow(/deterministic/);
  });
});
