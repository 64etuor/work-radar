import type { Skill, SkillProvider } from "@/bindings";

/**
 * 도구 간 동일 스킬 그룹화(Phase 5 #4) — **순수 함수**(부수효과 없음, vitest 대상).
 *
 * skills-manager의 `group_discovered`를 work-radar 의미로 재정의한다. 단, skills-manager의 느림
 * 원인이던 **eager 전체-콘텐츠 해싱은 도입하지 않는다** — 그룹 키는 이미 스캔된 `name`뿐이다(해싱/IO
 * 없음, 스캔 latency 무영향). 같은 이름의 외부 스킬이 여러 도구(claude/codex/…)나 여러 루트에 있으면
 * 한 카드로 묶고 "N곳"으로 표시한다. 인앱 프롬프트는 묶지 않는다(고유 잡 템플릿 — 이름 충돌 무관).
 */

/** 그룹 멤버 한 곳(= 한 외부 스킬 행). 카드/Sheet에서 위치 전환·출처 칩에 쓴다. */
export interface SkillLocation {
  /** 통합 Skill.id(`ext:` 접두 포함) — 선택/태깅/Sheet 전환 대상. */
  id: string;
  provider: SkillProvider | null;
  sourcePath: string | null;
}

/** 그룹화 결과 한 카드. `locations.length > 1`이면 도구 간(또는 다중 루트) 공유 스킬. */
export interface GroupedSkill {
  /** 대표 스킬(primary location). 모든 Skill 필드를 가져 카드/Sheet 렌더를 그대로 재사용한다. */
  skill: Skill;
  /** 이 그룹의 모든 위치(≥1). primary가 [0]. */
  locations: SkillLocation[];
  /** 멤버 통합 id(locations와 평행). 다중 선택 시 그룹 전체를 한 번에 토글하는 데 쓴다. */
  memberIds: string[];
}

/** 출처 칩/대표 선택의 안정 정렬용 provider 우선순위. 미지의 값은 맨 뒤. */
const PROVIDER_RANK: Record<string, number> = {
  claude: 0,
  codex: 1,
  openclaw: 2,
  hermes: 3,
  other: 4,
};

const rank = (p: SkillProvider | null): number =>
  p != null && p in PROVIDER_RANK ? PROVIDER_RANK[p] : 99;

/** 이름 매칭 키 — trim + 소문자(표시 이름의 사소한 차이는 같은 스킬로 본다). */
const nameKey = (name: string): string => name.trim().toLowerCase();

/** 멤버 정렬: provider rank → sourcePath(안정적·결정적). primary는 정렬 후 [0]. */
function byProviderThenPath(a: Skill, b: Skill): number {
  const r = rank(a.provider) - rank(b.provider);
  if (r !== 0) return r;
  return (a.sourcePath ?? "").localeCompare(b.sourcePath ?? "");
}

const toLocation = (s: Skill): SkillLocation => ({
  id: s.id,
  provider: s.provider,
  sourcePath: s.sourcePath,
});

const singleton = (s: Skill): GroupedSkill => ({
  skill: s,
  locations: [toLocation(s)],
  memberIds: [s.id],
});

/**
 * 외부 스킬을 이름으로 묶고 인앱 프롬프트는 그대로 통과시킨다. 반환 순서는 비결정(다운스트림
 * `segmentSkills`가 섹션별로 이름 정렬하므로 무관). 그룹 키는 `name`뿐 — 해싱/파일 읽기 없음.
 */
export function groupCrossToolSkills(skills: Skill[]): GroupedSkill[] {
  const externalByName = new Map<string, Skill[]>();
  const result: GroupedSkill[] = [];

  for (const s of skills) {
    if (s.kind === "external") {
      const key = nameKey(s.name);
      const arr = externalByName.get(key);
      if (arr) arr.push(s);
      else externalByName.set(key, [s]);
    } else {
      result.push(singleton(s));
    }
  }

  for (const members of externalByName.values()) {
    const sorted = [...members].sort(byProviderThenPath);
    result.push({
      skill: sorted[0],
      locations: sorted.map(toLocation),
      memberIds: sorted.map((m) => m.id),
    });
  }

  return result;
}

/** 그룹의 출처 provider 목록(중복 제거 + rank 순). null provider는 제외 — 카드/Sheet 칩에 쓴다. */
export function groupProviders(locations: SkillLocation[]): SkillProvider[] {
  const seen = new Set<SkillProvider>();
  for (const l of locations) if (l.provider) seen.add(l.provider);
  return [...seen].sort((a, b) => rank(a) - rank(b));
}
