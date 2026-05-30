import type { Skill } from "@/bindings";

/**
 * 다중 선택 배치 작업 헬퍼(Phase 3 #9) — **순수 함수**(부수효과 없음, vitest 대상).
 *
 * 핵심 레일: 외부 스킬(~/.{claude,codex,…}/skills)은 디스크 SSOT라 **읽기 전용**이다. 그래서
 * 배치 **토글/삭제는 인앱 프롬프트에만** 적용하고(외부 제외), 배치 **태깅은 선택 전체**에 적용한다
 * (외부 태그는 로컬 SQLite만 바뀌고 디스크 파일은 무변경 — `set_skill_tags`가 이미 보장).
 * 백엔드 `update_skill`/`delete_skill`도 `ext:` id를 거부하므로 이 분리는 이중으로 가드된다.
 */

/** 배치 토글/삭제 대상 여부 — 인앱 프롬프트만(외부는 읽기 전용 → 제외). */
export function isBatchMutable(skill: Skill): boolean {
  return skill.kind === "in_app_prompt";
}

/** 선택된 id 집합을 실제 Skill로 해석한다. 목록에 없는 id(새로고침으로 사라진 선택)는 자동 제외. */
export function selectedSkills(skills: Skill[], selected: ReadonlySet<string>): Skill[] {
  return skills.filter((s) => selected.has(s.id));
}

/** 배치 토글/삭제 대상 = 선택 중 인앱만. 외부 스킬은 절대 포함되지 않는다(파일 무변경 보장). */
export function batchMutableTargets(skills: Skill[], selected: ReadonlySet<string>): Skill[] {
  return selectedSkills(skills, selected).filter(isBatchMutable);
}

/** 배치 태깅 대상 = 선택 전체(외부 포함 — 외부 태그는 로컬 SQLite만). */
export function batchTaggableTargets(skills: Skill[], selected: ReadonlySet<string>): Skill[] {
  return selectedSkills(skills, selected);
}

/** 한 태그를 추가했을 때 그 스킬의 새 태그 집합(이미 있으면 그대로 — 멱등). `set_skill_tags`에 넘긴다. */
export function addTagToSkill(skill: Skill, tag: string): string[] {
  return skill.tags.includes(tag) ? skill.tags : [...skill.tags, tag];
}
