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
 * 픽셀→시간: 60px/h, 15분 스냅. 로컬 ISO("YYYY-MM-DDTHH:MM:SS")로 빌드 — UTC 미사용
 * (PR 4 todayBlocks.ts plusMin 패턴과 동일, 동일 timezone-drift 버그 방지).
 */
import { useCallback, type MutableRefObject } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";

import type { CalendarEvent, WorkSignal } from "@/bindings";
import { stage } from "@/lib/calendarSync";
import { applySchedulePatch } from "@/lib/optimisticSchedule";
import { useToastStore } from "@/lib/toast";

const HOUR_PX = 60;
const SNAP_MIN = 15;
/** signal 신규 배치 기본 길이(분) — 스펙 §D8. */
const DEFAULT_SCHEDULE_MIN = 60;
/** routine 신규 배치 길이(분) — 스펙 §D8 루틴 가상 인스턴스. */
const ROUTINE_SCHEDULE_MIN = 30;

function snap(min: number): number {
  return Math.round(min / SNAP_MIN) * SNAP_MIN;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 로컬 timezone offset 문자열 (`+09:00` 형태). RFC3339 datetime 표기에 필수
 * (백엔드 `chrono::DateTime::parse_from_rfc3339`는 offset이 없으면 reject).
 */
function tzOffset(): string {
  const min = -new Date().getTimezoneOffset();
  const sign = min >= 0 ? "+" : "-";
  const abs = Math.abs(min);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * date(YYYY-MM-DD) + 그리드 픽셀 오프셋 → RFC3339 with local offset
 * (`YYYY-MM-DDTHH:MM:SS+09:00`). 음수는 0(00:00)으로 clamp, 24h 초과는
 * 23:45로 clamp(스냅 정렬 유지). 백엔드 sync 워커가 `parse_from_rfc3339`로 받음.
 */
export function pixelToLocalIso(date: string, gridY: number): string {
  const rawMin = (gridY / HOUR_PX) * 60;
  const snapped = snap(rawMin);
  const clamped = Math.max(0, Math.min(24 * 60 - SNAP_MIN, snapped));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${date}T${pad(h)}:${pad(m)}:00${tzOffset()}`;
}

/** 기존 ISO(또는 null) + delta px → 새 RFC3339(with offset). timezone-drift 안전. */
export function shiftIsoByPx(
  date: string,
  startISO: string,
  deltaPx: number,
): string {
  const d = new Date(startISO);
  const startMin = d.getHours() * 60 + d.getMinutes();
  const deltaMin = (deltaPx / HOUR_PX) * 60;
  const snapped = snap(startMin + deltaMin);
  const clamped = Math.max(0, Math.min(24 * 60 - SNAP_MIN, snapped));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${date}T${pad(h)}:${pad(m)}:00${tzOffset()}`;
}

export function plusMinutesLocal(iso: string, minutes: number): string {
  const d = new Date(new Date(iso).getTime() + minutes * 60_000);
  const offsetMatch = iso.match(/([+-]\d{2}:\d{2})$/);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${offsetMatch?.[1] ?? ""}`;
}

export function resizeIsoByPx({
  date,
  startISO,
  durationMin,
  edge,
  deltaPx,
}: {
  date: string;
  startISO: string;
  durationMin: number;
  edge: "top" | "bottom";
  deltaPx: number;
}): { at: string; durationMin: number } {
  const startDate = new Date(startISO);
  const startMin = startDate.getHours() * 60 + startDate.getMinutes();
  const endMin = startMin + durationMin;
  const deltaMin = (deltaPx / HOUR_PX) * 60;
  if (edge === "top") {
    const nextStartMin = Math.max(
      0,
      Math.min(endMin - SNAP_MIN, snap(startMin + deltaMin)),
    );
    return {
      at: pixelToLocalIso(date, nextStartMin),
      durationMin: endMin - nextStartMin,
    };
  }
  return {
    at: startISO,
    durationMin: Math.max(
      SNAP_MIN,
      Math.min(24 * 60 - startMin, snap(durationMin + deltaMin)),
    ),
  };
}

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
      signalId: string;
      title: string;
      startISO: string;
      durationMin: number;
      calendarId: string;
    }
  | {
      from: "canvas";
      blockKind: "event";
      eventId: string;
      title: string;
      startISO: string;
      durationMin: number;
      calendarId: string;
    }
  | {
      from: "canvas";
      blockKind: "routine";
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
      signalId: string;
      startISO: string;
      durationMin: number;
    }
  | {
      from: "canvas-resize";
      edge: "top" | "bottom";
      blockKind: "event";
      eventId: string;
      calendarId: string;
      startISO: string;
      durationMin: number;
    }
  | {
      from: "canvas-resize";
      edge: "top" | "bottom";
      blockKind: "routine";
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
  date: string;
  /** 시그널 id로 프로젝트 기본 캘린더를 찾는다. 없으면 null. */
  defaultCalendarFor: (signalId: string) => string | null;
  /** project default가 없을 때 popover를 띄우고 사용자가 고른 캘린더 id를 resolve. */
  promptCalendarPicker: (signalId: string) => Promise<string | null>;
  /**
   * 캔버스 그리드 로컬 Y (px). TimelineCanvas가 pointermove로 기록 → onDragEnd에서 읽는다.
   * dropData에 mutable 객체를 박는 antipattern 회피용 (PR 5 코드리뷰).
   */
  canvasPointerYRef?: MutableRefObject<number | null>;
};

/**
 * onDragEnd 한 곳에서 7가지 인터랙션을 분기한다. 외부에서 `DndContext`로 감싸 사용한다
 * (또는 본 모듈의 `useTodayDndContext`가 sensors까지 묶는다).
 */
export function useTimelineDnd(opts: Opts) {
  const qc = useQueryClient();
  const { date, defaultCalendarFor, promptCalendarPicker, canvasPointerYRef } = opts;

  /** dropData.gridY는 register 시점 스냅샷일 수 있어 신뢰 못함 — 부모 pointer ref 우선. */
  const resolveCanvasGridY = useCallback(
    (fallback: number): number => canvasPointerYRef?.current ?? fallback,
    [canvasPointerYRef],
  );

  /** signals 캐시 + today 레일 캐시(둘 다 WorkSignal[]) 동시 패치. */
  const patchSignalCaches = useCallback(
    (id: string, patch: Parameters<typeof applySchedulePatch>[2]) => {
      qc.setQueryData<WorkSignal[]>(["signals"], (old) =>
        old ? applySchedulePatch(old, id, patch) : old,
      );
      qc.setQueryData<WorkSignal[]>(["today", date], (old) =>
        old ? applySchedulePatch(old, id, patch) : old,
      );
    },
    [qc, date],
  );

  const invalidateSignalCaches = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["signals"] });
    void qc.invalidateQueries({ queryKey: ["today"] });
  }, [qc]);

  const patchEventCache = useCallback(
    (eventId: string, patch: { start?: string; durationMin?: number }) => {
      qc.setQueryData<CalendarEvent[]>(["calendarEvents", date], (old) => {
        if (!old) return old;
        return old.map((event) => {
          if (event.id !== eventId) return event;
          const start = patch.start ?? event.start;
          const durationMin =
            patch.durationMin ??
            Math.max(
              SNAP_MIN,
              Math.round(
                (new Date(event.end).getTime() - new Date(event.start).getTime()) /
                  60000,
              ),
            );
          return {
            ...event,
            start,
            end: plusMinutesLocal(start, durationMin),
          };
        });
      });
    },
    [qc, date],
  );

  const invalidateEventCaches = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ["calendarEvents", date] });
  }, [qc, date]);

  const onDragEnd = useCallback(
    async (ev: DragEndEvent, activeAtStart?: DragData | null) => {
      const a = resolveDragEndActiveData(
        activeAtStart,
        ev.active.data.current as DragData | undefined,
      );
      const o = normalizeDropDataForDragEnd(
        a,
        ev.over?.data.current as DropData | undefined,
      );
      if (!a || !o) return;

      // ── 1: tray → canvas ─────────────────────────────────────────────
      if (a.from === "tray" && o.to === "canvas") {
        const cal =
          defaultCalendarFor(a.signalId) ??
          (await promptCalendarPicker(a.signalId));
        if (!cal) return;
        const at = pixelToLocalIso(date, resolveCanvasGridY(o.gridY));
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
          date,
          startISO: a.startISO,
          durationMin: a.durationMin,
          edge: a.edge,
          deltaPx: ev.delta.y,
        });
        const { at } = resized;
        const clamped = resized.durationMin;
        if (clamped === a.durationMin && at === a.startISO) return;
        if (a.blockKind === "event") {
          patchEventCache(a.eventId, {
            start: at,
            durationMin: clamped,
          });
        } else if (a.blockKind === "signal") {
          patchSignalCaches(a.signalId, {
            at,
            durationMin: clamped,
          });
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
              date,
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
          else if (a.blockKind === "routine")
            void qc.invalidateQueries({ queryKey: ["routines"] });
          else invalidateSignalCaches();
        }
        return;
      }

      // ── 2: canvas → canvas (reschedule, 같은 캘린더 시간 이동) ───────
      if (a.from === "canvas" && o.to === "canvas") {
        const at = shiftIsoByPx(date, a.startISO, ev.delta.y);
        if (a.blockKind === "event") {
          patchEventCache(a.eventId, { start: at, durationMin: a.durationMin });
        } else if (a.blockKind === "signal") {
          patchSignalCaches(a.signalId, { at });
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
              date,
              at,
              durationMin: a.durationMin,
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
          else if (a.blockKind === "routine")
            void qc.invalidateQueries({ queryKey: ["routines"] });
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
        const at = shiftIsoByPx(date, a.startISO, ev.delta.y);
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
          // staged는 큐 표시(usePendingWrites)가 끌어가 — 별도 invalidate만.
        }
        void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
        return;
      }

      // ── 7: routine → canvas (routineSchedule, 1회성 시간 배치) ────────
      if (a.from === "routine" && o.to === "canvas") {
        // routine은 routineId 기반 calendar 매핑이 없으므로 picker만(default lookup 없음).
        const cal = await promptCalendarPicker(a.routineId);
        if (!cal) return;
        const at = pixelToLocalIso(date, resolveCanvasGridY(o.gridY));
        try {
          await stage({
            kind: "routineSchedule",
            routineId: a.routineId,
            date,
            at,
            durationMin: ROUTINE_SCHEDULE_MIN,
            calendarId: cal,
            title: a.title,
          });
        } finally {
          // success/failure 모두 한 번만 invalidate (이전엔 catch + 무조건 중복 호출).
          void qc.invalidateQueries({ queryKey: ["routines"] });
        }
        return;
      }

      // 인터랙션 #3 resize / #6 createBlank: 후속 commit (PR 7 정련).
    },
    [
      date,
      defaultCalendarFor,
      promptCalendarPicker,
      resolveCanvasGridY,
      patchSignalCaches,
      invalidateSignalCaches,
      invalidateEventCaches,
      patchEventCache,
      qc,
    ],
  );

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

/** signals → projectId 기반 defaultCalendarFor 빌더(스펙 §6.5). */
export function buildDefaultCalendarFor(
  signals: WorkSignal[],
  projects: { id: string; defaultWriteCalendarId: string | null }[],
): (signalId: string) => string | null {
  const sigToProj = new Map<string, string | null>(
    signals.map((s) => [s.id, s.projectId]),
  );
  const projDefault = new Map<string, string | null>(
    projects.map((p) => [p.id, p.defaultWriteCalendarId]),
  );
  return (signalId: string) => {
    const projectId = sigToProj.get(signalId);
    if (!projectId) return null;
    return projDefault.get(projectId) ?? null;
  };
}

/** 외부 사용을 위한 상수 노출. */
export const TIMELINE_HOUR_PX = HOUR_PX;
export const TIMELINE_SNAP_MIN = SNAP_MIN;
