/**
 * 타임라인이 읽는 캐시들의 invalidation 콤보 정본 — `useTimelineDnd`/`useTimelineScheduleActions`가
 * 같은 키 목록을 각자 하드롤하지 않도록 한 곳에 둔다(staged write 후 reconcile/rollback용).
 */
import type { QueryClient } from "@tanstack/react-query";

/** 시그널 축 전체(보드/레일/배치/누적시간). */
export function invalidateSignalCaches(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ["signals"] });
  void qc.invalidateQueries({ queryKey: ["today"] });
  void qc.invalidateQueries({ queryKey: ["signalPlacements"] });
  void qc.invalidateQueries({ queryKey: ["signalTimeTotals"] });
}

/** 이벤트 축(캘린더 버킷 — per-date + range). */
export function invalidateEventCaches(qc: QueryClient): void {
  void qc.invalidateQueries({ queryKey: ["calendarEvents"] });
}

/** 타임라인이 읽는 전부(catch/rollback 경로) — 시그널 + 이벤트 + 루틴. */
export function invalidateTimelineAll(qc: QueryClient): void {
  invalidateSignalCaches(qc);
  invalidateEventCaches(qc);
  void qc.invalidateQueries({ queryKey: ["routines"] });
}
