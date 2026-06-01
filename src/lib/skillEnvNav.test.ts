import { describe, expect, it } from "vitest";

import type { Skill, SkillDivergence, SkillEnvironment, SkillWorkspace } from "@/bindings";
import {
  applyEnvOrder,
  buildDivergedPathSet,
  buildSkillEnvNav,
  buildSkillWorkspaceNav,
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
