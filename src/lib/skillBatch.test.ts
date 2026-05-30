import { describe, expect, it } from "vitest";

import type { Skill } from "@/bindings";

import {
  addTagToSkill,
  batchMutableTargets,
  batchTaggableTargets,
  isBatchMutable,
  selectedSkills,
} from "./skillBatch";

/** 테스트용 최소 Skill(배치 분류와 무관한 필드는 캐스트로 채운다). */
function skill(id: string, kind: "in_app_prompt" | "external", tags: string[] = []): Skill {
  return { id, name: id, kind, enabled: true, tags } as unknown as Skill;
}

const inAppA = skill("a", "in_app_prompt");
const inAppB = skill("b", "in_app_prompt");
const extC = skill("ext:/x/c", "external");
const extD = skill("ext:/x/d", "external", ["fav"]);
const all = [inAppA, inAppB, extC, extD];

describe("isBatchMutable", () => {
  it("인앱만 가변(토글/삭제 대상)", () => {
    expect(isBatchMutable(inAppA)).toBe(true);
    expect(isBatchMutable(extC)).toBe(false);
  });
});

describe("selectedSkills", () => {
  it("선택 id를 Skill로 해석", () => {
    const sel = new Set(["a", "ext:/x/c"]);
    expect(selectedSkills(all, sel).map((s) => s.id)).toEqual(["a", "ext:/x/c"]);
  });

  it("목록에 없는 id(사라진 선택)는 제외", () => {
    const sel = new Set(["a", "ghost"]);
    expect(selectedSkills(all, sel).map((s) => s.id)).toEqual(["a"]);
  });
});

describe("batchMutableTargets — 외부 제외(파일 무변경 가드)", () => {
  it("선택에 외부가 섞여도 토글/삭제 대상은 인앱만", () => {
    const sel = new Set(["a", "b", "ext:/x/c", "ext:/x/d"]);
    expect(batchMutableTargets(all, sel).map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("외부만 선택하면 토글/삭제 대상은 없다", () => {
    const sel = new Set(["ext:/x/c", "ext:/x/d"]);
    expect(batchMutableTargets(all, sel)).toEqual([]);
  });
});

describe("batchTaggableTargets — 선택 전체(외부 포함)", () => {
  it("외부도 태깅 대상에 포함(로컬 SQLite만)", () => {
    const sel = new Set(["a", "ext:/x/c", "ext:/x/d"]);
    expect(batchTaggableTargets(all, sel).map((s) => s.id)).toEqual(["a", "ext:/x/c", "ext:/x/d"]);
  });
});

describe("addTagToSkill — 멱등", () => {
  it("없으면 추가", () => {
    expect(addTagToSkill(extC, "fav")).toEqual(["fav"]);
  });

  it("이미 있으면 그대로(중복 방지)", () => {
    expect(addTagToSkill(extD, "fav")).toEqual(["fav"]);
  });
});
