/**
 * CSS 모션 토큰(src/styles/tokens.css `--wr-motion-*` / `--wr-ease-*`)의 JS 미러.
 * motion/react 등 JS 애니메이션은 CSS var를 직접 못 읽으므로 여기 상수를 쓴다 —
 * 값 변경 시 tokens.css와 함께 갱신한다(SSOT는 tokens.css).
 */
export const WR_MOTION = {
  fast: 0.12,
  base: 0.18,
  slow: 0.28,
  panel: 0.22,
  drawer: 0.32,
  space: 0.42,
} as const;

/** cubic-bezier 좌표 — motion/react `ease` prop 호환 형식(BezierDefinition은 mutable tuple). */
export const WR_EASE: Record<"out" | "in" | "spring" | "space", [number, number, number, number]> =
  {
    out: [0.16, 1, 0.3, 1],
    in: [0.7, 0, 0.84, 0],
    spring: [0.2, 0.8, 0.2, 1],
    space: [0.22, 1, 0.36, 1],
  };
