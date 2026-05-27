/**
 * Today×Timeline Optimistic 패치 헬퍼(PR 5, 스펙 §6.4).
 *
 * DnD 한 번에 React Query 캐시(WorkSignal[])를 즉시 갱신해 UI를 응답성 있게 보이게 하고,
 * sync 실패 이벤트(CalendarSyncFailed) 수신 시 invalidateQueries로 SSOT(SQLite)에서 재로드한다.
 * (Cross-cal moveCalendar는 staged라 optimistic 패치하지 않는다 — INVARIANT #2.)
 *
 * 순수 함수 — 입력 배열은 mutation하지 않고 새 배열을 반환한다.
 */
import type { WorkSignal } from "@/bindings";

export type SchedulePatch = {
  /** 새 scheduledAt (YYYY-MM-DDTHH:MM:SS, 로컬 ISO). undefined면 미변경. */
  at?: string;
  /** 새 scheduledDuration (분). undefined면 미변경. */
  durationMin?: number;
  /** 새 linkedCalendarId. undefined면 미변경. */
  calendarId?: string;
  /**
   * true면 scheduledAt/duration/linked* 전부 NULL로 — unschedule 트레이 복귀 케이스.
   * 다른 필드와 동시 지정 시 clearLink가 우선한다.
   */
  clearLink?: boolean;
};

/** 한 signal의 시간축 배치 필드를 즉시 패치. */
export function applySchedulePatch(
  signals: WorkSignal[],
  id: string,
  patch: SchedulePatch,
): WorkSignal[] {
  return signals.map((s) => {
    if (s.id !== id) return s;
    if (patch.clearLink) {
      return {
        ...s,
        scheduledAt: null,
        scheduledDuration: null,
        linkedEventId: null,
        linkedCalendarId: null,
      };
    }
    return {
      ...s,
      scheduledAt: patch.at !== undefined ? patch.at : s.scheduledAt,
      scheduledDuration:
        patch.durationMin !== undefined ? patch.durationMin : s.scheduledDuration,
      linkedCalendarId:
        patch.calendarId !== undefined ? patch.calendarId : s.linkedCalendarId,
    };
  });
}

/** sync 실패 시 호출 — 원본 스냅샷의 해당 행으로 되돌린다. */
export function rollbackSchedulePatch(
  current: WorkSignal[],
  id: string,
  original: WorkSignal[],
): WorkSignal[] {
  const orig = original.find((s) => s.id === id);
  if (!orig) return current;
  return current.map((s) => (s.id === id ? orig : s));
}
