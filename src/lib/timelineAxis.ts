/**
 * 타임라인 좌표 정본(SSOT) — 시간↔픽셀 상수 + 무상태 변환 헬퍼.
 *
 * 이 모듈만 픽셀-per-시간을 정의한다. 다른 어떤 파일도 HOUR_PX/DAY_PX를
 * 로컬 정의하지 않는다(SSOT 설계 `docs/superpowers/specs/2026-06-20-...-ssot-design.md` §3.1).
 *
 * 도메인 주의: `1px == 1min`은 HOUR_PX=60이라서 성립한다. 픽셀량(DAY_PX/totalPxForDays)과
 * 분량(MIN_PER_DAY)을 절대 섞지 않는다 — 수치는 같아도 의미가 다르다.
 */

/** 1시간 = 60px (연속 타임라인 스펙 §D2). */
export const HOUR_PX = 60;
/** 렌더 시 블록 최소 높이(px) — 짧은 블록 가독성 floor. */
export const MIN_BLOCK_PX = 20;
/** 기본 그리드 스냅 단위(분). Alt/Option fine-snap 시 5. */
export const SNAP_MIN = 15;
/** 하루 분(min). 절대-분 축 클램프용 — 픽셀 아님. */
export const MIN_PER_DAY = 1440;
/** 1분당 픽셀. HOUR_PX/60. */
export const PX_PER_MIN = HOUR_PX / 60;
/** 하루 높이(px) = 60px/h × 24h. MIN_PER_DAY와 수치 동일하나 의미는 픽셀. */
export const DAY_PX = 24 * HOUR_PX;
/** 시간 라벨 거터 너비(px) — 그리드 컬럼 왼쪽 여백. client→grid x 클램프 하한. */
export const LABEL_GUTTER_PX = 60;

/** 절대 분 → 픽셀(Y). */
export function minToPx(min: number): number {
  return min * PX_PER_MIN;
}

/** 픽셀(Y) → 절대 분. */
export function pxToMin(px: number): number {
  return px / PX_PER_MIN;
}

/** 로드된 일수의 그리드 총 높이(px). */
export function totalPxForDays(days: number): number {
  return days * DAY_PX;
}

/**
 * viewport client 좌표 → 그리드 로컬 좌표. y는 [0, totalPx], x는
 * [LABEL_GUTTER_PX, rect.width]로 클램프. 타임라인 전역의 유일한 client→grid 변환.
 */
export function clientToGrid(
  point: { x: number; y: number },
  rect: { left: number; top: number; width: number },
  totalPx: number,
): { x: number; y: number } {
  return {
    y: Math.max(0, Math.min(totalPx, point.y - rect.top)),
    x: Math.max(LABEL_GUTTER_PX, Math.min(rect.width, point.x - rect.left)),
  };
}
