/**
 * `applyTimelineCommitToCaches` — Today 타임라인 드래그의 commit-구동 캐시 정합기(reconciler).
 *
 * `useTimelineDnd.ts` onDragEnd의 각 분기에 흩어져 있던 layer-①(signal/placement)+②(event/routine)
 * optimistic 캐시 패치를, `TimelineCommit.kind`별 단일 `switch`로 **동일 행동 그대로** 모은다.
 * 본 모듈은 와이어링되지 않은 채 추가만 된다(Task 2) — onDragEnd 재배선은 Task 3.
 *
 * 순수성 경계: 이 파일은 `src/lib`이므로 **@dnd-kit import 금지**. 시간 수학도 하지 않는다 —
 * `commit.at`/`durationMin`/ids/dates는 planner(`planTimelineDrag`)가 이미 계산한 값이라 그대로 소비한다
 * (INVARIANT #7: 위치 계산용 `toISOString()`/`new Date().getHours()` 없음). 유일한 시각 파생은
 * 루틴 `time_override` 포맷용 ISO→'HH:MM' 문자열 슬라이스(useTimelineDnd `hhmmOfIso`와 동치)뿐이다.
 *
 * 이벤트 캐시 쓰기는 반드시 prefix 키 `["calendarEvents"]`로 — per-date `["calendarEvents", date]`와
 * range `["calendarEvents","range",s,e]` 버킷을 모두 덮어야 자정 걸침/넘김 이벤트가 화면과 어긋나지 않는다.
 */
import type { QueryClient } from "@tanstack/react-query";

import type { CalendarEvent, RoutineToday, SignalDayPlacement, WorkSignal } from "@/bindings";

import { applyPlacementPatch, applySchedulePatch, type PlacementPatch } from "./optimisticSchedule";
import { localDateOf } from "./timeAxis";
import { SNAP_MIN } from "./timelineAxis";
import { plusMinutesLocal } from "./timelineCoords";
import type { TimelineCommit } from "./timelineDragPlan";
import { removeEventFromBuckets } from "./timelineEventCache";

/** 로컬 ISO('YYYY-MM-DDTHH:MM...')에서 'HH:MM' — routine_checks.time_override 포맷(useTimelineDnd 동치). */
const hhmmOfIso = (iso: string): string => iso.slice(11, 16);

/**
 * commit 한 건을 React Query 캐시에 즉시 반영한다(layer-①+②). `qc`는 caller(onDragEnd)의 QueryClient.
 *
 * 각 kind는 현재 useTimelineDnd 분기가 건드리는 캐시를 **정확히 그대로** 건드린다(parity):
 *  - schedule: signal(at/duration/calendarId) + placement upsert
 *  - reschedule(signal): signal(at만, duration 미패치) + placement move
 *  - resize(signal): signal(at/duration) + placement move
 *  - unschedule: signal clearLink + placement remove + (미러 이벤트 있으면) 전 버킷 제거
 *  - eventResize/eventReschedule: 이벤트 start/end 패치 + (routine-backed면) routine time_override
 *  - routineReschedule: routine time_override(occurrence 날짜 버킷)
 *  - routineResize: routine time_override만(per-day duration 컬럼 없음 → duration 미패치)
 *  - routineSchedule / moveCalendar: optimistic 패치 없음(전자는 invalidate-only, 후자는 staged=INVARIANT #2)
 */
export function applyTimelineCommitToCaches(qc: QueryClient, commit: TimelineCommit): void {
  /** signals 캐시 + today 레일 캐시(둘 다 WorkSignal[]) 동시 패치. */
  const patchSignalCaches = (id: string, patch: Parameters<typeof applySchedulePatch>[2]) => {
    qc.setQueriesData<WorkSignal[]>({ queryKey: ["signals"] }, (old) =>
      old ? applySchedulePatch(old, id, patch) : old,
    );
    qc.setQueriesData<WorkSignal[]>({ queryKey: ["today"] }, (old) =>
      old ? applySchedulePatch(old, id, patch) : old,
    );
  };

  /** ["signalPlacements"] 캐시 optimistic 패치 — 렌더는 placement가 SSOT라 이걸 패치해야 스냅백이 없다. */
  const patchPlacementCaches = (signalId: string, patch: PlacementPatch) => {
    qc.setQueriesData<SignalDayPlacement[]>({ queryKey: ["signalPlacements"] }, (old) =>
      old ? applyPlacementPatch(old, signalId, patch) : old,
    );
  };

  /** 로드된 모든 calendarEvents 버킷(per-date + range) 순회 패치 — 단일 date 키는 자정 걸침과 어긋난다. */
  const patchEventCache = (
    calendarId: string,
    eventId: string,
    patch: { start?: string; durationMin?: number },
  ) => {
    qc.setQueriesData<CalendarEvent[]>({ queryKey: ["calendarEvents"] }, (old) => {
      if (!old) return old;
      return old.map((event) => {
        if (event.calendarId !== calendarId || event.id !== eventId) return event;
        const start = patch.start ?? event.start;
        const durationMin =
          patch.durationMin ??
          Math.max(
            SNAP_MIN,
            Math.round((new Date(event.end).getTime() - new Date(event.start).getTime()) / 60000),
          );
        return {
          ...event,
          start,
          end: plusMinutesLocal(start, durationMin),
        };
      });
    });
  };

  /** 미러 이벤트 1건을 로드된 모든 calendarEvents 버킷에서 즉시 제거 — 언스케줄 시 고아 블록 방지. */
  const removeEventFromCache = (calendarId: string, eventId: string) =>
    qc.setQueriesData<CalendarEvent[]>({ queryKey: ["calendarEvents"] }, (old) =>
      old ? removeEventFromBuckets(old, calendarId, eventId) : old,
    );

  /** routines 캐시 optimistic 패치 — time_override는 occurrence 날짜의 행이라 그 날짜 버킷만 패치. */
  const patchRoutineCache = (
    occDate: string,
    routineId: string,
    patch: { timeOverride?: string; durationMin?: number },
  ) => {
    qc.setQueryData<RoutineToday[]>(["routines", occDate], (old) =>
      old?.map((r) => (r.id === routineId ? { ...r, ...patch } : r)),
    );
  };

  switch (commit.kind) {
    // ── 1: tray → canvas (schedule) ──────────────────────────────────
    case "schedule": {
      const { targetSignalId, at, durationMin, calendarId } = commit;
      patchSignalCaches(targetSignalId, { at, durationMin, calendarId });
      patchPlacementCaches(targetSignalId, {
        type: "upsert",
        date: localDateOf(at),
        startAt: at,
        durationMin,
      });
      return;
    }

    // ── 2: canvas → canvas (reschedule, signal) ──────────────────────
    // signal reschedule은 scheduledAt만 패치(duration은 미패치) — useTimelineDnd 분기 동치.
    case "reschedule": {
      const { targetSignalId, at, durationMin, fromDate } = commit;
      patchSignalCaches(targetSignalId, { at });
      patchPlacementCaches(targetSignalId, {
        type: "move",
        fromDate,
        date: localDateOf(at),
        startAt: at,
        durationMin,
      });
      return;
    }

    // ── 3: canvas-resize → canvas (resize, signal) ───────────────────
    case "resize": {
      const { targetSignalId, at, durationMin, fromDate } = commit;
      patchSignalCaches(targetSignalId, { at, durationMin });
      patchPlacementCaches(targetSignalId, {
        type: "move",
        fromDate,
        date: localDateOf(at),
        startAt: at,
        durationMin,
      });
      return;
    }

    // ── 4: canvas → tray (unschedule) ────────────────────────────────
    case "unschedule": {
      const { targetSignalId, fromDate, calendarId, linkedEventId } = commit;
      // signal이 Google 이벤트 미러와 연결된 경우 링크 해제 전에 캐시에서 즉시 제거 — 고아 블록 방지.
      if (calendarId && linkedEventId) removeEventFromCache(calendarId, linkedEventId);
      patchSignalCaches(targetSignalId, { clearLink: true });
      patchPlacementCaches(targetSignalId, { type: "remove", date: fromDate });
      return;
    }

    // ── 5: canvas → 다른 캘린더 zone (moveCalendar, staged) ──────────
    // cross-cal은 staged(INVARIANT #2) — optimistic 캐시 패치 없음(Acceptance 게이트 후 refetch).
    case "moveCalendar":
      return;

    // ── canvas-resize event (eventResize) ────────────────────────────
    case "eventResize": {
      const { eventId, calendarId, at, durationMin, routineId, routineDate } = commit;
      patchEventCache(calendarId, eventId, { start: at, durationMin });
      // 루틴-backed면 루틴 캐시의 timeOverride도 같이 패치 — interim에도 블록이 새 위치에 머문다.
      if (routineId && routineDate) {
        patchRoutineCache(routineDate, routineId, { timeOverride: hhmmOfIso(at) });
      }
      return;
    }

    // ── canvas event (eventReschedule) ───────────────────────────────
    case "eventReschedule": {
      const { eventId, calendarId, at, durationMin, routineId, routineDate } = commit;
      patchEventCache(calendarId, eventId, { start: at, durationMin });
      if (routineId && routineDate) {
        patchRoutineCache(routineDate, routineId, { timeOverride: hhmmOfIso(at) });
      }
      return;
    }

    // ── canvas routine (routineReschedule) ───────────────────────────
    case "routineReschedule": {
      const { routineId, date, at } = commit;
      patchRoutineCache(date, routineId, { timeOverride: hhmmOfIso(at) });
      return;
    }

    // ── canvas-resize routine (routineResize) ────────────────────────
    // durationMin은 패치하지 않는다 — routine_checks엔 per-day duration 컬럼이 없어 곧 스냅백한다.
    case "routineResize": {
      const { routineId, date, at } = commit;
      patchRoutineCache(date, routineId, { timeOverride: hhmmOfIso(at) });
      return;
    }

    // ── 7: routine → canvas (routineSchedule) ────────────────────────
    // 신규 루틴 occurrence는 optimistic 캐시 패치 없음(useTimelineDnd: stage 후 invalidate-only).
    case "routineSchedule":
      return;
  }
}
