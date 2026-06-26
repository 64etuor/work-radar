import type {
  CalendarEvent,
  RoutineToday,
  SignalDayPlacement,
  TimelineNoteTarget,
  WorkSignal,
} from "@/bindings";

import { plusMinutesLocal } from "./timelineCoords";
import type { TimedBlock } from "./timelineLayout";

/**
 * 타임라인 블록 → timeline_notes 타깃(target_kind, target_id) 매핑.
 * EventPopover(메모 편집)와 TodayView(블록 위 메모 표시)가 같은 키를 쓰도록 단일 정본.
 * 메모를 가질 수 없는 블록(미동기화 event 등)은 null.
 *   - signal: id 본체(`signal:` 접두사 제거)
 *   - routine: routineId
 *   - event: `{calendarId}:{linkedEventId}` (둘 다 있을 때만)
 */
export function blockNoteTarget(
  block: Pick<
    TimedBlock,
    "kind" | "id" | "routineId" | "linkedEventId" | "calendarId" | "signalId"
  >,
): { targetKind: TimelineNoteTarget; targetId: string } | null {
  if (block.kind === "signal") {
    return {
      targetKind: "signal",
      targetId: block.signalId ?? block.id.replace(/^signal:/, ""),
    };
  }
  if (block.kind === "routine" && block.routineId) {
    return { targetKind: "routine", targetId: block.routineId };
  }
  if (block.kind === "event" && block.linkedEventId && block.calendarId) {
    return { targetKind: "event", targetId: `${block.calendarId}:${block.linkedEventId}` };
  }
  return null;
}

/** 메모 룩업 맵 키 — (target_kind, target_id) 한 쌍을 NUL로 결합(targetId가 ':'를 포함해도 안전). */
export function noteTargetMapKey(targetKind: TimelineNoteTarget, targetId: string): string {
  return `${targetKind}\u0000${targetId}`;
}

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
  /** 날짜별 배치 SSOT — signal 블록은 이 배열에서만 생성된다. */
  placements: SignalDayPlacement[];
  events: CalendarEvent[];
  routines: RoutineToday[];
  /** YYYY-MM-DD (로컬 today). 루틴 가상 인스턴스 ISO 빌드용. */
  date: string;
  /**
   * buildTimelineBlocks에서 주입되는 전역 미러 키 집합.
   * 자정 걸침 signal의 미러 이벤트는 인접 날짜 버킷에도 내려오므로,
   * placement가 없는 날짜에서도 이 키를 가진 이벤트는 독립 렌더하지 않는다.
   */
  absorbMirrorKeys?: Set<string>;
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

function findRoutineForEvent(
  e: CalendarEvent,
  routineByEvent: Map<string, RoutineToday>,
): RoutineToday | undefined {
  for (const lookupKey of eventLookupKeys(e)) {
    const routine = routineByEvent.get(lookupKey);
    if (routine) return routine;
  }
  return undefined;
}

function isoFor(
  date: string,
  hhmm: string,
  durationMin = ROUTINE_DURATION_MIN,
): { startISO: string; endISO: string } {
  const [h, m] = hhmm.split(":").map(Number);
  const startISO = `${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;
  // 끝이 자정을 넘으면 다음 날 날짜로 — 시작 `${date}` 하드코딩은 22:00+120m=익일 00:00을 같은 날
  // 00:00으로 접어 음수 duration(heightPx가 MIN_BLOCK_PX 20px 슬리버) 버그를 냈다. plusMinutesLocal이
  // 날짜 롤오버를 정확히 처리한다(signal/event 블록과 동일 경로).
  const endISO = plusMinutesLocal(startISO, durationMin);
  return { startISO, endISO };
}

/** 로컬 ISO('…THH:MM…')에서 HH:MM. 16자 미만이면 null. */
function hhmmOf(iso: string): string | null {
  return iso.length >= 16 ? iso.slice(11, 16) : null;
}

/**
 * 매칭된 Google 이벤트의 길이(분). 동기화 루틴의 per-day 길이는 routine_checks에 컬럼이 없어 로컬에
 * 저장 못 하므로, 길이만은 Google 이벤트가 정본(스펙 §5: 시각=앱, 길이=Google). end 없거나 비정상이면 null.
 */
function eventDurationMin(e: CalendarEvent): number | null {
  if (!e.end) return null;
  const ms = new Date(e.end).getTime() - new Date(e.start).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms / 60_000);
}

export function buildTodayBlocks({
  signals,
  placements,
  events,
  routines,
  date,
  absorbMirrorKeys,
}: Input): TimedBlock[] {
  const out: TimedBlock[] = [];
  const absorbed = new Set<string>(absorbMirrorKeys ?? []);
  const routineByEvent = new Map<string, RoutineToday>();

  const signalById = new Map(signals.map((s) => [s.id, s]));
  for (const p of placements) {
    if (p.date !== date) continue;
    const s = signalById.get(p.signalId);
    if (!s) continue; // 레일 밖 시그널(완료 후 미표시 등) — 블록 생략
    out.push({
      id: `signal:${s.id}:${date}`, // 날짜 포함 — 다일 배치 시 buildTimelineBlocks dedup 충돌 방지
      kind: "signal",
      signalId: s.id,
      title: s.title,
      startISO: p.startAt,
      endISO: plusMinutesLocal(p.startAt, p.durationMin),
      calendarId: s.linkedCalendarId ?? "",
      calendarLabel: s.linkedCalendarId ?? "",
      color: SIGNAL_COLOR,
      linkedEventId: s.linkedEventId ?? undefined,
      done: Boolean(s.todayDoneAt),
    });
    // Google 미러 absorb — placement가 있는 날짜에선 placement 블록이 그 시그널의 표현 SSOT.
    // 미러 이벤트가 어느 버킷에 있든(이동 전 stale 캐시 포함) 같은 날짜에서 중복 렌더하지 않는다.
    // absorbed는 호출(=날짜)마다 새로 만들어지므로 placement 없는 날짜에선 이벤트가 정상 렌더된다.
    const key = eventKey(s.linkedCalendarId, s.linkedEventId);
    if (key) absorbed.add(key);
  }
  // 각 시각 루틴을 instance 링크(linked_event_id)와 master(google_event_id) **양쪽** 키로 등록한다.
  // Google이 그 루틴을 어떤 형태로 돌려주든(인스턴스 id == linked, 또는 recurringEventId == master)
  // 한 루틴으로 귀결돼 흡수된다 — 옛 인스턴스/이동 인스턴스가 따로 떠 중복되는 일을 구조적으로 막음.
  for (const r of routines) {
    if (!(r.timeOverride ?? r.timeOfDay)) continue;
    for (const [cal, evt] of [
      [r.linkedCalendarId, r.linkedEventId],
      [r.googleCalendarId, r.googleEventId],
    ] as const) {
      const key = eventKey(cal, evt);
      if (key) routineByEvent.set(key, r);
    }
  }

  // 루틴의 미러 이벤트는 **항상 흡수**(독립 블록 금지) — 루틴은 아래에서 정확히 1블록을 그린다.
  // 시각 비교(stale 휴리스틱) 없음: 정체성으로 매칭되면 그 이벤트는 그 루틴의 표현일 뿐이다.
  // matchedEventByRoutine은 routine 블록의 길이(per-day 정본=Google)·색·딥링크 소스.
  const matchedEventByRoutine = new Map<string, CalendarEvent>();
  for (const e of events) {
    if (e.allDay) continue;
    const key = eventKey(e.calendarId, e.id);
    if (key && absorbed.has(key)) continue; // 시그널 미러
    const routine = findRoutineForEvent(e, routineByEvent);
    if (routine) {
      if (!matchedEventByRoutine.has(routine.id)) matchedEventByRoutine.set(routine.id, e);
      continue; // 흡수 — 루틴 블록이 대표한다(중복 불가)
    }
    out.push({
      id: `event:${e.calendarId}:${e.id}`,
      kind: "event",
      title: e.title,
      startISO: e.start,
      endISO: e.end ?? plusMinutesLocal(e.start, 30),
      calendarId: e.calendarId,
      calendarLabel: e.calendarSummary,
      color: e.projectColor ?? EVENT_FALLBACK_COLOR,
      linkedEventId: e.id,
    });
  }

  // 모든 due+시각 루틴을 정확히 1블록으로. 시각·제목·완료 = 앱 정본(override ?? time_of_day),
  // 길이 = 매칭 Google 이벤트가 있으면 그 길이(per-day duration은 로컬에 없음), 없으면 정의 길이.
  // 동기화 루틴도 routine 블록으로 통일(미러 이벤트는 위에서 흡수됨). 색·딥링크는 매칭 이벤트에서
  // 이어받아 캘린더 정합을 유지한다.
  for (const r of routines) {
    const time = r.timeOverride ?? r.timeOfDay;
    if (!time) continue;
    const matched = matchedEventByRoutine.get(r.id);
    // 길이는 매칭 이벤트가 루틴의 **현재 시각과 일치할 때만** 그 길이를 쓴다(=라이브 미러, 리사이즈
    // 길이 보존). 시각이 다르면(앱에서 옮겼는데 Google이 아직 옛 시각=stale) 그 길이는 무의미하므로
    // 정의 길이로. 이 시각 비교는 더 이상 표시 여부(숨김/중복)를 결정하지 않는다 — 길이 소스만 고른다.
    const matchedAtTime = matched != null && hhmmOf(matched.start) === time;
    const duration =
      (matchedAtTime ? eventDurationMin(matched) : null) ?? r.durationMin ?? ROUTINE_DURATION_MIN;
    const { startISO, endISO } = isoFor(date, time, duration);
    const linkedCalendarId = matched?.calendarId ?? r.linkedCalendarId ?? r.googleCalendarId;
    // ⚠ per-INSTANCE id만(매칭 인스턴스 또는 routine_checks 링크) — master(google_event_id)는 절대
    // 안 넣는다. 이 값이 곧 드래그/리사이즈 시 event-backed patch 타깃이라, master면 시리즈 전체가
    // 이동된다(critic B1). master밖에 없으면 undefined → 드래그는 routine path(로컬 미러)로.
    const linkedEventId = matched?.id ?? r.linkedEventId ?? undefined;
    out.push({
      // 날짜 포함 — 멀티데이 병합(buildTimelineBlocks) 시 같은 루틴의 인접 날짜 인스턴스가
      // id 충돌로 dedup되지 않도록. 소비처는 routineId 필드를 쓴다.
      id: `routine:${r.id}:${date}`,
      kind: "routine",
      title: r.title,
      startISO,
      endISO,
      calendarId: linkedCalendarId ?? "",
      calendarLabel: matched?.calendarSummary ?? linkedCalendarId ?? "",
      color: matched?.projectColor ?? ROUTINE_COLOR,
      linkedEventId,
      done: r.done,
      routineId: r.id,
    });
  }

  return out;
}

/**
 * 멀티데이 타임라인 블록 합성(연속 타임라인 스펙 §3).
 *
 * 날짜별로 buildTodayBlocks를 실행해 병합하고 블록 id로 dedup한다.
 * - 자정 걸침 Google 이벤트는 overlap 시맨틱상 인접 두 날짜 버킷에 모두 내려온다 →
 *   `event:${calendarId}:${id}` 복합키 dedup으로 full-span 1개만 남긴다.
 * - signal은 placement 날짜별 별개 블록(id에 날짜 포함).
 * - 루틴 가상 인스턴스는 id에 날짜가 포함되어 날짜별 별개 블록.
 */
export function buildTimelineBlocks({
  signals,
  placements,
  eventsByDate,
  routinesByDate,
  dates,
}: {
  signals: WorkSignal[];
  placements: SignalDayPlacement[];
  eventsByDate: Record<string, CalendarEvent[] | undefined>;
  routinesByDate: Record<string, RoutineToday[] | undefined>;
  dates: string[];
}): TimedBlock[] {
  const seen = new Set<string>();
  const out: TimedBlock[] = [];
  // 전체 placements에 연결된 signal 미러 키를 사전에 수집한다.
  // 자정 걸침 signal의 미러 이벤트는 placement가 없는 인접 날짜 버킷에도 내려오므로,
  // 해당 날짜의 buildTodayBlocks에도 이 집합을 주입해 orphan event 블록을 방지한다.
  const signalById = new Map(signals.map((s) => [s.id, s]));
  const absorbMirrorKeys = new Set<string>();
  for (const p of placements) {
    const s = signalById.get(p.signalId);
    if (!s) continue;
    const key = eventKey(s.linkedCalendarId, s.linkedEventId);
    if (key) absorbMirrorKeys.add(key);
  }
  for (const date of dates) {
    const blocks = buildTodayBlocks({
      signals,
      placements,
      events: eventsByDate[date] ?? [],
      routines: routinesByDate[date] ?? [],
      date,
      absorbMirrorKeys,
    });
    for (const b of blocks) {
      if (seen.has(b.id)) continue;
      seen.add(b.id);
      out.push(b);
    }
  }
  return out;
}
