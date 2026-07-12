import type { QueryClient } from "@tanstack/react-query";

import type { CalendarEvent } from "@/bindings";

/** 미러 이벤트 1건을 버킷에서 제거(언스케줄 등). 같은 id·다른 캘린더는 보존. 순수. */
export function removeEventFromBuckets(
  events: CalendarEvent[],
  calendarId: string,
  eventId: string,
): CalendarEvent[] {
  return events.filter((e) => !(e.calendarId === calendarId && e.id === eventId));
}

/**
 * 미러 이벤트 1건을 로드된 모든 calendarEvents 버킷(per-date + range)에서 즉시 제거 — qc 바인딩 정본.
 * 자정 걸침 이벤트는 인접 날짜 버킷에 중복 존재하므로 prefix 키로 전 버킷을 순회한다.
 */
export function removeEventFromCache(qc: QueryClient, calendarId: string, eventId: string): void {
  qc.setQueriesData<CalendarEvent[]>({ queryKey: ["calendarEvents"] }, (old) =>
    old ? removeEventFromBuckets(old, calendarId, eventId) : old,
  );
}
