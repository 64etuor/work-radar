// src/lib/lifeWheelRadar.ts
import type { LifeWheelTagConfig, WorkSignal } from "@/bindings";
import { parseAreaTagKeys } from "@/components/board/LifeWheelPalette";

export interface RadarAxis {
  key: string;
  label: string;
  color: string;
  count: number;
}

/** enabled 태그만, id 오름차순. */
function enabledSorted(tags: LifeWheelTagConfig[]): LifeWheelTagConfig[] {
  return tags
    .filter((t) => t.enabled)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 신호[]를 enabled 태그 축별 완료 count로 집계(순수).
 * 신호가 여러 area 태그를 가지면 각 축에 1씩. 미설정 신호·비활성 태그는 제외.
 */
export function computeRadarAxes(signals: WorkSignal[], tags: LifeWheelTagConfig[]): RadarAxis[] {
  const axisTags = enabledSorted(tags);
  const enabledKeys = new Set(axisTags.map((t) => t.id));
  const counts = new Map<string, number>();
  for (const s of signals) {
    const keys = parseAreaTagKeys(s.areaTags, s.area);
    for (const k of keys) {
      if (enabledKeys.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return axisTags.map((t) => ({
    key: t.id,
    label: t.label,
    color: t.color,
    count: counts.get(t.id) ?? 0,
  }));
}

export type RadarMode = "empty" | "bars" | "radar";

/** enabled 태그 개수 → 렌더 모드. 0=안내, 1~2=수평 바, 3+=레이더. */
export function radarRenderMode(tags: LifeWheelTagConfig[]): RadarMode {
  const n = tags.filter((t) => t.enabled).length;
  if (n === 0) return "empty";
  if (n <= 2) return "bars";
  return "radar";
}
