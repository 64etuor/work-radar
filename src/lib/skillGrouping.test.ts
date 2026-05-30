import { describe, expect, it } from "vitest";

import type { Skill } from "@/bindings";
import {
  groupSkillsForPalette,
  SKILL_PALETTE_HEADINGS,
  skillSearchValue,
} from "@/lib/skillGrouping";

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
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("groupSkillsForPalette", () => {
  it("프로젝트(in-app) 그룹을 전역(external) 그룹보다 먼저 노출한다", () => {
    const groups = groupSkillsForPalette([
      mk({ id: "x", name: "external-a", kind: "external" }),
      mk({ id: "i", name: "inapp-a", kind: "in_app_prompt" }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["project", "global"]);
  });

  it("빈 그룹은 결과에서 제외한다", () => {
    const onlyExternal = groupSkillsForPalette([
      mk({ id: "x", name: "external-a", kind: "external" }),
    ]);
    expect(onlyExternal.map((g) => g.key)).toEqual(["global"]);

    const onlyInApp = groupSkillsForPalette([
      mk({ id: "i", name: "inapp-a", kind: "in_app_prompt" }),
    ]);
    expect(onlyInApp.map((g) => g.key)).toEqual(["project"]);
  });

  it("빈 입력은 빈 배열을 반환한다", () => {
    expect(groupSkillsForPalette([])).toEqual([]);
  });

  it("그룹 내에서 enabled를 disabled보다 먼저 정렬한다", () => {
    const groups = groupSkillsForPalette([
      mk({ id: "off", name: "z-off", kind: "in_app_prompt", enabled: false }),
      mk({ id: "on", name: "a-on", kind: "in_app_prompt", enabled: true }),
    ]);
    const project = groups.find((g) => g.key === "project")!;
    expect(project.skills.map((s) => s.id)).toEqual(["on", "off"]);
  });

  it("enabled가 같으면 이름 오름차순으로 정렬한다", () => {
    const groups = groupSkillsForPalette([
      mk({ id: "b", name: "beta", kind: "in_app_prompt" }),
      mk({ id: "a", name: "alpha", kind: "in_app_prompt" }),
    ]);
    const project = groups.find((g) => g.key === "project")!;
    expect(project.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
  });

  it("그룹 heading은 정본 라벨을 쓴다", () => {
    const groups = groupSkillsForPalette([
      mk({ id: "i", name: "inapp", kind: "in_app_prompt" }),
      mk({ id: "x", name: "ext", kind: "external" }),
    ]);
    expect(groups.find((g) => g.key === "project")!.heading).toBe(SKILL_PALETTE_HEADINGS.project);
    expect(groups.find((g) => g.key === "global")!.heading).toBe(SKILL_PALETTE_HEADINGS.global);
  });
});

describe("skillSearchValue", () => {
  it("이름과 종류 동의어를 포함한다", () => {
    const v = skillSearchValue(mk({ id: "i", name: "My Skill", kind: "in_app_prompt" }));
    expect(v).toContain("My Skill");
    expect(v).toContain("스킬");
    expect(v).toContain("프로젝트");
  });

  it("바인딩이 있으면 검색 문자열에 포함한다", () => {
    const v = skillSearchValue(
      mk({ id: "i", name: "Enrich", kind: "in_app_prompt", binding: "enrich" }),
    );
    expect(v).toContain("enrich");
  });

  it("external은 전역 동의어를 포함한다", () => {
    const v = skillSearchValue(mk({ id: "x", name: "Ext", kind: "external" }));
    expect(v).toContain("외부");
    expect(v).toContain("전역");
  });
});
