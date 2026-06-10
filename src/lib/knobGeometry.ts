export type KnobDir = "up" | "down" | "left" | "right";

/** 드래그 오프셋(dx,dy)을 반경 안으로 원형 클램프. 반경 안/0이면 그대로. */
export function clampToThrow(dx: number, dy: number, radius: number): { x: number; y: number } {
  const dist = Math.hypot(dx, dy);
  if (dist <= radius || dist === 0) return { x: dx, y: dy };
  const k = radius / dist;
  return { x: dx * k, y: dy * k };
}

/**
 * 현재 편향에서 armed 방향 판정. 우세 축의 절대값이 임계(radius*ratio)를 넘으면 그 축으로,
 * 단 그 방향이 disabled(미바인딩)면 **다른 축이 임계를 넘고 enabled일 때 그쪽으로 폴백**한다.
 * 화면 좌표라 위쪽이 음의 y.
 *
 * 폴백이 필요한 이유: 방향은 원점 대비 절대 위치의 우세 축으로 정해지는데, 상하가 기본
 * 미바인딩(nav.ts)이라 "위로 크게 밀었다가 좌로 curve"하면 좌측 성분이 임계를 넘어도 세로 축이
 * 우세한 동안 up(dead)으로 판정돼 발사가 안 되던 결함을 막는다. 우세 축이 enabled면 종전과 동일.
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
  // 각 축이 임계를 넘었을 때의 후보(미만이면 null).
  const horiz: KnobDir | null = ax >= threshold ? (dx < 0 ? "left" : "right") : null;
  const vert: KnobDir | null = ay >= threshold ? (dy < 0 ? "up" : "down") : null;
  // 우세 축 우선, 그 방향이 disabled면 다른 축으로 폴백(타이브레이크는 종전대로 가로 우선).
  const primary = ax >= ay ? horiz : vert;
  const secondary = ax >= ay ? vert : horiz;
  for (const cand of [primary, secondary]) {
    if (cand && enabled[cand]) return cand;
  }
  return null;
}

/**
 * 드래그 한 프레임의 결과: **판정은 raw(커서-원점) 좌표, 표시는 림 클램프**. 호출부가 둘을
 * 묶어 쓰게 강제한다 — 클램프된 좌표로 판정하면 각도 보존 축소 때문에 한 축으로 멀리 간 뒤의
 * 다른 축 성분이 임계 아래로 희석돼(60px→17px) "위로 밀었다 좌로 꺾으면 무반응"이 된다.
 * raw 판정은 상태가 없어(직전 경로 무관, 현재 위치만) 결정적이다.
 */
export function knobFrame(
  dx: number,
  dy: number,
  radius: number,
  ratio: number,
  enabled: Record<KnobDir, boolean>,
): { offset: { x: number; y: number }; armed: KnobDir | null } {
  return {
    offset: clampToThrow(dx, dy, radius),
    armed: armedDirection(dx, dy, radius, ratio, enabled),
  };
}
