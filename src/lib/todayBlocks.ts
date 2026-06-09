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
/**
 * 컬러는 CSS 토큰(`--color-today-*`, `--color-event-fallback`)을 var()로 참조한다.
 * 정의는 `src/styles/tokens.css`. 이 값들은 `style.borderLeftColor`로 인라인 적용된다 —
 * CSS variable string은 그대로 인라인 style에 유효(브라우저 resolve).
 */
const SIGNAL_COLOR = "var(--color-today-signal)";
const ROUTINE_COLOR = "var(--color-today-routine)";
const EVENT_FALLBACK_COLOR = "var(--color-event-fallback)";

/**
 * Event 블록의 bare Google event id.
 *
 * 블록 id는 `event:${calendarId}:${eventId}` 복합키다(아래 `buildTodayBlocks`) — 같은 eventId가
 * 여러 캘린더에 있을 때 블록이 합쳐지는 회귀를 막기 위함. 하지만 Google Calendar API write
 * 타깃(`patch_event`/`delete_event`)에는 calendarId 접두사 없는 **순수** eventId가 필요하다.
 * `event:` 접두사만 떼면 `${calendarId}:${eventId}`가 그대로 남아 events.patch가 404를 내므로
 * (드래그/리사이즈 회귀), 여기서 bare id를 정확히 뽑는다. `linkedEventId`가 곧 bare id이니 우선
 * 사용하고, 누락 시 복합키에서 알려진 `event:${calendarId}:` 접두사 길이만큼만 잘라낸다
 * (eventId 자체가 ':'를 포함해도 안전).
 */
export function eventBlockApiId(block: {
  id: string;
  calendarId: string;
  linkedEventId?: string;
}): string {
  return block.linkedEventId ?? block.id.slice(`event:${block.calendarId}:`.length);
}

function eventKey(calendarId: string | null | undefined, eventId: string | null | undefined) {
  return calendarId && eventId ? `${calendarId}\u0000${eventId}` : null;
}

function eventLookupKeys(e: CalendarEvent): string[] {
  return [eventKey(e.calendarId, e.id), eventKey(e.calendarId, e.recurringEventId)].filter(
    (key): key is string => Boolean(key),
  );
}

/**
 * 로컬-ISO(`YYYY-MM-DDTHH:MM:SS[+09:00]`)에서 로컬 날짜(YYYY-MM-DD)만 추출.
 * 본 코드베이스의 scheduledAt/이벤트 start는 전부 로컬-오프셋 ISO로 기록되므로
 * 앞 10자가 곧 로컬 날짜다(`new Date` 재파싱은 UTC 변환으로 자정 경계 off-by-one 위험 → 회피).
 */
function localDateOf(iso: string): string {
  return iso.slice(0, 10);
}

function plusMin(iso: string, m: number): string {
  // 로컬 ISO 보존(예: "2026-05-28T23:30:00"). `.toISOString()`을 쓰면 UTC로 변환되어
  // 다운스트림 `new Date(iso).getHours()`에서 시간이 어긋난다(KST=+9 등). 자정/DST 교차 시 블록 위치가 깨진다.
  const d = new Date(new Date(iso).getTime() + m * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
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

function hhmmOf(iso: string): string | null {
  return iso.length >= 16 ? iso.slice(11, 16) : null;
}

function eventDurationMin(e: CalendarEvent): number | null {
  if (!e.end) return null;
  const ms = new Date(e.end).getTime() - new Date(e.start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / 60_000);
}

function routineMatchesEvent(routine: RoutineToday, event: CalendarEvent): boolean {
  const time = routine.timeOverride ?? routine.timeOfDay;
  if (!time) return false;
  if (hhmmOf(event.start) !== time) return false;
  const duration = routine.durationMin ?? ROUTINE_DURATION_MIN;
  return eventDurationMin(event) === duration;
}

export function buildTodayBlocks({ signals, events, routines, date }: Input): TimedBlock[] {
  const out: TimedBlock[] = [];
  const absorbed = new Set<string>();
  const routineByEvent = new Map<string, RoutineToday>();
  const staleRoutineIds = new Set<string>();

  for (const s of signals) {
    if (!s.scheduledAt || !s.scheduledDuration) continue;
    // 선택 날짜 스코핑: Today 레일은 rollover라 미래/과거 배치 signal이 캐시에 남을 수 있다.
    // scheduledAt의 로컬 날짜가 보는 날짜와 다르면 렌더 제외 — "오늘 일정이 다른 날짜로 따라오는" 버그 방지.
    if (localDateOf(s.scheduledAt) !== date) continue;
    out.push({
      id: `signal:${s.id}`,
      kind: "signal",
      title: s.title,
      startISO: s.scheduledAt,
      endISO: plusMin(s.scheduledAt, s.scheduledDuration),
      calendarId: s.linkedCalendarId ?? "",
      calendarLabel: s.linkedCalendarId ?? "",
      color: SIGNAL_COLOR,
      linkedEventId: s.linkedEventId ?? undefined,
      done: Boolean(s.todayDoneAt),
    });
    const key = eventKey(s.linkedCalendarId, s.linkedEventId);
    if (key) absorbed.add(key);
  }
  for (const r of routines) {
    if (!(r.timeOverride ?? r.timeOfDay)) continue;
    const key = eventKey(
      r.linkedCalendarId ?? r.googleCalendarId,
      r.linkedEventId ?? r.googleEventId,
    );
    if (key) routineByEvent.set(key, r);
  }

  for (const e of events) {
    if (e.allDay) continue;
    const key = eventKey(e.calendarId, e.id);
    if (key && absorbed.has(key)) continue;
    const routine = eventLookupKeys(e)
      .map((lookupKey) => routineByEvent.get(lookupKey))
      .find((candidate): candidate is RoutineToday => Boolean(candidate));
    if (routine && !routineMatchesEvent(routine, e)) {
      if (key) absorbed.add(key);
      staleRoutineIds.add(routine.id);
      continue;
    }
    out.push({
      id: `event:${e.calendarId}:${e.id}`,
      kind: "event",
      title: routine?.title ?? e.title,
      startISO: e.start,
      endISO: e.end ?? plusMin(e.start, 30),
      calendarId: e.calendarId,
      calendarLabel: e.calendarSummary,
      color: e.projectColor ?? EVENT_FALLBACK_COLOR,
      linkedEventId: e.id,
      done: routine?.done,
      routineId: routine?.id,
    });
  }

  for (const r of routines) {
    const time = r.timeOverride ?? r.timeOfDay;
    if (!time) continue;
    const linkedCalendarId = r.linkedCalendarId ?? r.googleCalendarId;
    const linkedEventId = r.linkedEventId ?? r.googleEventId;
    if (eventKey(linkedCalendarId, linkedEventId) && !staleRoutineIds.has(r.id)) continue;
    const { startISO, endISO } = isoFor(date, time, r.durationMin ?? ROUTINE_DURATION_MIN);
    out.push({
      id: `routine:${r.id}`,
      kind: "routine",
      title: r.title,
      startISO,
      endISO,
      calendarId: linkedCalendarId ?? "",
      calendarLabel: linkedCalendarId ?? "",
      color: ROUTINE_COLOR,
      linkedEventId: linkedEventId ?? undefined,
      done: r.done,
      routineId: r.id,
    });
  }

  return out;
}
