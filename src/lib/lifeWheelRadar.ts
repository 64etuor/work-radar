// src/lib/lifeWheelRadar.ts
import type { LifeWheelTagConfig, RoutineTrackingItem, WorkSignal } from "@/bindings";
import { parseAreaTagKeys } from "@/components/board/LifeWheelPalette";
import { bucketByWeekOffset } from "@/lib/weekRange";

export interface RadarAxis {
  key: string;
  label: string;
  color: string;
  count: number;
}

/**
 * 레이더가 집계하는 최소 모양 — area 태그만 있으면 된다. WorkSignal(브레인덤프 카드)과
 * 루틴 완료 occurrence 둘 다 이 모양으로 들어온다.
 */
export type TaggedActivity = Pick<WorkSignal, "area" | "areaTags">;

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
export function computeRadarAxes(
  signals: TaggedActivity[],
  tags: LifeWheelTagConfig[],
): RadarAxis[] {
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

/**
 * 표본 신뢰도(dev 810c637 weeklyLifeWheel에서 흡수한 개념): 근거가 빈약할 때 분포를 그대로
 * 신뢰하게 두지 않는다. 근거 없는 주를 "균형 잡힌 0 분포"처럼 오독하는 것을 막는다.
 *   measured=충분 / sparse=근거 있으나 빈약(참고용 플래그) / empty=분류된 완료 0(분포 없음).
 */
export type WeekConfidence = "measured" | "sparse" | "empty";

/** 이 값 이하의 표본(축에 집계된 총 완료 수)은 sparse로 플래그. */
export const DEFAULT_SPARSE_FLOOR = 2;

/** 선택 주에 enabled 축으로 집계된 완료 신호 총량(다중 태그는 축마다 1) → 그 주 표본 크기. */
export function weekSampleSize(signals: TaggedActivity[], tags: LifeWheelTagConfig[]): number {
  return computeRadarAxes(signals, tags).reduce((sum, a) => sum + a.count, 0);
}

/** 선택 주 레이더의 표본 신뢰도. 0=empty, ≤floor=sparse, 그 외 measured. */
export function weekConfidence(
  signals: TaggedActivity[],
  tags: LifeWheelTagConfig[],
  sparseFloor: number = DEFAULT_SPARSE_FLOOR,
): WeekConfidence {
  const total = weekSampleSize(signals, tags);
  if (total === 0) return "empty";
  if (total <= sparseFloor) return "sparse";
  return "measured";
}

/**
 * 루틴 완료 occurrence → 주 offset별 TaggedActivity 버킷(순수).
 * 레이더가 브레인덤프 카드뿐 아니라 루틴 이행도 활동 분포로 집계하기 위한 변환.
 * history의 done=true 날짜만, 그 날짜가 속한 주(offset)에 루틴의 area 태그로 1건씩.
 */
export function bucketRoutineDoneByOffset(
  items: RoutineTrackingItem[],
  today: string,
): Map<number, TaggedActivity[]> {
  return bucketByWeekOffset(
    items.flatMap((item) =>
      item.history
        .filter((day) => day.done)
        .map((day) => ({ date: day.date, value: { area: item.area, areaTags: item.areaTags } })),
    ),
    today,
  );
}
