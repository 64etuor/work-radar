import { describe, expect, it } from "vitest";

import type { Skill } from "@/bindings";

import { collectTags, matchesTag, UNTAGGED } from "./skillTags";

/** 테스트용 최소 Skill(태그 외 필드는 필터 로직과 무관 — 캐스트로 채운다). */
function skill(id: string, tags: string[]): Skill {
  return { id, name: id, kind: "external", tags } as unknown as Skill;
}

describe("collectTags", () => {
  it("유일화하고 로캐일 정렬한다", () => {
    const skills = [skill("a", ["zebra", "apple"]), skill("b", ["apple", "mango"]), skill("c", [])];
    expect(collectTags(skills)).toEqual(["apple", "mango", "zebra"]);
  });

  it("태그가 없으면 빈 배열", () => {
    expect(collectTags([skill("a", []), skill("b", [])])).toEqual([]);
  });
});

describe("matchesTag", () => {
  const tagged = skill("a", ["fav", "util"]);
  const untagged = skill("b", []);

  it("null이면 전체 통과", () => {
    expect(matchesTag(tagged, null)).toBe(true);
    expect(matchesTag(untagged, null)).toBe(true);
  });

  it("UNTAGGED는 태그 없는 스킬만", () => {
    expect(matchesTag(untagged, UNTAGGED)).toBe(true);
    expect(matchesTag(tagged, UNTAGGED)).toBe(false);
  });

  it("특정 태그는 그 태그 보유 스킬만", () => {
    expect(matchesTag(tagged, "fav")).toBe(true);
    expect(matchesTag(tagged, "missing")).toBe(false);
    expect(matchesTag(untagged, "fav")).toBe(false);
  });
});
