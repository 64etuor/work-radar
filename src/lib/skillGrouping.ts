import type { Skill } from "@/bindings";

/**
 * Cmd+K 팔레트의 스킬 표시 정렬/그룹핑 — **표시 전용**(option B, P4).
 *
 * INVARIANT #7: Skill 스키마에 project_id가 없다(migration 0013 SSOT). 그래서 "프로젝트별"은
 * 스키마 scope가 아니라 *표시 순서*로만 구현한다. in-app 프롬프트는 잡 바인딩을 통해
 * 프로젝트별 에이전트 잡에 묶이므로 "프로젝트 스킬"로, external(~/.claude/skills)은 디스크
 * 전역이라 "전역 스킬"로 본다. 현재 프로젝트 우선 = in-app(프로젝트) 그룹을 먼저 노출.
 *
 * 순수 함수(부수효과 없음) — vitest 단위테스트 대상.
 */

export type SkillPaletteGroupKey = "project" | "global";

export interface SkillPaletteGroup {
  key: SkillPaletteGroupKey;
  /** 팔레트 CommandGroup heading. */
  heading: string;
  skills: Skill[];
}

export const SKILL_PALETTE_HEADINGS: Record<SkillPaletteGroupKey, string> = {
  project: "프로젝트 스킬",
  global: "전역 스킬 (~/.claude/skills)",
};

/** 한 스킬을 팔레트 그룹으로 분류. in-app 프롬프트=프로젝트 잡 바인딩, external=전역 디스크. */
function groupKeyOf(skill: Skill): SkillPaletteGroupKey {
  return skill.kind === "in_app_prompt" ? "project" : "global";
}

/** 그룹 내 정렬: enabled 우선 → 이름(로캘) 오름차순. 안정적·결정적. */
function sortWithin(a: Skill, b: Skill): number {
  if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * 스킬 목록을 팔레트용 그룹(프로젝트 우선 → 전역)으로 정렬한다.
 * 빈 그룹은 결과에서 제외한다. 현재 프로젝트 우선 노출 = 프로젝트 그룹을 항상 먼저.
 */
export function groupSkillsForPalette(skills: Skill[]): SkillPaletteGroup[] {
  const order: SkillPaletteGroupKey[] = ["project", "global"];
  const grouped: Record<SkillPaletteGroupKey, Skill[]> = {
    project: [],
    global: [],
  };
  for (const skill of skills) grouped[groupKeyOf(skill)].push(skill);

  const groups: SkillPaletteGroup[] = [];
  for (const key of order) {
    if (grouped[key].length === 0) continue;
    groups.push({
      key,
      heading: SKILL_PALETTE_HEADINGS[key],
      skills: grouped[key].sort(sortWithin),
    });
  }
  return groups;
}

/** 팔레트 검색 매칭 문자열(이름 + 바인딩 + 종류 동의어). cmdk value로 쓴다. */
export function skillSearchValue(skill: Skill): string {
  const parts = ["skill", "스킬", skill.name];
  if (skill.binding) parts.push(skill.binding);
  parts.push(skill.kind === "in_app_prompt" ? "프롬프트 prompt 프로젝트" : "external 외부 전역");
  return parts.join(" ");
}
