/**
 * Today×Timeline DnD 매핑(PR 5, 스펙 §6.2~§6.5, §7).
 *
 * `@dnd-kit/core`의 onDragEnd 한 곳에서 7가지 인터랙션을 dispatch한다:
 *   1. tray → canvas         : schedule (새 배치)
 *   2. canvas block → canvas : reschedule (시간 이동)
 *   3. canvas block resize   : resize (별도 핸들 droppable — 본 PR 후속 commit)
 *   4. canvas block → tray   : unschedule (트레이 복귀)
 *   5. canvas block → 다른 캘린더 zone : moveCalendar (staged Acceptance)
 *   6. canvas 빈 슬롯 직접 그리기 : createBlank (PR 7 정련 — 본 PR은 schedule fallback 없음)
 *   7. routine row → canvas  : routineSchedule (1회성 시간 배치)
 *
 * Optimistic 패치: signals 캐시(`["signals"]` 및 `["today", today]`)에 즉시 반영.
 * Cross-cal moveCalendar는 staged라 optimistic 안 함(INVARIANT #2 — 사용자 Acceptance 게이트).
 * 실패 이벤트(`CalendarSyncFailed`)는 `useCalendarSyncEvents`가 invalidateQueries로 롤백.
 *
 * 픽셀→시간 변환은 `@/lib/timelineCoords`(연속 절대 분 축) — 자정 넘는 드래그/리사이즈 가능.
 * 루틴 블록만 occurrence 날짜 안으로 클램프(routine_checks가 date+HH:MM 구조, 스펙 §5).
 */
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { type MutableRefObject } from "react";

import type { CalendarEvent, RoutineToday, WorkSignal } from "@/bindings";
import { stage } from "@/lib/calendarSync";
import { applySchedulePatch } from "@/lib/optimisticSchedule";
import { absMin, localDateOf } from "@/lib/timeAxis";
import {
  clampDurationToDate,
  clampIsoToDate,
  pixelToLocalIso,
  plusMinutesLocal,
  resizeIsoByPx,
  shiftIsoByPx,
} from "@/lib/timelineCoords";
import { useToastStore } from "@/lib/toast";

const HOUR_PX = 60;
const SNAP_MIN = 15;
/** signal 신규 배치 기본 길이(분) — 스펙 §D8. */
const DEFAULT_SCHEDULE_MIN = 60;
/** routine 신규 배치 길이(분) — 스펙 §D8 루틴 가상 인스턴스. */
const ROUTINE_SCHEDULE_MIN = 30;

/** drag data attached to draggable nodes via `useDraggable({ data: ... })`. */
export type DragData =
  | {
      from: "tray";
      signalId: string;
      title: string;
      durationMin?: number;
    }
  | {
      from: "canvas";
      blockKind: "signal";
      /** 타임라인 블록 정본 id(`block.id`) — preview가 드래그 중 블록을 재구성 없이 매칭. */
      blockId: string;
      signalId: string;
      title: string;
      startISO: string;
      durationMin: number;
      calendarId: string;
    }
  | {
      from: "canvas";
      blockKind: "event";
      blockId: string;
      eventId: string;
      title: string;
      startISO: string;
      durationMin: number;
      calendarId: string;
    }
  | {
      from: "canvas";
      blockKind: "routine";
      blockId: string;
      routineId: string;
      title: string;
      startISO: string;
      durationMin: number;
      calendarId: string;
    }
  | {
      from: "routine";
      routineId: string;
      title: string;
    }
  | {
      /**
       * 블록 하단 리사이즈 핸들 드래그 (스펙 §7 row 3).
       * `from: "canvas-resize"` — onDragEnd에서 ev.delta.y만 사용해 durationMin을 재계산.
       * canvas droppable이 받지만 본 dispatcher가 from 분기로 reschedule이 아닌 resize stage 호출.
       */
      from: "canvas-resize";
      edge: "top" | "bottom";
      blockKind: "signal";
      blockId: string;
      signalId: string;
      startISO: string;
      durationMin: number;
    }
  | {
      from: "canvas-resize";
      edge: "top" | "bottom";
      blockKind: "event";
      blockId: string;
      eventId: string;
      calendarId: string;
      startISO: string;
      durationMin: number;
    }
  | {
      from: "canvas-resize";
      edge: "top" | "bottom";
      blockKind: "routine";
      blockId: string;
      routineId: string;
      startISO: string;
      durationMin: number;
    };

/** drop data attached to droppable nodes via `useDroppable({ data: ... })`. */
export type DropData =
  | { to: "tray" }
  | { to: "canvas"; gridY: number }
  | { to: "canvas:cal"; calendarId: string; gridY: number };

export function normalizeDropDataForDragEnd(
  active: DragData | undefined,
  over: DropData | undefined,
): DropData | undefined {
  if (over) return over;
  if (!active) return undefined;
  if (active.from === "canvas" || active.from === "canvas-resize") {
    return { to: "canvas", gridY: 0 };
  }
  return undefined;
}

export function resolveDragEndActiveData(
  activeAtStart: DragData | null | undefined,
  activeAtEnd: DragData | undefined,
): DragData | undefined {
  return activeAtStart ?? activeAtEnd;
}

type Opts = {
  /** Today 레일 캐시 키(["today", date])용 선택 날짜 — 레일/트레이 스코프(기존 유지). */
  date: string;
  /** 로드된 첫 날짜(연속 절대 분 축의 0점). */
  anchorDate: string;
  /** 로드된 일수 — 픽셀↔ISO 클램프 상한. */
  days: number;
  /** 시그널 id로 프로젝트 기본 캘린더를 찾는다. 없으면 null. */
  defaultCalendarFor: (signalId: string) => string | null;
  /** project default가 없을 때 popover를 띄우고 사용자가 고른 캘린더 id를 resolve. */
  promptCalendarPicker: (
    targetId: string,
    targetKind?: "signal" | "routine",
  ) => Promise<string | null>;
  /**
   * 캔버스 그리드 DOM. onDragEnd 시점에 fresh `getBoundingClientRect()`를 읽어
   * 스크롤/auto-scroll로 그리드가 움직인 경우에도 정확한 그리드 로컬 좌표를 만든다.
   */
  gridElRef?: MutableRefObject<HTMLDivElement | null>;
  /**
   * 마지막 포인터 viewport 좌표(raw `clientX`/`clientY`). TodayView가 `.today` onPointerMove로
   * 기록한다. 드롭 위치 = 이 raw 좌표를 드롭 시점 fresh 그리드 rect 기준으로 환산 — 이전의
   * "grid-local Y를 move 시점에 미리 계산해 ref에 박는" 방식은 auto-scroll 중 stale가 되어
   * 드롭이 화면과 어긋났다.
   */
  pointerClientRef?: MutableRefObject<{ x: number; y: number }>;
};

/**
 * onDragEnd 한 곳에서 7가지 인터랙션을 분기한다. 외부에서 `DndContext`로 감싸 사용한다
 * (또는 본 모듈의 `useTodayDndContext`가 sensors까지 묶는다).
 */
export function useTimelineDnd(opts: Opts) {
  const qc = useQueryClient();
  const {
    date,
    anchorDate,
    days,
    defaultCalendarFor,
    promptCalendarPicker,
    gridElRef,
    pointerClientRef,
  } = opts;

  /**
   * 드롭 그리드 Y(px) — 드롭 시점에 raw 포인터 viewport 좌표를 fresh 그리드 rect로 환산한다.
   * dropData.gridY(register 시점 스냅샷)도, move 시점에 미리 계산해 둔 grid-local 값도 믿지
   * 않는다(둘 다 스크롤/auto-scroll 중 어긋남). el·pointer가 없으면 fallback.
   */
  const resolveCanvasGridY = (fallback: number): number => {
    const el = gridElRef?.current;
    const p = pointerClientRef?.current;
    if (!el || !p) return fallback;
    const rect = el.getBoundingClientRect();
    const y = p.y - rect.top;
    return Math.max(0, Math.min(days * 24 * HOUR_PX, y));
  };

  /** signals 캐시 + today 레일 캐시(둘 다 WorkSignal[]) 동시 패치. */
  const patchSignalCaches = (id: string, patch: Parameters<typeof applySchedulePatch>[2]) => {
    qc.setQueryData<WorkSignal[]>(["signals"], (old) =>
      old ? applySchedulePatch(old, id, patch) : old,
    );
    qc.setQueryData<WorkSignal[]>(["today", date], (old) =>
      old ? applySchedulePatch(old, id, patch) : old,
    );
  };

  const invalidateSignalCaches = () => {
    void qc.invalidateQueries({ queryKey: ["signals"] });
    void qc.invalidateQueries({ queryKey: ["today"] });
  };

  /** 로드된 모든 날짜 버킷(+드로어 range 버킷) 순회 패치 — 자정 걸침 이벤트는 인접 두 버킷에
   *  중복 존재하고, 자정 넘는 이동은 버킷 소속이 바뀌므로 단일 date 키 패치는 화면과 어긋난다.
   *  렌더는 ISO에서 위치를 유도하므로 버킷 잔류 자체는 무해(다음 invalidate/refetch가 정리). */
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

  const invalidateEventCaches = () => {
    void qc.invalidateQueries({ queryKey: ["calendarEvents"] });
  };

  /** routines 캐시 optimistic 패치 — 드래그 직후 블록이 새 위치에 머물게 한다(invalidate-only면
   *  refetch까지 스냅백). timeOverride는 occurrence 날짜의 routine_checks 행 — 그 날짜 버킷만 패치. */
  const patchRoutineCache = (
    occDate: string,
    routineId: string,
    patch: { timeOverride?: string; durationMin?: number },
  ) => {
    qc.setQueryData<RoutineToday[]>(["routines", occDate], (old) =>
      old?.map((r) => (r.id === routineId ? { ...r, ...patch } : r)),
    );
  };

  const onDragEnd = async (ev: DragEndEvent, activeAtStart?: DragData | null) => {
    const a = resolveDragEndActiveData(
      activeAtStart,
      ev.active.data.current as DragData | undefined,
    );
    const o = normalizeDropDataForDragEnd(a, ev.over?.data.current as DropData | undefined);
    if (!a || !o) return;

    // ── 1: tray → canvas ─────────────────────────────────────────────
    if (a.from === "tray" && o.to === "canvas") {
      const cal =
        defaultCalendarFor(a.signalId) ?? (await promptCalendarPicker(a.signalId, "signal"));
      if (!cal) return;
      const at = pixelToLocalIso(anchorDate, days, resolveCanvasGridY(o.gridY));
      const durationMin = a.durationMin ?? DEFAULT_SCHEDULE_MIN;
      patchSignalCaches(a.signalId, { at, durationMin, calendarId: cal });
      try {
        await stage({
          kind: "schedule",
          targetSignalId: a.signalId,
          at,
          durationMin,
          calendarId: cal,
          title: a.title,
        });
      } catch {
        invalidateSignalCaches();
      }
      return;
    }

    // ── 3: canvas-resize → canvas (block 상/하단 핸들 드래그) ───────
    // ev.delta.y만 사용해 새 시간 계산. 아래 핸들은 end 이동, 위 핸들은 start 이동.
    // 최소 15분(1 snap) 보장, 00:00–24:00 안에 clamp.
    if (a.from === "canvas-resize" && o.to === "canvas") {
      const resized = resizeIsoByPx({
        anchorDate,
        days,
        startISO: a.startISO,
        durationMin: a.durationMin,
        edge: a.edge,
        deltaPx: ev.delta.y,
      });
      // 루틴은 occurrence 날짜 안으로 클램프 — routine_checks(date+HH:MM)가 다음 날 새벽을
      // 표현하지 못한다(스펙 §5). top 핸들이 날짜를 넘으면 그 날 00:00에서 멈춘다.
      const occDate = localDateOf(a.startISO);
      const at = a.blockKind === "routine" ? clampIsoToDate(resized.at, occDate) : resized.at;
      // 클램프로 시작이 밀렸으면 끝 시각 고정을 위해 duration을 보정(absMin 차이만큼).
      // 루틴은 끝도 자정을 넘지 못한다(bottom-resize 상한 — Google master end 누수 방지).
      let clamped =
        at === resized.at
          ? resized.durationMin
          : resized.durationMin + (absMin(resized.at, occDate) - absMin(at, occDate));
      if (a.blockKind === "routine") clamped = clampDurationToDate(at, occDate, clamped);
      if (clamped === a.durationMin && at === a.startISO) return;
      if (a.blockKind === "event") {
        patchEventCache(a.calendarId, a.eventId, {
          start: at,
          durationMin: clamped,
        });
      } else if (a.blockKind === "signal") {
        patchSignalCaches(a.signalId, {
          at,
          durationMin: clamped,
        });
      } else if (a.blockKind === "routine") {
        // durationMin은 패치하지 않는다 — routine_checks엔 per-day duration 컬럼이 없어
        // 서버가 영속하지 않는 값(정의의 duration_min으로 refetch 시 복귀)을 캐시에 약속하면
        // 리사이즈 높이가 곧 스냅백한다. 시간 위치(time_override)만 optimistic.
        patchRoutineCache(occDate, a.routineId, { timeOverride: at.slice(11, 16) });
      }
      try {
        if (a.blockKind === "event") {
          await stage({
            kind: "eventResize",
            eventId: a.eventId,
            calendarId: a.calendarId,
            at,
            durationMin: clamped,
          });
        } else if (a.blockKind === "routine") {
          await stage({
            kind: "routineResize",
            routineId: a.routineId,
            date: occDate,
            at,
            durationMin: clamped,
          });
          void qc.invalidateQueries({ queryKey: ["routines"] });
        } else {
          await stage({
            kind: "resize",
            targetSignalId: a.signalId,
            at,
            durationMin: clamped,
          });
        }
      } catch {
        if (a.blockKind === "event") invalidateEventCaches();
        else if (a.blockKind === "routine") void qc.invalidateQueries({ queryKey: ["routines"] });
        else invalidateSignalCaches();
      }
      return;
    }

    // ── 2: canvas → canvas (reschedule, 같은 캘린더 시간 이동) ───────
    if (a.from === "canvas" && o.to === "canvas") {
      const shifted = shiftIsoByPx(anchorDate, days, a.startISO, ev.delta.y);
      // 루틴은 occurrence 날짜 안으로 클램프(스펙 §5) — event/signal은 자정 통과 자유.
      const occDate = localDateOf(a.startISO);
      const at = a.blockKind === "routine" ? clampIsoToDate(shifted, occDate) : shifted;
      if (a.blockKind === "event") {
        patchEventCache(a.calendarId, a.eventId, { start: at, durationMin: a.durationMin });
      } else if (a.blockKind === "signal") {
        patchSignalCaches(a.signalId, { at });
      } else if (a.blockKind === "routine") {
        patchRoutineCache(occDate, a.routineId, { timeOverride: at.slice(11, 16) });
      }
      try {
        if (a.blockKind === "event") {
          await stage({
            kind: "eventReschedule",
            eventId: a.eventId,
            calendarId: a.calendarId,
            at,
            durationMin: a.durationMin,
          });
        } else if (a.blockKind === "routine") {
          await stage({
            kind: "routineReschedule",
            routineId: a.routineId,
            date: occDate,
            at,
            // 위치 클램프 후에도 끝이 자정을 넘을 수 있다(23:45 + 60분) — 동일 상한 적용.
            durationMin: clampDurationToDate(at, occDate, a.durationMin),
          });
          void qc.invalidateQueries({ queryKey: ["routines"] });
        } else {
          await stage({
            kind: "reschedule",
            targetSignalId: a.signalId,
            at,
            durationMin: a.durationMin,
          });
        }
      } catch {
        if (a.blockKind === "event") invalidateEventCaches();
        else if (a.blockKind === "routine") void qc.invalidateQueries({ queryKey: ["routines"] });
        else invalidateSignalCaches();
      }
      return;
    }

    // ── 4: canvas → tray (unschedule) ─────────────────────────────────
    if (a.from === "canvas" && a.blockKind === "signal" && o.to === "tray") {
      // 사전 상태 캡처 — undo 시 정확한 prior state 복원용.
      const prevAt = a.startISO;
      const prevDur = a.durationMin;
      const signalId = a.signalId;
      patchSignalCaches(signalId, { clearLink: true });
      try {
        await stage({ kind: "unschedule", targetSignalId: signalId });
        // 1.5s 토스트 + undo 액션(다시 reschedule). pushInfo 자동 dismiss(2500ms)에 의존,
        // onUndo는 사용자가 명시적으로 눌렀을 때만 실행.
        useToastStore.getState().pushInfo("일정 해제됨", {
          onUndo: () => {
            void stage({
              kind: "reschedule",
              targetSignalId: signalId,
              at: prevAt,
              durationMin: prevDur,
            });
          },
          undoLabel: "되돌리기",
        });
      } catch {
        invalidateSignalCaches();
      }
      return;
    }

    // ── 5: canvas → 다른 캘린더 zone (moveCalendar, staged) ──────────
    if (a.from === "canvas" && a.blockKind === "signal" && o.to === "canvas:cal") {
      if (o.calendarId === a.calendarId) return; // 동일 캘린더면 noop.
      const at = shiftIsoByPx(anchorDate, days, a.startISO, ev.delta.y);
      try {
        await stage({
          kind: "moveCalendar",
          targetSignalId: a.signalId,
          calendarId: o.calendarId,
          at,
          durationMin: a.durationMin,
          title: a.title,
        });
      } catch {
        // stage IPC 자체가 실패하면 큐 행이 안 생겨 usePendingWrites에도 안 뜬다 —
        // 무음이면 사용자는 이동이 접수된 줄 안다. 토스트로 노출.
        useToastStore
          .getState()
          .pushError("calendar.stage", "캘린더 이동 스테이징 실패 — 다시 시도하세요");
      }
      void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
      return;
    }

    // ── 7: routine → canvas (routineSchedule, 1회성 시간 배치) ────────
    if (a.from === "routine" && o.to === "canvas") {
      // routine은 routineId 기반 calendar 매핑이 없으므로 picker만(default lookup 없음).
      const cal = await promptCalendarPicker(a.routineId, "routine");
      if (!cal) return;
      const at = pixelToLocalIso(anchorDate, days, resolveCanvasGridY(o.gridY));
      try {
        await stage({
          kind: "routineSchedule",
          routineId: a.routineId,
          // 드롭 위치의 날짜가 곧 occurrence — 인접 날짜 영역에 떨어뜨리면 그 날 배치.
          date: localDateOf(at),
          at,
          durationMin: ROUTINE_SCHEDULE_MIN,
          calendarId: cal,
          title: a.title,
        });
      } catch (e) {
        // success/failure 모두 한 번만 invalidate. catch 없는 try/finally는
        // React Compiler BuildHIR 미지원이라 finally 대신 양 경로에 명시.
        void qc.invalidateQueries({ queryKey: ["routines"] });
        throw e;
      }
      void qc.invalidateQueries({ queryKey: ["routines"] });
      return;
    }

    // 인터랙션 #3 resize / #6 createBlank: 후속 commit (PR 7 정련).
  };

  return { onDragEnd };
}

/** sensors까지 묶어 한 번에 쓸 수 있는 컨테이너 컴포넌트 helper. */
export function useTodayDndSensors() {
  const sensors = useSensors(
    // distance 3px로 낮춤 — 6px은 일부 환경에서 활성화가 느렸다.
    // delay-based 활성화도 고려 가능(touch 친화)이지만 desktop은 distance가 적합.
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(KeyboardSensor),
  );
  return sensors;
}

/** DndContext re-export — caller import 단순화. */
export { DndContext };

/** signals → projectId 기반 defaultCalendarFor 빌더(스펙 §6.5). 프로젝트 `default_write_calendar_id` 사용. */
export function buildDefaultCalendarFor(
  signals: WorkSignal[],
  projects: { id: string; defaultWriteCalendarId: string | null }[],
): (signalId: string) => string | null {
  const sigToProj = new Map<string, string | null>(signals.map((s) => [s.id, s.projectId]));
  const projDefault = new Map<string, string | null>(
    projects.map((p) => [p.id, p.defaultWriteCalendarId]),
  );
  return (signalId: string) => {
    const projectId = sigToProj.get(signalId);
    if (!projectId) return null;
    return projDefault.get(projectId) ?? null;
  };
}
