import type { CalendarEvent, RoutineToday, WorkSignal } from "@/bindings";

import type { TimedBlock } from "./timelineLayout";

/**
 * Today×Timeline blocks 합성 (spec §4 데이터·§D8 카드 정본).
 *
 * - signal.linkedEventId가 있으면 매칭 google event를 흡수해 중복 렌더 방지.
 * - all-day 이벤트는 시간축에서 제외(스펙: AllDay strip은 트레이 영역).
 * - routine.timeOverride ?? routine.timeOfDay 순서로 가상 인스턴스 생성(30분 고정 길이).
 *
 * 순수함수: Date.now / 환경 의존 금지(단, `new Date(...)`는 입력 ISO 파싱용).
 */
type Input = {
  signals: WorkSignal[];
  events: CalendarEvent[];
  routines: RoutineToday[];
  /** YYYY-MM-DD (로컬 today). 루틴 가상 인스턴스 ISO 빌드용. */
  date: string;
};

const ROUTINE_DURATION_MIN = 30;
const SIGNAL_COLOR = "#4a7bb8";
const ROUTINE_COLOR = "#7aa84e";

function plusMin(iso: string, m: number): string {
  return new Date(new Date(iso).getTime() + m * 60_000).toISOString();
}

function isoFor(
  date: string,
  hhmm: string,
  durationMin = ROUTINE_DURATION_MIN,
): { startISO: string; endISO: string } {
  const [h, m] = hhmm.split(":").map(Number);
  const startISO = `${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  const endMs = new Date(startISO).getTime() + durationMin * 60_000;
  const endDate = new Date(endMs);
  const endISO = `${date}T${String(endDate.getHours()).padStart(2, "0")}:${String(
    endDate.getMinutes(),
  ).padStart(2, "0")}:00`;
  return { startISO, endISO };
}

export function buildTodayBlocks({
  signals,
  events,
  routines,
  date,
}: Input): TimedBlock[] {
  const out: TimedBlock[] = [];
  const absorbed = new Set<string>();

  for (const s of signals) {
    if (!s.scheduledAt || !s.scheduledDuration) continue;
    out.push({
      id: `signal:${s.id}`,
      kind: "signal",
      title: s.title,
      startISO: s.scheduledAt,
      endISO: plusMin(s.scheduledAt, s.scheduledDuration),
      calendarId: s.linkedCalendarId ?? "",
      color: SIGNAL_COLOR,
      linkedEventId: s.linkedEventId ?? undefined,
    });
    if (s.linkedEventId) absorbed.add(s.linkedEventId);
  }

  for (const e of events) {
    if (e.allDay) continue;
    if (absorbed.has(e.id)) continue;
    out.push({
      id: `event:${e.id}`,
      kind: "event",
      title: e.title,
      startISO: e.start,
      endISO: e.end ?? plusMin(e.start, 30),
      calendarId: e.calendarSummary ?? "",
      color: e.projectColor ?? "#888",
    });
  }

  for (const r of routines) {
    const time = r.timeOverride ?? r.timeOfDay;
    if (!time) continue;
    const { startISO, endISO } = isoFor(date, time);
    out.push({
      id: `routine:${r.id}`,
      kind: "routine",
      title: r.title,
      startISO,
      endISO,
      calendarId: r.linkedCalendarId ?? "",
      color: ROUTINE_COLOR,
    });
  }

  return out;
}
