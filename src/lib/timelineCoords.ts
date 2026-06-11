/**
 * 타임라인 픽셀 ↔ 로컬 ISO 변환(연속 절대 분 축) — useTimelineDnd에서 추출한 순수 함수.
 * 60px/h, 15분 스냅. 클램프는 하루(0..1425)가 아니라 로드된 범위 [0, days*1440-15].
 * RFC3339 로컬 오프셋 필수(백엔드 parse_from_rfc3339) — 오프셋은 대상 "날짜"의 것.
 */
import { absMin, isoFromAbsMin } from "./timeAxis";

const HOUR_PX = 60;
const SNAP_MIN = 15;

function snap(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

function clampAbs(min: number, days: number): number {
  return Math.max(0, Math.min(days * 1440 - SNAP_MIN, min));
}

/** 그리드 픽셀(절대 Y) → 로컬 ISO. 날짜는 Y에서 유도(자정 넘는 배치 가능). */
export function pixelToLocalIso(anchorDate: string, days: number, gridY: number): string {
  const abs = clampAbs(snap((gridY / HOUR_PX) * 60), days);
  return isoFromAbsMin(anchorDate, abs);
}

/** 기존 ISO + delta px → 새 ISO. 절대 분 기준이라 자정 통과 자동. */
export function shiftIsoByPx(
  anchorDate: string,
  days: number,
  startISO: string,
  deltaPx: number,
): string {
  const abs = clampAbs(snap(absMin(startISO, anchorDate) + (deltaPx / HOUR_PX) * 60), days);
  return isoFromAbsMin(anchorDate, abs);
}

/** 리사이즈: top=시작 이동(끝 고정), bottom=duration 변경. 자정 경계 클램프 없음(로드 범위만). */
export function resizeIsoByPx({
  anchorDate,
  days,
  startISO,
  durationMin,
  edge,
  deltaPx,
}: {
  anchorDate: string;
  days: number;
  startISO: string;
  durationMin: number;
  edge: "top" | "bottom";
  deltaPx: number;
}): { at: string; durationMin: number } {
  const startAbs = absMin(startISO, anchorDate);
  const endAbs = startAbs + durationMin;
  const deltaMin = (deltaPx / HOUR_PX) * 60;
  if (edge === "top") {
    const nextStart = Math.max(0, Math.min(endAbs - SNAP_MIN, snap(startAbs + deltaMin)));
    return { at: isoFromAbsMin(anchorDate, nextStart), durationMin: endAbs - nextStart };
  }
  const maxDuration = days * 1440 - startAbs;
  return {
    at: startISO,
    durationMin: Math.max(SNAP_MIN, Math.min(maxDuration, snap(durationMin + deltaMin))),
  };
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
