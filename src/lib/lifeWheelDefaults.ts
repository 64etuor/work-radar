import type { LifeWheelTagConfig } from "@/bindings";

/**
 * Life Wheel 기본 팔레트 — SSOT는 `src-tauri/src/commands/signals.rs::default_life_wheel_tags`.
 * 둘 다 동일하게 유지해야 한다(설정 "초기화" UI가 이 상수를 사용).
 * 색상 근거는 `DESIGN.md` §Colors (brand-aligned).
 */
export const DEFAULT_LIFE_WHEEL_TAGS: LifeWheelTagConfig[] = [
  { id: "health", label: "건강", color: "#5a8a78", builtIn: true, enabled: true },
  { id: "work", label: "업무", color: "#003c33", builtIn: true, enabled: true },
  { id: "studies", label: "학습", color: "#1863dc", builtIn: true, enabled: true },
  { id: "environment", label: "환경", color: "#8aa67a", builtIn: true, enabled: true },
  { id: "recreation", label: "휴식", color: "#ff7759", builtIn: true, enabled: true },
  { id: "romance", label: "연애", color: "#ffad9b", builtIn: true, enabled: true },
  { id: "family", label: "가족", color: "#a89175", builtIn: true, enabled: true },
  { id: "friends", label: "친구", color: "#4c6ee6", builtIn: true, enabled: true },
  { id: "finances", label: "재정", color: "#071829", builtIn: true, enabled: true },
  { id: "other", label: "기타", color: "#75758a", builtIn: true, enabled: true },
];

/** 새 사용자 태그 추가 시 순환 색상. brand-aligned. */
export const NEW_TAG_COLOR_CYCLE: string[] = [
  "#5a8a78",
  "#1863dc",
  "#ff7759",
  "#ffad9b",
  "#4c6ee6",
  "#a89175",
  "#75758a",
];
