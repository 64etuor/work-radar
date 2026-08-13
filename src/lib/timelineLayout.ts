/**
 * ATracker식 시간축 겹침 분할 (spec §8.5).
 *
 * 입력 `TimedBlock[]`(로컬 시각 ISO)을 시작시각 기준으로 정렬한 뒤
 * 전이적으로 겹치는 클러스터를 만들고, 각 클러스터 안에서 그리디 컬럼 할당으로
 * `leftPct`/`widthPct`를 계산해 반환한다.
 *
 * - 순수함수: Date.now / 무작위 입력 사용 금지. 동일 입력 → 동일 출력.
 * - 연속 절대 분 축(앵커 날짜 00:00 기준) — 자정 걸침 블록은 단일 연속 박스로 그려진다
 *   (연속 타임라인 스펙 `docs/superpowers/specs/2026-06-11-continuous-timeline-design.md` §2).
 * - 60px/시간(스펙 §D2). `heightPx`는 최소 20px 보정.
 */

import { absMin, localDateOf } from "./timeAxis";
import { MIN_BLOCK_PX } from "./timelineAxis";

export type TimedBlock = {
  id: string;
  kind: "signal" | "routine" | "event";
  title: string;
  /** 로컬 시각 ISO ("YYYY-MM-DDTHH:MM:SS"). */
  startISO: string;
  endISO: string;
  /** Actual external/local calendar id used for write targets. */
  calendarId: string;
  /** Human-readable calendar label. Falls back to `calendarId`. */
  calendarLabel?: string;
  /** border-left-color (스펙 §D8 카드 컬러). */
  color: string;
  /** 신호가 Google event를 mirror할 때 사용 (중복 렌더 회피). */
  linkedEventId?: string;
  /** 루틴 블록 완료 여부 (오늘 routine_checks 행 존재). 다른 kind에선 무의미. */
  done?: boolean;
  /** 루틴 블록의 routine_id (popover 토글 호출용). 다른 kind에선 무의미. */
  routineId?: string;
  /** signal 블록의 원본 signal id — id는 `signal:${id}:${date}`라 파싱 대신 이 필드를 쓴다. */
  signalId?: string;
};

export type TimelineHitRect = { topPx: number; heightPx: number };

export const RESIZE_HANDLE_PX = 6; // single source; was resizeHandleHeightPx()

export type LayoutBox = {
  id: string;
  block: TimedBlock;
  semantic: { startAbs: number; endAbs: number; durationMin: number };
  visual: { topPx: number; heightPx: number; leftPct: number; widthPct: number };
  hit: {
    topHandle: TimelineHitRect;
    bottomHandle: TimelineHitRect;
    moveBand: TimelineHitRect | null;
  };
};

/**
 * @param anchorDate 절대 분 축의 0점(YYYY-MM-DD, 로드된 가장 이른 날). 생략 시 블록 중
 * 가장 이른 startISO의 날짜 — 단일일 호출 하위호환(기존 테스트/단일일 사용처).
 */
export function computeLayout(blocks: TimedBlock[], anchorDate?: string): LayoutBox[] {
  if (blocks.length === 0) return [];
  const anchor =
    anchorDate ??
    blocks.reduce(
      (min, b) => (localDateOf(b.startISO) < min ? localDateOf(b.startISO) : min),
      localDateOf(blocks[0].startISO),
    );
  const toMin = (iso: string) => absMin(iso, anchor);
  const items = [...blocks].sort((a, b) => {
    const sa = toMin(a.startISO);
    const sb = toMin(b.startISO);
    if (sa !== sb) return sa - sb;
    return a.id.localeCompare(b.id);
  });

  // 클러스터링: 전이적 겹침을 한 그룹으로.
  const clusters: TimedBlock[][] = [];
  let cur: TimedBlock[] = [];
  let curMaxEnd = -Infinity;
  for (const b of items) {
    const start = toMin(b.startISO);
    if (cur.length === 0) {
      cur.push(b);
      curMaxEnd = toMin(b.endISO);
      continue;
    }
    if (start < curMaxEnd) {
      cur.push(b);
      curMaxEnd = Math.max(curMaxEnd, toMin(b.endISO));
    } else {
      clusters.push(cur);
      cur = [b];
      curMaxEnd = toMin(b.endISO);
    }
  }
  if (cur.length) clusters.push(cur);

  const out: LayoutBox[] = [];
  for (const cluster of clusters) {
    // 그리디 컬럼 할당: 각 컬럼 = 최근 end 시각.
    const colEnds: number[] = [];
    const colOf = new Map<string, number>();
    for (const b of cluster) {
      const s = toMin(b.startISO);
      let placed = -1;
      for (let i = 0; i < colEnds.length; i++) {
        if (colEnds[i] <= s) {
          placed = i;
          break;
        }
      }
      if (placed === -1) {
        placed = colEnds.length;
        colEnds.push(toMin(b.endISO));
      } else {
        colEnds[placed] = toMin(b.endISO);
      }
      colOf.set(b.id, placed);
    }
    const n = colEnds.length;
    const widthPct = 100 / n;
    for (const b of cluster) {
      const col = colOf.get(b.id)!;
      const startMin = toMin(b.startISO);
      const endMin = toMin(b.endISO);
      const leftPct = col * widthPct;
      const semantic = { startAbs: startMin, endAbs: endMin, durationMin: endMin - startMin };
      const visual = {
        topPx: startMin,
        heightPx: Math.max(MIN_BLOCK_PX, endMin - startMin),
        leftPct,
        widthPct,
      };
      const topHandle: TimelineHitRect = { topPx: semantic.startAbs, heightPx: RESIZE_HANDLE_PX };
      const bottomHandle: TimelineHitRect = {
        topPx: semantic.endAbs - RESIZE_HANDLE_PX,
        heightPx: RESIZE_HANDLE_PX,
      };
      const moveTop = topHandle.topPx + RESIZE_HANDLE_PX;
      const moveH = bottomHandle.topPx - moveTop;
      const moveBand: TimelineHitRect | null =
        moveH > 0 ? { topPx: moveTop, heightPx: moveH } : null;
      out.push({
        id: b.id,
        block: b,
        semantic,
        visual,
        hit: { topHandle, bottomHandle, moveBand },
      });
    }
  }

  // hit-rect 겹침 방지(드래그 핸들 오발동 근본 수정): MIN_BLOCK_PX(20px) 바닥이 정확한 topPx와
  // 결합하면, 같은 가로 컬럼을 공유하는 맞붙는 짧은 블록(예: 15분 블록 두 개)의 wrap이 5px 겹쳐
  // 6px 리사이즈 핸들이 같은 픽셀을 두고 다툰다 → 페인트 순서로 포인터가 잘못된 블록을 잡는다.
  // 시작이 더 이른 블록의 높이를, 가로로 겹치는 '다음(아래)' 블록의 visual.topPx를 넘지 않게 클램프한다.
  // 가로로 겹치는 블록끼리는 시간상 겹치지 않으므로(겹치면 다른 컬럼=가로 분리) 실제 길이 밑으로는
  // 절대 줄지 않는다(맞붙으면 정확한 길이로, 5px+ 간격이 있으면 바닥 그대로 유지).
  // 한계(범위 외): 클램프 후 높이가 12px 미만이면 한 블록의 상/하 6px 핸들끼리 겹친다 — 하지만
  // 이는 같은 블록 내 엣지 모호성일 뿐(둘 다 그 블록을 리사이즈), 보고된 '다른 블록' 오발동이 아니다.
  const horizontallyOverlaps = (p: LayoutBox, q: LayoutBox): boolean =>
    p.visual.leftPct < q.visual.leftPct + q.visual.widthPct &&
    q.visual.leftPct < p.visual.leftPct + p.visual.widthPct;
  for (const box of out) {
    const boxTopPx = box.visual.topPx;
    let nextTopPx = Infinity;
    for (const other of out) {
      if (other === box) continue;
      const otherTopPx = other.visual.topPx;
      if (otherTopPx <= boxTopPx) continue; // 아래쪽(시작이 더 늦은) 블록만
      if (!horizontallyOverlaps(box, other)) continue;
      if (otherTopPx < nextTopPx) nextTopPx = otherTopPx;
    }
    if (nextTopPx !== Infinity && boxTopPx + box.visual.heightPx > nextTopPx) {
      box.visual.heightPx = nextTopPx - boxTopPx;
    }
  }
  return out;
}

/**
 * 자석 엣지 후보 = excludeId를 제외한 모든 박스의 실제 start/end(절대 분). heightPx(=floor 20px)가
 * 아니라 block.startISO/endISO에서 유도해 짧은 블록의 끝도 정확하다. 순수 함수.
 */
export function magnetEdgesFromBoxes(
  boxes: LayoutBox[],
  anchorDate: string,
  excludeId: string | null,
): number[] {
  const edges: number[] = [];
  for (const b of boxes) {
    if (b.id === excludeId) continue;
    edges.push(absMin(b.block.startISO, anchorDate));
    edges.push(absMin(b.block.endISO, anchorDate));
  }
  return edges;
}
