import { describe, expect, it } from "vitest";

import type { BatchItemResult, Skill } from "@/bindings";

import {
  addTagToSkill,
  batchApplyTargets,
  batchMutableTargets,
  batchTaggableTargets,
  isBatchMutable,
  selectedSkills,
  summarizeBatch,
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

/** kind/provider까지 채우는 배치-적용용 최소 Skill 팩토리(나머지 필드는 캐스트로 채운다). */
const mk = (over: Partial<Skill>): Skill =>
  ({
    id: "x",
    name: "n",
    kind: "managed",
    provider: "claude",
    tags: [],
    ...over,
  }) as unknown as Skill;

describe("batchApplyTargets — managed + provider만", () => {
  it("provider가 있는 managed 스킬만 남긴다", () => {
    const skills = [
      mk({ id: "a", kind: "managed", provider: "claude" }),
      mk({ id: "b", kind: "external", provider: "codex" }),
      mk({ id: "c", kind: "in_app_prompt", provider: null }),
      mk({ id: "d", kind: "managed", provider: null }),
    ];
    const got = batchApplyTargets(skills, new Set(["a", "b", "c", "d"]));
    expect(got.map((s) => s.id)).toEqual(["a"]);
  });

  it("선택에 없는 항목은 제외", () => {
    const skills = [mk({ id: "a", kind: "managed", provider: "claude" })];
    expect(batchApplyTargets(skills, new Set())).toEqual([]);
  });
});

describe("summarizeBatch — 결과 한 줄 요약", () => {
  it("빈 결과는 null", () => {
    expect(summarizeBatch([])).toBeNull();
  });

  it("결과를 카테고리별로 집계", () => {
    const r: BatchItemResult[] = [
      { provider: "claude", name: "a", outcome: "applied", message: null },
      { provider: "claude", name: "b", outcome: "applied", message: null },
      { provider: "claude", name: "c", outcome: "collision", message: null },
    ];
    expect(summarizeBatch(r)).toBe("2 적용 · 1 충돌(스킵)");
  });
});
