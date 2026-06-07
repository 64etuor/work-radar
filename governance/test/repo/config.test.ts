import { describe, it, expect } from "vitest";
import {
  parseBouleConfig,
  resolvePolicy,
  serializeConfig,
  policyEnv,
  defaultConfig,
  STRICT_FALLBACK_POLICY,
} from "../../src/repo/config.js";
import { boulePaths, GITIGNORE_LINES } from "../../src/repo/paths.js";

describe("parseBouleConfig — strict, fail-closed validation", () => {
  it("accepts a minimal valid config", () => {
    const c = parseBouleConfig({ schemaVersion: 1, kind: "work" });
    expect(c.kind).toBe("work");
  });

  it("rejects unknown top-level fields", () => {
    expect(() => parseBouleConfig({ schemaVersion: 1, kind: "work", bogus: 1 })).toThrow();
  });

  it("rejects an unknown kind", () => {
    expect(() => parseBouleConfig({ schemaVersion: 1, kind: "team" })).toThrow();
  });

  it("rejects unknown override fields and bad decision classes", () => {
    expect(() =>
      parseBouleConfig({ schemaVersion: 1, kind: "work", overrides: { nope: true } }),
    ).toThrow();
    expect(() =>
      parseBouleConfig({
        schemaVersion: 1,
        kind: "work",
        overrides: { forbiddenDecisionClasses: ["made-up"] },
      }),
    ).toThrow();
  });

  it("rejects reviewQuorum < 1", () => {
    expect(() =>
      parseBouleConfig({ schemaVersion: 1, kind: "personal", overrides: { reviewQuorum: 0 } }),
    ).toThrow();
  });
});

describe("resolvePolicy — per-kind defaults + override precedence", () => {
  it("work = strict defaults (manual autonomy → auto off, quorum 2, full forbidden set)", () => {
    const p = resolvePolicy(defaultConfig("work"));
    expect(p.autonomyLevel).toBe("manual");
    expect(p.autoMode).toBe("off");
    expect(p.reviewQuorum).toBe(2);
    expect(p.forbiddenDecisionClasses).toContain("dependency");
    expect(p.forbiddenDecisionClasses).toContain("product-behavior");
  });

  it("personal = loose defaults (dispatch autonomy → auto type2, quorum 1, narrower forbidden set)", () => {
    const p = resolvePolicy(defaultConfig("personal"));
    expect(p.autonomyLevel).toBe("dispatch");
    expect(p.autoMode).toBe("type2");
    expect(p.reviewQuorum).toBe(1);
    expect(p.forbiddenDecisionClasses).not.toContain("dependency");
    expect(p.forbiddenDecisionClasses).not.toContain("product-behavior");
    expect(p.forbiddenDecisionClasses).toContain("security"); // irreversible classes still escalate
    expect(p.allowedType2Actions).toContain("refactor");
  });

  it("overrides win field-by-field over the kind default", () => {
    const p = resolvePolicy({
      schemaVersion: 1,
      kind: "personal",
      overrides: { autonomyLevel: "manual", reviewQuorum: 3 },
    });
    expect(p.autonomyLevel).toBe("manual"); // overridden (personal default is dispatch)
    expect(p.autoMode).toBe("off"); // derived from the manual level
    expect(p.reviewQuorum).toBe(3); // overridden
    expect(p.allowedType2Actions).toContain("refactor"); // untouched personal default
  });

  it("STRICT_FALLBACK_POLICY equals the work default (fail-closed direction)", () => {
    expect(STRICT_FALLBACK_POLICY.autoMode).toBe("off");
    expect(STRICT_FALLBACK_POLICY.autonomyLevel).toBe("manual");
    expect(STRICT_FALLBACK_POLICY.reviewQuorum).toBe(2);
    expect(STRICT_FALLBACK_POLICY.kind).toBe("work");
  });

  it("autonomyLevel override derives autoMode (dispatch+ ⇒ type2) and is the autonomy master", () => {
    const full = resolvePolicy({
      schemaVersion: 1,
      kind: "work", // work default is manual, but the override opens it
      overrides: { autonomyLevel: "full" },
    });
    expect(full.autonomyLevel).toBe("full");
    expect(full.autoMode).toBe("type2"); // derived from the level — no separate autoMode override
    const ap = resolvePolicy({ schemaVersion: 1, kind: "work", overrides: { autonomyLevel: "auto_plan" } });
    expect(ap.autonomyLevel).toBe("auto_plan");
    expect(ap.autoMode).toBe("type2");
    // manual override forces dispatch off even for personal
    const m = resolvePolicy({ schemaVersion: 1, kind: "personal", overrides: { autonomyLevel: "manual" } });
    expect(m.autoMode).toBe("off");
  });
});

describe("policyEnv — single policy→env mapping", () => {
  it("maps policy + dirs to the server env (arrays as comma lists)", () => {
    const env = policyEnv(resolvePolicy(defaultConfig("personal")), {
      repoRoot: "/r",
      workspace: "/r/.boule/workspace",
      worktrees: "/r/.boule/worktrees",
    });
    expect(env.BOULE_WORKSPACE).toBe("/r/.boule/workspace");
    expect(env.BOULE_REPO_ROOT).toBe("/r");
    expect(env.BOULE_CONDUCTOR_WORKTREES_ROOT).toBe("/r/.boule/worktrees");
    expect(env.BOULE_AUTO_MODE).toBe("type2");
    expect(env.BOULE_REVIEW_QUORUM).toBe("1");
    expect(env.BOULE_ENVELOPE_FORBIDDEN_CLASSES).toContain("security");
    expect(env.BOULE_ENVELOPE_ALLOWED_TYPE2).toContain("refactor");
  });
});

describe("serializeConfig + paths", () => {
  it("serializes with sorted keys + trailing newline (round-trips through parse)", () => {
    const c = defaultConfig("work", { projectId: "p1", projectName: "Acme" });
    const text = serializeConfig(c);
    expect(text.endsWith("\n")).toBe(true);
    expect(parseBouleConfig(JSON.parse(text))).toEqual(c);
  });

  it("boulePaths computes the .boule layout", () => {
    const p = boulePaths("/repo");
    expect(p.config).toBe("/repo/.boule/boule.config.json");
    expect(p.workspace).toBe("/repo/.boule/workspace");
    expect(p.worktrees).toBe("/repo/.boule/worktrees");
    expect(p.mcp).toBe("/repo/.boule/mcp.json");
    expect(GITIGNORE_LINES).toContain(".boule/workspace/");
    expect(GITIGNORE_LINES).not.toContain(".boule/boule.config.json"); // config stays committed
  });
});
