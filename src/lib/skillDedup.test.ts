import { describe, expect, it } from "vitest";

import type { Skill } from "@/bindings";

import { groupCrossToolSkills, groupProviders } from "./skillDedup";

/** 테스트용 최소 Skill(그룹화와 무관한 필드는 캐스트로 채운다). */
function skill(
  id: string,
  name: string,
  kind: "in_app_prompt" | "external",
  provider?: string,
  sourcePath?: string,
): Skill {
  return { id, name, kind, provider, sourcePath, tags: [], enabled: true } as unknown as Skill;
}

describe("groupCrossToolSkills", () => {
  it("빈 입력 → 빈 출력", () => {
    expect(groupCrossToolSkills([])).toEqual([]);
  });

  it("인앱 프롬프트는 항상 단일 그룹(이름이 같아도 묶지 않음)", () => {
    const a = skill("a", "dup", "in_app_prompt");
    const b = skill("b", "dup", "in_app_prompt");
    const out = groupCrossToolSkills([a, b]);
    expect(out).toHaveLength(2);
    for (const g of out) {
      expect(g.locations).toHaveLength(1);
      expect(g.memberIds).toHaveLength(1);
    }
  });

  it("이름이 같은 두 외부 스킬(다른 도구) → 한 그룹 2곳", () => {
    const c = skill("ext:c", "commit-helper", "external", "codex", "~/.codex/skills/commit-helper");
    const a = skill(
      "ext:a",
      "commit-helper",
      "external",
      "claude",
      "~/.claude/skills/commit-helper",
    );
    const out = groupCrossToolSkills([c, a]);
    expect(out).toHaveLength(1);
    const g = out[0];
    expect(g.locations).toHaveLength(2);
    expect(g.memberIds).toHaveLength(2);
    // primary = provider rank 순(claude < codex) → 대표는 claude
    expect(g.skill.provider).toBe("claude");
    // locations / memberIds 는 같은 순서로 평행
    expect(g.locations.map((l) => l.id)).toEqual(g.memberIds);
    expect(g.locations.map((l) => l.provider)).toEqual(["claude", "codex"]);
  });

  it("이름이 다른 외부 스킬 → 별도 그룹(각 1곳)", () => {
    const a = skill("ext:a", "foo", "external", "claude");
    const b = skill("ext:b", "bar", "external", "codex");
    const out = groupCrossToolSkills([a, b]);
    expect(out).toHaveLength(2);
    expect(out.every((g) => g.locations.length === 1)).toBe(true);
  });

  it("같은 이름의 인앱 + 외부 → 묶지 않음(인앱은 그룹 비대상)", () => {
    const inApp = skill("a", "shared", "in_app_prompt");
    const ext = skill("ext:e", "shared", "external", "claude");
    const out = groupCrossToolSkills([inApp, ext]);
    expect(out).toHaveLength(2);
    expect(out.every((g) => g.locations.length === 1)).toBe(true);
  });

  it("이름 매칭은 trim + 대소문자 무시", () => {
    const a = skill("ext:a", "Foo", "external", "claude");
    const b = skill("ext:b", "  foo ", "external", "codex");
    const out = groupCrossToolSkills([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].locations).toHaveLength(2);
  });

  it("같은 도구의 동명 스킬(다른 경로)도 N곳으로 묶임", () => {
    const a = skill("ext:a", "dup", "external", "claude", "~/repo/.claude/skills/dup");
    const b = skill("ext:b", "dup", "external", "claude", "~/.claude/skills/dup");
    const out = groupCrossToolSkills([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].locations).toHaveLength(2);
  });
});

describe("groupProviders", () => {
  it("provider rank 순으로 중복 제거", () => {
    expect(
      groupProviders([
        { id: "1", provider: "codex", sourcePath: null },
        { id: "2", provider: "claude", sourcePath: null },
        { id: "3", provider: "codex", sourcePath: null },
      ]),
    ).toEqual(["claude", "codex"]);
  });

  it("provider null 은 제외", () => {
    expect(
      groupProviders([
        { id: "1", provider: null, sourcePath: null },
        { id: "2", provider: "hermes", sourcePath: null },
      ]),
    ).toEqual(["hermes"]);
  });
});
