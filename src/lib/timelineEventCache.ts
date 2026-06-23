import type { CalendarEvent } from "@/bindings";

/** 미러 이벤트 1건을 버킷에서 제거(언스케줄 등). 같은 id·다른 캘린더는 보존. 순수. */
export function removeEventFromBuckets(
  events: CalendarEvent[],
  calendarId: string,
  eventId: string,
): CalendarEvent[] {
  return events.filter((e) => !(e.calendarId === calendarId && e.id === eventId));
}
