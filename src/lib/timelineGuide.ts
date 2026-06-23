/**
 * 드롭 가이드 x좌표 합성 — 순수 함수(@dnd-kit 비의존).
 *
 * planner(timelineDragPlan.ts §computeGuide)는 guide.x를 caller로 미룬다(레이아웃 폭은
 * 렌더 시점에만 안다). TimelineCanvas의 IIFE 안에 인라인돼 있던 정확한 x 계산을 그대로
 * 옮긴 것 — 60px 시간 라벨 거터 다음에서 블록 레이어를 폭으로 배치하고, active 블록의
 * 가로 중심에 deltaX를 더한 뒤 [60, gridWidth]로 클램프한다(now-deleted dragGuideFromLayout 포트).
 */
export type SynthesizeGuideXInput = {
  /** active 박스의 visual.leftPct(0..100) — 블록 레이어 안에서의 좌측 위치. */
  leftPct: number;
  /** active 박스의 visual.widthPct(0..100). */
  widthPct: number;
  /** 그리드 전체 폭(px). 시간 라벨 거터 60px 포함. */
  gridWidth: number;
  /** 라이브 드래그 가로 델타(px). 세로 타임라인이라 보통 0이지만 동일하게 반영. */
  deltaX: number;
};

/** 블록 레이어 좌측 거터(시간 라벨 폭, px) — TimelineCanvas의 60과 동일 SSOT. */
const GUTTER_PX = 60;
/** 블록 우측 inset(px) — 컬럼 간 간격. visual width에서 깎인다. */
const BLOCK_RIGHT_INSET_PX = 4;

export function synthesizeGuideX({
  leftPct,
  widthPct,
  gridWidth,
  deltaX,
}: SynthesizeGuideXInput): number {
  const layerWidth = Math.max(0, gridWidth - GUTTER_PX);
  const left = GUTTER_PX + (layerWidth * leftPct) / 100;
  const width = Math.max(0, (layerWidth * widthPct) / 100 - BLOCK_RIGHT_INSET_PX);
  const centerX = left + width / 2 + deltaX;
  return Math.max(GUTTER_PX, Math.min(gridWidth, centerX));
}
