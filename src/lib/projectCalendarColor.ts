import type { CSSProperties } from "react";

// SSOT는 `src-tauri/src/commands/projects.rs::PROJECT_CALENDAR_PALETTE`.
// 둘 다 동일하게 유지해야 한다(hash 분배가 양쪽에서 같은 색을 내야 picker가 일관됨).
// 색상 근거는 `DESIGN.md` §Colors (brand-aligned).
export const PROJECT_CALENDAR_PALETTE = [
  "#1863DC", // Action Blue
  "#003C33", // Deep Enterprise Green
  "#FF7759", // Coral
  "#071829", // Dark Navy
  "#4C6EE6", // Focus Blue
  "#5A8A78", // sage
  "#A89175", // warm stone
  "#75758A", // Slate
] as const;

export function normalizeHexColor(input: string | null | undefined): string | null {
  const raw = input?.trim();
  if (!raw) return null;
  const hex = raw.startsWith("#") ? raw.slice(1) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  return `#${hex.toUpperCase()}`;
}

export function defaultProjectCalendarColor(projectId: string): string {
  let hash = 14_695_981_039_346_656_037n;
  for (let i = 0; i < projectId.length; i += 1) {
    hash ^= BigInt(projectId.charCodeAt(i) & 0xff);
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return PROJECT_CALENDAR_PALETTE[Number(hash % BigInt(PROJECT_CALENDAR_PALETTE.length))];
}

function channel(v: number): number {
  const x = v / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

export function readableTextColor(background: string): "#111827" | "#FFFFFF" {
  const normalized = normalizeHexColor(background);
  if (!normalized) return "#111827";
  const r = Number.parseInt(normalized.slice(1, 3), 16);
  const g = Number.parseInt(normalized.slice(3, 5), 16);
  const b = Number.parseInt(normalized.slice(5, 7), 16);
  const luminance = 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const contrastDark = (luminance + 0.05) / 0.05;
  const contrastLight = 1.05 / (luminance + 0.05);
  return contrastLight > contrastDark ? "#FFFFFF" : "#111827";
}

export function projectCalendarColors(projectId: string, configured?: string | null) {
  const background = normalizeHexColor(configured) ?? defaultProjectCalendarColor(projectId);
  return { background, foreground: readableTextColor(background) };
}

export function calendarColorStyle(background: string, foreground?: string): CSSProperties {
  const text = foreground ?? readableTextColor(background);
  return {
    "--project-calendar-bg": background,
    "--project-calendar-fg": text,
    backgroundColor: background,
    borderColor: background,
    color: text,
  } as CSSProperties;
}
