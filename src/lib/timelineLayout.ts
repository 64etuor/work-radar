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
