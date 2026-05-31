import { describe, expect, it } from "vitest";

import type { Skill } from "@/bindings";

import { skillCardBadges } from "./skillBadges";

/** 테스트용 최소 Skill(배지와 무관한 필드는 캐스트로 채운다). */
function skill(
  kind: "in_app_prompt" | "external" | "managed",
  enabled: boolean,
  provider?: string,
): Skill {
  return { id: "x", name: "x", kind, enabled, provider, tags: [] } as unknown as Skill;
}

describe("skillCardBadges", () => {
  it("인앱 활성: kind 배지만(provider 없음, off 없음)", () => {
    expect(skillCardBadges(skill("in_app_prompt", true))).toEqual([
      { key: "kind", label: "인앱", tone: "kind" },
    ]);
  });

  it("인앱 비활성: kind + off", () => {
    const b = skillCardBadges(skill("in_app_prompt", false));
    expect(b.map((x) => x.key)).toEqual(["kind", "off"]);
    expect(b[1]).toEqual({ key: "off", label: "꺼짐", tone: "off" });
  });

  it("외부 활성: kind + provider(라벨 매핑)", () => {
    expect(skillCardBadges(skill("external", true, "claude"))).toEqual([
      { key: "kind", label: "외부", tone: "kind" },
      { key: "provider", label: "Claude", tone: "provider" },
    ]);
  });

  it("외부 비활성: kind + provider + off (순서 보존)", () => {
    expect(skillCardBadges(skill("external", false, "codex")).map((x) => x.key)).toEqual([
      "kind",
      "provider",
      "off",
    ]);
  });

  it("외부 provider 누락: provider 배지 생략", () => {
    expect(skillCardBadges(skill("external", true)).map((x) => x.key)).toEqual(["kind"]);
  });

  it("미지의 provider: 원문 라벨 폴백", () => {
    const b = skillCardBadges(skill("external", true, "mystery"));
    expect(b.find((x) => x.key === "provider")?.label).toBe("mystery");
  });

  it("managed 활성: kind='라이브러리' + provider(외부와 구분)", () => {
    expect(skillCardBadges(skill("managed", true, "claude"))).toEqual([
      { key: "kind", label: "라이브러리", tone: "kind" },
      { key: "provider", label: "Claude", tone: "provider" },
    ]);
  });

  it("managed 비활성: kind + provider + off (순서 보존)", () => {
    expect(skillCardBadges(skill("managed", false, "codex")).map((x) => x.key)).toEqual([
      "kind",
      "provider",
      "off",
    ]);
  });
});
