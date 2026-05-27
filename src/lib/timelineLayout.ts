/**
 * ATracker식 시간축 겹침 분할 (spec §8.5).
 *
 * 입력 `TimedBlock[]`(로컬 시각 ISO)을 시작시각 기준으로 정렬한 뒤
 * 전이적으로 겹치는 클러스터를 만들고, 각 클러스터 안에서 그리디 컬럼 할당으로
 * `leftPct`/`widthPct`를 계산해 반환한다.
 *
 * - 순수함수: Date.now / 무작위 입력 사용 금지. 동일 입력 → 동일 출력.
 * - 멀티데이 블록은 범위 밖(스펙). 모든 블록은 분 단위(0..1440) 기준.
 * - 60px/시간(스펙 §D2). `heightPx`는 최소 20px 보정.
 */

export type TimedBlock = {
  id: string;
  kind: "signal" | "routine" | "event";
  title: string;
  /** 로컬 시각 ISO ("YYYY-MM-DDTHH:MM:SS"). */
  startISO: string;
  endISO: string;
  calendarId: string;
  /** border-left-color (스펙 §D8 카드 컬러). */
  color: string;
  /** 신호가 Google event를 mirror할 때 사용 (중복 렌더 회피). */
  linkedEventId?: string;
};

export type LayoutBox = {
  id: string;
  topPx: number;
  heightPx: number;
  /** 0..100 — 그리드 영역 내 백분율 (60px 라벨 거터는 호출부 CSS가 처리). */
  leftPct: number;
  widthPct: number;
  block: TimedBlock;
};

const HOUR_PX = 60;
const MIN_BLOCK_PX = 20;

function toMin(iso: string): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
}

export function computeLayout(blocks: TimedBlock[]): LayoutBox[] {
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
      out.push({
        id: b.id,
        topPx: startMin * (HOUR_PX / 60),
        heightPx: Math.max(MIN_BLOCK_PX, (endMin - startMin) * (HOUR_PX / 60)),
        leftPct: col * widthPct,
        widthPct,
        block: b,
      });
    }
  }
  return out;
}
