export type KnobDir = "up" | "down" | "left" | "right";

/** 드래그 오프셋(dx,dy)을 반경 안으로 원형 클램프. 반경 안/0이면 그대로. */
export function clampToThrow(dx: number, dy: number, radius: number): { x: number; y: number } {
  const dist = Math.hypot(dx, dy);
  if (dist <= radius || dist === 0) return { x: dx, y: dy };
  const k = radius / dist;
  return { x: dx * k, y: dy * k };
}

/**
 * 현재 편향에서 armed 방향 판정. 우세 축의 절대값이 임계(radius*ratio)를 넘고
 * 그 방향이 enabled일 때만 방향 반환. 화면 좌표라 위쪽이 음의 y.
 */
export function armedDirection(
  dx: number,
  dy: number,
  radius: number,
  ratio: number,
  enabled: Record<KnobDir, boolean>,
): KnobDir | null {
  const threshold = radius * ratio;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < threshold && ay < threshold) return null;
  const dir: KnobDir = ax >= ay ? (dx < 0 ? "left" : "right") : dy < 0 ? "up" : "down";
  return enabled[dir] ? dir : null;
}
