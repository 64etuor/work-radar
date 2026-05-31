import type { Skill } from "@/bindings";

/**
 * 스킬 카드 상태 배지(Phase 3 #10) — **순수 함수**(부수효과 없음, vitest 대상).
 *
 * skills-manager의 sync 점(diverged/in-sync)은 **도입하지 않는다**(work-radar엔 sync 모델 없음).
 * work-radar 의미로 재정의: `kind`(인앱/외부) · `provider`(외부만) · `off`(비활성)만 표시한다.
 */

export type SkillBadgeTone = "kind" | "provider" | "off";

export interface SkillBadge {
  /** React key + CSS variant 식별자. */
  key: string;
  label: string;
  tone: SkillBadgeTone;
}

/** 외부 provider 표시 라벨(`Skill.provider`는 소문자 enum). 미지의 값은 원문 그대로. */
const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  openclaw: "OpenClaw",
  hermes: "Hermes",
  other: "기타",
};

/** provider enum → 표시 라벨(미지의 값은 원문). 카드 출처 칩·Sheet 위치 전환에서 공유한다. */
export function providerLabel(provider: string | null): string {
  return provider ? (PROVIDER_LABELS[provider] ?? provider) : "기타";
}

/**
 * 한 스킬의 카드 배지 목록(순서: kind → provider → off). 인앱은 provider 없음, 외부/managed는 provider
 * 표시. managed(G1-PR3, 중앙 라이브러리로 import된 스킬)는 kind 배지가 "라이브러리"다(work-radar 소유 —
 * "외부"와 구분). enabled면 off 배지 없음(부재 = 켜짐 — 미니멀 유지).
 */
export function skillCardBadges(skill: Skill): SkillBadge[] {
  const badges: SkillBadge[] = [];
  const isInApp = skill.kind === "in_app_prompt";
  const isManaged = skill.kind === "managed";
  const kindLabel = isInApp ? "인앱" : isManaged ? "라이브러리" : "외부";
  badges.push({ key: "kind", label: kindLabel, tone: "kind" });
  // 외부·managed 모두 출처 provider를 보여준다(managed는 import 출처). 인앱은 provider 없음.
  if (!isInApp && skill.provider) {
    badges.push({
      key: "provider",
      label: providerLabel(skill.provider),
      tone: "provider",
    });
  }
  if (!skill.enabled) badges.push({ key: "off", label: "꺼짐", tone: "off" });
  return badges;
}
