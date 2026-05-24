// 에이전트 바(정체성 박스) 순수 계산 — 시간 의존 로직을 `now`/`elapsed` 인자로 받는
// 순수 함수로 분리한다(P10a). 표시 전용: 어떤 결정 로직에도 입력으로 쓰지 않는다(INVARIANT #1).
//
// 단위테스트 대상:
//  - 경과 → 진행 ratio(0~1, 단조 증가 + 상한 포화).
//  - 경과 → 박스 width(idle=초기 width, 작업 지속 시 단조 증가 + 상한 포화).
//  - 개수 상한 + '+N' 오버플로 계산.

/** 박스 개수 상한 (DESIGN.md `agent-status-bar`: 8). 초과분은 '+N' 칩으로 접는다. */
export const MAX_BOXES = 8;

/** 박스 width 경계 (DESIGN.md: idle ~96px → 상한 ~240px, bounded). */
export const BOX_MIN_PX = 96;
export const BOX_MAX_PX = 240;

/**
 * timeout 없는 외부 세션(hermes/cmux)의 width/진행이 상한에 도달하는 기준 경과(초).
 * 이 값에 도달하면 ratio=1로 포화 — 무한 증가 금지(bounded ethos).
 */
export const UNBOUNDED_SATURATE_SEC = 30 * 60; // 30분

/** 박스 시각 상태. 상태등(색 dot)으로 표시하고 텍스트는 aria-label/title로만 제공.
 *  waiting = 사람 입력/승인 대기(cmux "Needs input" 등) — working(실행)과 색으로 구분. */
export type BoxState = "idle" | "working" | "waiting" | "error";

/**
 * 경과(초) → 진행 ratio(0~1).
 * - timeout 있는 잡(codex): elapsed / timeout (기존 elapsedRatio 확장).
 * - timeout 없는 세션(hermes/cmux): elapsed / saturateSec.
 * 음수 경과는 0, 상한 초과는 1로 포화(단조 증가 보장).
 */
export function progressRatio(
  elapsedSec: number,
  timeoutSec: number | null,
  saturateSec: number = UNBOUNDED_SATURATE_SEC,
): number {
  const denom = timeoutSec != null && timeoutSec > 0 ? timeoutSec : saturateSec;
  if (denom <= 0) return 0;
  return clamp01(elapsedSec / denom);
}

/**
 * 박스 width(px) — 경과 시간 기반.
 * - idle(working=false): 항상 초기 width(BOX_MIN_PX). 경과 무시.
 * - working: BOX_MIN_PX → BOX_MAX_PX 선형 성장, ratio=1에서 포화(상한).
 * ratio는 progressRatio()로 산출된 0~1 값을 받는다.
 */
export function boxWidth(
  ratio: number,
  working: boolean,
  minPx: number = BOX_MIN_PX,
  maxPx: number = BOX_MAX_PX,
): number {
  if (!working) return minPx;
  const r = clamp01(ratio);
  return Math.round(minPx + r * (maxPx - minPx));
}

/**
 * 박스 개수 상한 + '+N' 오버플로 계산.
 * total개 중 앞에서 max개만 표시, 나머지는 overflow로 접는다.
 * - visibleCount: 실제 렌더할 박스 수(0~max).
 * - overflow: 접힌 박스 수('+N' 칩, 0이면 칩 없음).
 */
export function overflowSplit(
  total: number,
  max: number = MAX_BOXES,
): { visibleCount: number; overflow: number } {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeMax = Math.max(0, Math.floor(max));
  const visibleCount = Math.min(safeTotal, safeMax);
  const overflow = Math.max(0, safeTotal - safeMax);
  return { visibleCount, overflow };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
