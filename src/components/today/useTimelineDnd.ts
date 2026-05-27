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
import { useCallback } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";

import type { WorkSignal } from "@/bindings";
import { stage } from "@/lib/calendarSync";
import { applySchedulePatch } from "@/lib/optimisticSchedule";

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
 * date(YYYY-MM-DD) + 그리드 픽셀 오프셋 → 로컬 ISO(YYYY-MM-DDTHH:MM:SS).
 * 음수는 0(00:00)으로 clamp, 24h 초과는 23:45로 clamp(스냅 정렬 유지).
 */
export function pixelToLocalIso(date: string, gridY: number): string {
  const rawMin = (gridY / HOUR_PX) * 60;
  const snapped = snap(rawMin);
  const clamped = Math.max(0, Math.min(24 * 60 - SNAP_MIN, snapped));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${date}T${pad(h)}:${pad(m)}:00`;
}

/** 기존 ISO(또는 null) + delta px → 새 로컬 ISO. timezone-drift 안전. */
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
  return `${date}T${pad(h)}:${pad(m)}:00`;
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
      signalId: string;
      title: string;
      startISO: string;
      durationMin: number;
      calendarId: string;
    }
  | {
      from: "routine";
      routineId: string;
      title: string;
    };

/** drop data attached to droppable nodes via `useDroppable({ data: ... })`. */
export type DropData =
  | { to: "tray" }
  | { to: "canvas"; gridY: number }
  | { to: "canvas:cal"; calendarId: string; gridY: number };

type Opts = {
  date: string;
  /** 시그널 id로 프로젝트 기본 캘린더를 찾는다. 없으면 null. */
  defaultCalendarFor: (signalId: string) => string | null;
  /** project default가 없을 때 popover를 띄우고 사용자가 고른 캘린더 id를 resolve. */
  promptCalendarPicker: (signalId: string) => Promise<string | null>;
};

/**
 * onDragEnd 한 곳에서 7가지 인터랙션을 분기한다. 외부에서 `DndContext`로 감싸 사용한다
 * (또는 본 모듈의 `useTodayDndContext`가 sensors까지 묶는다).
 */
export function useTimelineDnd(opts: Opts) {
  const qc = useQueryClient();
  const { date, defaultCalendarFor, promptCalendarPicker } = opts;

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

  const onDragEnd = useCallback(
    async (ev: DragEndEvent) => {
      const a = ev.active.data.current as DragData | undefined;
      const o = ev.over?.data.current as DropData | undefined;
      if (!a || !o) return;

      // ── 1: tray → canvas ─────────────────────────────────────────────
      if (a.from === "tray" && o.to === "canvas") {
        const cal =
          defaultCalendarFor(a.signalId) ??
          (await promptCalendarPicker(a.signalId));
        if (!cal) return;
        const at = pixelToLocalIso(date, o.gridY);
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

      // ── 2: canvas → canvas (reschedule, 같은 캘린더 시간 이동) ───────
      if (a.from === "canvas" && o.to === "canvas") {
        const at = shiftIsoByPx(date, a.startISO, ev.delta.y);
        patchSignalCaches(a.signalId, { at });
        try {
          await stage({
            kind: "reschedule",
            targetSignalId: a.signalId,
            at,
            durationMin: a.durationMin,
          });
        } catch {
          invalidateSignalCaches();
        }
        return;
      }

      // ── 4: canvas → tray (unschedule) ─────────────────────────────────
      if (a.from === "canvas" && o.to === "tray") {
        patchSignalCaches(a.signalId, { clearLink: true });
        try {
          await stage({ kind: "unschedule", targetSignalId: a.signalId });
        } catch {
          invalidateSignalCaches();
        }
        return;
      }

      // ── 5: canvas → 다른 캘린더 zone (moveCalendar, staged) ──────────
      if (a.from === "canvas" && o.to === "canvas:cal") {
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
        const at = pixelToLocalIso(date, o.gridY);
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
        } catch {
          void qc.invalidateQueries({ queryKey: ["routines"] });
        }
        void qc.invalidateQueries({ queryKey: ["routines"] });
        return;
      }

      // 인터랙션 #3 resize / #6 createBlank: 후속 commit (PR 7 정련).
    },
    [
      date,
      defaultCalendarFor,
      promptCalendarPicker,
      patchSignalCaches,
      invalidateSignalCaches,
      qc,
    ],
  );

  return { onDragEnd };
}

/** sensors까지 묶어 한 번에 쓸 수 있는 컨테이너 컴포넌트 helper. */
export function useTodayDndSensors() {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
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
