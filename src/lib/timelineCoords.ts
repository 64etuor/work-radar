/**
 * 타임라인 픽셀 ↔ 로컬 ISO 변환(연속 절대 분 축) — useTimelineDnd에서 추출한 순수 함수.
 * 60px/h, 15분 스냅. 클램프는 하루(0..1425)가 아니라 로드된 범위 [0, days*1440-15].
 * RFC3339 로컬 오프셋 필수(백엔드 parse_from_rfc3339) — 오프셋은 대상 "날짜"의 것.
 */
import { absMin, isoFromAbsMin } from "./timeAxis";
import { HOUR_PX, MIN_PER_DAY, SNAP_MIN } from "./timelineAxis";
/** 자석 엣지 스냅 임계(분=px, 1px=1min). 인접 블록 start/end에 이 범위 내면 그리드보다 우선. */
const MAGNET_THRESHOLD_MIN = 6;

export type SnapOpts = {
  /** 그리드 스냅 단위(분). 기본 15. Alt/Option fine-snap 시 5. */
  snapMin?: number;
  /** 자석 후보 엣지(절대 분) — 인접 블록 start/end. 비거나 미지정이면 그리드만. */
  magnetEdges?: number[];
  /** 자석 임계(분). 기본 6. */
  magnetThresholdMin?: number;
};

function gridSnap(min: number, snapMin: number = SNAP_MIN): number {
  return Math.round(min / snapMin) * snapMin;
}

/**
 * 절대 분 스냅 — 자석 엣지가 임계 내에 있으면 가장 가까운 엣지로(그리드보다 우선), 아니면 그리드.
 * 순수 함수. 자석 엣지/그리드 단위는 opts로 주입(기본=그리드 15, 자석 없음).
 */
export function snapAbsMin(rawMin: number, opts?: SnapOpts): number {
  const snapMin = opts?.snapMin ?? SNAP_MIN;
  const edges = opts?.magnetEdges;
  const threshold = opts?.magnetThresholdMin ?? MAGNET_THRESHOLD_MIN;
  if (edges && edges.length > 0) {
    let nearest = edges[0];
    let nearestDist = Math.abs(rawMin - edges[0]);
    for (let i = 1; i < edges.length; i++) {
      const d = Math.abs(rawMin - edges[i]);
      if (d < nearestDist) {
        nearestDist = d;
        nearest = edges[i];
      }
    }
    if (nearestDist <= threshold) return nearest;
  }
  return gridSnap(rawMin, snapMin);
}

function clampAbs(min: number, days: number): number {
  return Math.max(0, Math.min(days * MIN_PER_DAY - SNAP_MIN, min));
}

/**
 * 그리드 픽셀(절대 Y) → 스냅+클램프된 절대 분. pixelToLocalIso의 수학 절반 —
 * 드롭 가이드 라인(px==min)이 commit과 동일한 스냅을 쓰도록 분 단위를 노출한다.
 */
export function pixelToAbsMin(days: number, gridY: number, opts?: SnapOpts): number {
  return clampAbs(snapAbsMin((gridY / HOUR_PX) * 60, opts), days);
}

/** 그리드 픽셀(절대 Y) → 로컬 ISO. 날짜는 Y에서 유도(자정 넘는 배치 가능). opts로 fine-snap/자석. */
export function pixelToLocalIso(
  anchorDate: string,
  days: number,
  gridY: number,
  opts?: SnapOpts,
): string {
  return isoFromAbsMin(anchorDate, pixelToAbsMin(days, gridY, opts));
}

/** 기존 ISO + delta px → 새 ISO. 절대 분 기준이라 자정 통과 자동. */
export function shiftIsoByPx(
  anchorDate: string,
  days: number,
  startISO: string,
  deltaPx: number,
  opts?: SnapOpts,
): string {
  const abs = clampAbs(
    snapAbsMin(absMin(startISO, anchorDate) + (deltaPx / HOUR_PX) * 60, opts),
    days,
  );
  return isoFromAbsMin(anchorDate, abs);
}

/**
 * 리사이즈: top=시작 이동(끝 고정), bottom=duration 변경. 자정 경계 클램프 없음(로드 범위만).
 * 최소 길이 = 스냅 단위(기본 15분, Alt fine-snap이면 5분) — fine-snap에서 5분 블록을 만들 수 있다.
 */
export function resizeIsoByPx({
  anchorDate,
  days,
  startISO,
  durationMin,
  edge,
  deltaPx,
  snapOpts,
}: {
  anchorDate: string;
  days: number;
  startISO: string;
  durationMin: number;
  edge: "top" | "bottom";
  deltaPx: number;
  snapOpts?: SnapOpts;
}): { at: string; durationMin: number } {
  const startAbs = absMin(startISO, anchorDate);
  const endAbs = startAbs + durationMin;
  const deltaMin = (deltaPx / HOUR_PX) * 60;
  const minDur = snapOpts?.snapMin ?? SNAP_MIN;
  if (edge === "top") {
    const nextStart = Math.max(
      0,
      Math.min(endAbs - minDur, snapAbsMin(startAbs + deltaMin, snapOpts)),
    );
    return { at: isoFromAbsMin(anchorDate, nextStart), durationMin: endAbs - nextStart };
  }
  const snappedEnd = snapAbsMin(endAbs + deltaMin, snapOpts);
  const durationMinNext = Math.max(
    minDur,
    Math.min(days * MIN_PER_DAY - startAbs, snappedEnd - startAbs),
  );
  return { at: startISO, durationMin: durationMinNext };
}

/**
 * ISO를 주어진 날짜 안으로 클램프(루틴 occurrence 클램프 — routine_checks는
 * date+HH:MM 구조라 다음 날 새벽 표현 불가, 연속 타임라인 스펙 §5).
 */
export function clampIsoToDate(iso: string, date: string): string {
  const within = Math.max(0, Math.min(1440 - SNAP_MIN, absMin(iso, date)));
  return isoFromAbsMin(date, within);
}

/**
 * duration을 주어진 날짜의 자정까지로 클램프(루틴 bottom-resize — 끝이 자정을 넘으면
 * Google-synced 루틴의 master event end가 다음 날로 새어 스펙 §5와 모순된다).
 */
export function clampDurationToDate(startISO: string, date: string, durationMin: number): number {
  return Math.max(SNAP_MIN, Math.min(1440 - absMin(startISO, date), durationMin));
}

/**
 * 로컬 ISO + n분 — 로컬 표기 보존(`.toISOString()` UTC 변환 금지, todayBlocks.plusMin과 동일
 * 근거). 입력에 오프셋이 있으면 그대로 유지한다(분 가산은 오프셋을 바꾸지 않음 — DST 비고려는
 * 기존 plusMinutesLocal 동작과 동일).
 */
export function plusMinutesLocal(iso: string, minutes: number): string {
  const d = new Date(new Date(iso).getTime() + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMatch = iso.match(/([+-]\d{2}:\d{2})$/);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offsetMatch?.[1] ?? ""}`;
}
