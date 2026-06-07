import { describe, expect, it } from "vitest";

import type {
  Skill,
  SkillDivergence,
  SkillEnvironment,
  SkillProvider,
  SkillWorkspace,
} from "@/bindings";
import {
  applyEnvOrder,
  buildDivergedLocationLabels,
  buildDivergedPathSet,
  buildInstallProviderOptions,
  buildSkillEnvNav,
  buildSkillWorkspaceNav,
  buildVendorTargets,
  buildWorkspaceHealth,
  envCounts,
  reorderEnv,
  SKILL_PROVIDER_LABEL,
} from "@/lib/skillEnvNav";

function mk(over: Partial<Skill> & { id: string; name: string }): Skill {
  return {
    kind: "in_app_prompt",
    prompt: null,
    binding: null,
    rail: null,
    enabled: true,
    model: null,
    reasoningEffort: null,
    fastMode: false,
    sourcePath: null,
    provider: null,
    tags: [],
    fallbackPrompt: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function env(provider: SkillEnvironment["provider"], present: boolean): SkillEnvironment {
  return { provider, present, skillCount: present ? 1 : 0, rootPath: `/x/${provider}/skills` };
}

describe("buildSkillEnvNav", () => {
  it("전체 + 인앱 프롬프트는 스킬이 없어도 항상 노출한다", () => {
    const nav = buildSkillEnvNav([], undefined);
    expect(nav.map((i) => i.id)).toEqual(["all", "in_app"]);
    expect(nav.find((i) => i.id === "all")!.pinned).toBe(true);
    expect(nav.find((i) => i.id === "in_app")!.pinned).toBe(false);
  });

  it("detect에서 present인 provider만 노출한다(미설치 환경 숨김)", () => {
    const nav = buildSkillEnvNav(
      [],
      [env("claude", true), env("codex", true), env("openclaw", false)],
    );
    expect(nav.map((i) => i.id)).toEqual(["all", "in_app", "provider:claude", "provider:codex"]);
  });

  it("detect가 없어도 목록에 외부 스킬이 있으면 그 provider를 노출한다(graceful)", () => {
    const nav = buildSkillEnvNav(
      [mk({ id: "x", name: "ext", kind: "external", provider: "codex", sourcePath: "/x" })],
      undefined,
    );
    expect(nav.map((i) => i.id)).toContain("provider:codex");
  });

  it("provider는 기본 순서(claude→codex→openclaw→hermes→other)로 노출한다", () => {
    const nav = buildSkillEnvNav([], [env("other", true), env("codex", true), env("claude", true)]);
    expect(nav.filter((i) => i.id.startsWith("provider:")).map((i) => i.label)).toEqual([
      SKILL_PROVIDER_LABEL.claude,
      SKILL_PROVIDER_LABEL.codex,
      SKILL_PROVIDER_LABEL.other,
    ]);
  });
});

describe("applyEnvOrder", () => {
  it("전체(고정)는 항상 선두에 둔다", () => {
    const nav = buildSkillEnvNav([], [env("claude", true), env("codex", true)]);
    const ordered = applyEnvOrder(nav, ["provider:codex", "provider:claude", "in_app"]);
    expect(ordered[0].id).toBe("all");
    expect(ordered.map((i) => i.id)).toEqual([
      "all",
      "provider:codex",
      "provider:claude",
      "in_app",
    ]);
  });

  it("저장 순서에 없는 항목은 기본 순서를 보존하며 뒤로 보낸다", () => {
    const nav = buildSkillEnvNav([], [env("claude", true), env("codex", true)]);
    // codex만 저장됨 → codex 먼저, 나머지(in_app, claude)는 원래 순서 유지.
    const ordered = applyEnvOrder(nav, ["provider:codex"]);
    expect(ordered.map((i) => i.id)).toEqual([
      "all",
      "provider:codex",
      "in_app",
      "provider:claude",
    ]);
  });
});

describe("reorderEnv", () => {
  it("dragId를 targetId 위치로 이동한다", () => {
    expect(reorderEnv(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(reorderEnv(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
  });

  it("동일/미발견이면 원래 순서를 유지한다", () => {
    expect(reorderEnv(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(reorderEnv(["a", "b"], "z", "a")).toEqual(["a", "b"]);
  });
});

describe("envCounts", () => {
  it("enabled/total을 match 적용해 센다", () => {
    const nav = buildSkillEnvNav(
      [
        mk({ id: "1", name: "on", kind: "external", provider: "codex" }),
        mk({ id: "2", name: "off", kind: "external", provider: "codex", enabled: false }),
        mk({ id: "3", name: "claude", kind: "external", provider: "claude" }),
      ],
      undefined,
    );
    const codex = nav.find((i) => i.id === "provider:codex")!;
    const skills = [
      mk({ id: "1", name: "on", kind: "external", provider: "codex" }),
      mk({ id: "2", name: "off", kind: "external", provider: "codex", enabled: false }),
      mk({ id: "3", name: "claude", kind: "external", provider: "claude" }),
    ];
    expect(envCounts(codex, skills)).toEqual({ enabled: 1, total: 2 });
    const all = nav.find((i) => i.id === "all")!;
    expect(envCounts(all, skills)).toEqual({ enabled: 2, total: 3 });
  });
});

const ws = (repoId: string, label: string, memberPaths: string[]): SkillWorkspace => ({
  repoId,
  label,
  rootPath: `/repos/${label}`,
  skillCount: memberPaths.length,
  memberPaths,
});

describe("buildSkillWorkspaceNav", () => {
  it("builds workspace nav items with workspace: ids and labels", () => {
    const nav = buildSkillWorkspaceNav([
      ws("r1", "alpha", ["/repos/alpha/.claude/skills/x/SKILL.md"]),
    ]);
    expect(nav).toHaveLength(1);
    expect(nav[0].id).toBe("workspace:r1");
    expect(nav[0].label).toBe("alpha");
    expect(nav[0].pinned).toBe(true);
    expect(nav[0].repoId).toBe("r1"); // #17 헬스 lookup 키 — id 역추론 없이 직접 부여.
  });

  it("match uses memberPaths Set on sourcePath", () => {
    const p = "/repos/alpha/.claude/skills/x/SKILL.md";
    const nav = buildSkillWorkspaceNav([ws("r1", "alpha", [p])]);
    expect(nav[0].match(mk({ id: "x", name: "x", kind: "external", sourcePath: p }))).toBe(true);
    expect(
      nav[0].match(mk({ id: "y", name: "y", kind: "external", sourcePath: "/other/SKILL.md" })),
    ).toBe(false);
    expect(nav[0].match(mk({ id: "z", name: "z", kind: "external", sourcePath: null }))).toBe(
      false,
    );
  });

  it("returns empty for undefined/empty workspaces", () => {
    expect(buildSkillWorkspaceNav(undefined)).toEqual([]);
    expect(buildSkillWorkspaceNav([])).toEqual([]);
  });
});

describe("buildDivergedPathSet", () => {
  const rows: SkillDivergence[] = [
    {
      repoId: "r1",
      provider: "claude",
      name: "a",
      memberPath: "/p/a/SKILL.md",
      status: "diverged",
    },
    { repoId: "r1", provider: "claude", name: "b", memberPath: "/p/b/SKILL.md", status: "in_sync" },
  ];

  it("includes only diverged memberPaths", () => {
    const set = buildDivergedPathSet(rows);
    expect(set.has("/p/a/SKILL.md")).toBe(true);
    expect(set.has("/p/b/SKILL.md")).toBe(false);
  });

  it("returns an empty set for undefined", () => {
    expect(buildDivergedPathSet(undefined).size).toBe(0);
  });
});

describe("buildVendorTargets", () => {
  const div = (
    repoId: string,
    provider: SkillProvider,
    name: string,
    status: "in_sync" | "diverged",
  ): SkillDivergence => ({ repoId, provider, name, memberPath: `/p/${name}/SKILL.md`, status });

  it("maps absent/in_sync/diverged per workspace from divergences", () => {
    const skill = mk({ id: "managed:foo", name: "foo", kind: "managed", provider: "claude" });
    const workspaces = [ws("r1", "Alpha", []), ws("r2", "Beta", []), ws("r3", "Gamma", [])];
    const divs = [
      div("r1", "claude", "foo", "in_sync"),
      div("r2", "claude", "foo", "diverged"),
      div("r3", "claude", "bar", "in_sync"), // 다른 스킬 → r3은 absent
    ];
    expect(buildVendorTargets(skill, workspaces, divs)).toEqual([
      { repoId: "r1", label: "Alpha", state: "in_sync" },
      { repoId: "r2", label: "Beta", state: "diverged" },
      { repoId: "r3", label: "Gamma", state: "absent" },
    ]);
  });

  it("returns empty for a non-vendorable provider", () => {
    const skill = mk({ id: "managed:foo", name: "foo", kind: "managed", provider: "hermes" });
    expect(buildVendorTargets(skill, [ws("r1", "Alpha", [])], [])).toEqual([]);
  });

  it("returns empty for a non-managed skill", () => {
    const ext = mk({ id: "ext:/x", name: "foo", kind: "external", provider: "claude" });
    expect(buildVendorTargets(ext, [ws("r1", "Alpha", [])], [])).toEqual([]);
  });
});

describe("buildWorkspaceHealth", () => {
  const div = (repoId: string, name: string, status: "in_sync" | "diverged"): SkillDivergence => ({
    repoId,
    provider: "claude",
    name,
    memberPath: `/p/${repoId}/${name}/SKILL.md`,
    status,
  });

  it("counts diverged members per repoId, excluding in_sync", () => {
    const health = buildWorkspaceHealth([
      div("r1", "a", "diverged"),
      div("r1", "b", "diverged"),
      div("r1", "c", "in_sync"), // 제외
      div("r2", "d", "diverged"),
      div("r3", "e", "in_sync"), // r3은 맵에 없음
    ]);
    expect(health.get("r1")).toBe(2);
    expect(health.get("r2")).toBe(1);
    expect(health.has("r3")).toBe(false);
    expect([...health.values()].reduce((a, b) => a + b, 0)).toBe(3); // 전체 합계
  });

  it("returns an empty map for undefined/empty", () => {
    expect(buildWorkspaceHealth(undefined).size).toBe(0);
    expect(buildWorkspaceHealth([]).size).toBe(0);
  });
});

describe("buildDivergedLocationLabels", () => {
  const div = (
    repoId: string,
    memberPath: string,
    status: "in_sync" | "diverged",
  ): SkillDivergence => ({ repoId, provider: "claude", name: "foo", memberPath, status });

  it("maps diverged memberPath → workspace label by repoId, excluding in_sync", () => {
    const workspaces = [ws("r1", "Alpha", []), ws("r2", "Beta", [])];
    const divs = [
      div("r1", "/repos/Alpha/.claude/skills/foo/SKILL.md", "diverged"),
      div("r2", "/repos/Beta/.codex/skills/foo/SKILL.md", "diverged"),
      div("r1", "/repos/Alpha/.claude/skills/bar/SKILL.md", "in_sync"), // 제외
    ];
    const labels = buildDivergedLocationLabels(divs, workspaces);
    expect(labels.get("/repos/Alpha/.claude/skills/foo/SKILL.md")).toBe("Alpha");
    expect(labels.get("/repos/Beta/.codex/skills/foo/SKILL.md")).toBe("Beta");
    expect(labels.has("/repos/Alpha/.claude/skills/bar/SKILL.md")).toBe(false); // in_sync 미수록
    expect(labels.size).toBe(2);
  });

  it("falls back to repoId when no workspace label matches", () => {
    const labels = buildDivergedLocationLabels([div("rX", "/p/x/SKILL.md", "diverged")], []);
    expect(labels.get("/p/x/SKILL.md")).toBe("rX");
  });

  it("returns an empty map for undefined inputs", () => {
    expect(buildDivergedLocationLabels(undefined, undefined).size).toBe(0);
  });
});

describe("buildInstallProviderOptions", () => {
  it("present인 에이전트 provider만 노출하고 'other'는 항상 포함한다", () => {
    const opts = buildInstallProviderOptions([
      env("claude", true),
      env("codex", true),
      env("openclaw", false),
      env("hermes", false),
    ]);
    expect(opts.map((o) => o.provider)).toEqual(["claude", "codex", "other"]);
  });

  it("부재 에이전트(OpenClaw 등)는 숨긴다", () => {
    const opts = buildInstallProviderOptions([env("openclaw", false)]);
    expect(opts.map((o) => o.provider)).not.toContain("openclaw");
    expect(opts.map((o) => o.provider)).toEqual(["other"]);
  });

  it("undefined/빈 환경이면 'other'만 남는다", () => {
    expect(buildInstallProviderOptions(undefined).map((o) => o.provider)).toEqual(["other"]);
    expect(buildInstallProviderOptions([]).map((o) => o.provider)).toEqual(["other"]);
  });

  it("SKILL_PROVIDER_ORDER 순서를 유지하고 라벨을 붙인다", () => {
    const opts = buildInstallProviderOptions([
      env("hermes", true),
      env("claude", true),
      env("codex", true),
    ]);
    expect(opts.map((o) => o.provider)).toEqual(["claude", "codex", "hermes", "other"]);
    expect(opts.find((o) => o.provider === "claude")!.label).toBe(SKILL_PROVIDER_LABEL.claude);
  });
});
