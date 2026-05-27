import type { FontPreset } from "@/store";

/**
 * 본문 폰트 프리셋 정본. AppearanceSettings UI와 부팅 시 `--font-sans` 적용이
 * 같은 정의를 공유한다. `family` 값은 그대로 CSS `font-family` 로 들어간다.
 *
 * 폴백 스택은 DESIGN.md(Cohere white editorial) 의 기본 스택을 끝에 항상 붙인다.
 */
const FALLBACK = `"Inter", Arial, ui-sans-serif, system-ui, sans-serif`;

export interface FontPresetDef {
  id: FontPreset;
  label: string;
  hint: string;
  family: string;
}

export const FONT_PRESETS: FontPresetDef[] = [
  {
    id: "system",
    label: "System",
    hint: "OS 기본 시스템 폰트",
    family: `ui-sans-serif, system-ui, sans-serif`,
  },
  {
    id: "cohere",
    label: "Cohere (기본)",
    hint: "DESIGN.md 기본 — Unica77 Cohere Web · Inter fallback",
    family: `"Unica77 Cohere Web", ${FALLBACK}`,
  },
  {
    id: "inter",
    label: "Inter",
    hint: "Inter Variable (번들)",
    family: `"Inter Variable", ${FALLBACK}`,
  },
  {
    id: "pretendard",
    label: "Pretendard",
    hint: "Pretendard Variable (번들) — 한글 본문",
    family: `"Pretendard Variable", ${FALLBACK}`,
  },
  {
    id: "suit",
    label: "SUIT",
    hint: "SUIT Variable (번들) — 한글 본문",
    family: `"SUIT Variable", ${FALLBACK}`,
  },
  {
    id: "jbm-hangul",
    label: "JetBrains Mono Hangul",
    hint: "한글 글리프 포함 모노 (번들)",
    family: `"JetBrains Mono Hangul", ui-monospace, "SF Mono", "JetBrains Mono", monospace`,
  },
];

const PRESET_BY_ID = new Map(FONT_PRESETS.map((p) => [p.id, p]));

export function fontFamilyFor(preset: FontPreset): string {
  return (PRESET_BY_ID.get(preset) ?? FONT_PRESETS[1]).family;
}
