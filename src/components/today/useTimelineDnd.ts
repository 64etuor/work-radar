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
  type KeyboardCoordinateGetter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import { type MutableRefObject } from "react";

import type { CalendarEvent, RoutineToday, SignalDayPlacement, WorkSignal } from "@/bindings";
import { stage } from "@/lib/calendarSync";
import {
  applyPlacementPatch,
  applySchedulePatch,
  type PlacementPatch,
} from "@/lib/optimisticSchedule";
import { absMin, localDateOf } from "@/lib/timeAxis";
import {
  clampDurationToDate,
  clampIsoToDate,
  pixelToLocalIso,
  plusMinutesLocal,
  resizeIsoByPx,
  shiftIsoByPx,
} from "@/lib/timelineCoords";
import { type LayoutBox, magnetEdgesFromBoxes } from "@/lib/timelineLayout";
import { useToastStore } from "@/lib/toast";

const HOUR_PX = 60;
const SNAP_MIN = 15;
/** signal 신규 배치 기본 길이(분) — 스펙 §D8. */
const DEFAULT_SCHEDULE_MIN = 60;
/** routine 신규 배치 길이(분) — 스펙 §D8 루틴 가상 인스턴스. */
const ROUTINE_SCHEDULE_MIN = 30;
/** 로컬 ISO('YYYY-MM-DDTHH:MM...')에서 HH:MM — routine_checks.time_override 포맷. */
const hhmmOfIso = (iso: string): string => iso.slice(11, 16);

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
      /**
       * 동기화된 루틴이 이벤트 블록으로 렌더된 경우(todayBlocks 흡수) 그 루틴 id.
       * 이동/리사이즈 stage에 동봉해 routine_checks.time_override를 함께 미러 — 캘린더만
       * 움직이고 루틴이 옛 시각에 남아 블록이 스냅백하는 버그 방지.
       */
      routineId?: string;
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
      /** 동기화된 루틴의 이벤트 블록이면 루틴 id(canvas variant와 동일 의미). */
      routineId?: string;
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

/**
 * `over`가 있으면 그대로 반환, 없으면 `active` 타입으로 폴백을 결정한다.
 * `release`를 주면 그리드 밖 canvas/canvas-resize 릴리스를 `undefined`(스냅백)로 분류한다 —
 * 단 이 함수는 순수 분류기로 토스트를 띄우지 않는다. 사용자 알림(토스트)은 호출부(onDragEnd)가
 * 이 함수 호출 전에 책임진다.
 */
export function normalizeDropDataForDragEnd(
  active: DragData | undefined,
  over: DropData | undefined,
  release?: ReleaseAt,
): DropData | undefined {
  if (over) return over;
  if (!active) return undefined;
  if (active.from === "canvas" || active.from === "canvas-resize") {
    if (release && isOffGridCanvasRelease(active, over, release)) return undefined;
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

/**
 * tray/routine 드래그가 droppable 없이(`over` undefined) 끝났을 때만 canvas 폴백을 합성할지 판단.
 * 기본 충돌판정(rectIntersection)은 작은 트레이 카드를 빠르게/가장자리로 놓으면 캔버스 droppable을
 * `over`로 보고하지 않을 수 있고, 그러면 onDragEnd가 무음 return → "드래그가 안 먹는" 회귀가 된다.
 * canvas/canvas-resize 자기-드롭은 normalizeDropDataForDragEnd가 이미 폴백하므로 제외.
 */
export function shouldSynthesizeCanvasDropFromPointer(
  active: DragData | undefined,
  over: DropData | undefined,
  isPointerDrag: boolean,
): boolean {
  // 키보드 드래그는 last pointer가 사용자가 가리킨 곳이 아니다(마우스 잔여 좌표) — 폴백 금지.
  if (!isPointerDrag) return false;
  if (over) return false;
  if (!active) return false;
  return active.from === "tray" || active.from === "routine";
}

/** client 좌표가 rect 경계(가장자리 포함) 안인지. 폴백을 그리드 밖 드롭으로 오발동시키지 않기 위함. */
export function isClientPointInsideRect(
  point: { x: number; y: number },
  rect: { left: number; right: number; top: number; bottom: number },
): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

/** 릴리스 위치 분류용 입력 — 마지막 raw 포인터(viewport)와 드롭 시점 fresh 그리드 rect. */
export type ReleaseAt = {
  point: { x: number; y: number } | null | undefined;
  rect: { left: number; right: number; top: number; bottom: number } | null | undefined;
};

/**
 * canvas/canvas-resize 드래그가 droppable 없이(over 없음) 끝났는데 release 포인터가 그리드 rect
 * 밖이면 "그리드 밖 릴리스"로 분류한다 — 커밋하지 않고 스냅백 + 토스트. 포인터/rect를 모르면(키보드
 * 드래그/ref 미주입) 분류하지 않아 기존 delta 기반 커밋을 유지한다. dnd-kit collision-miss(포인터는
 * 그리드 안)는 off-grid가 아니다 — 그 경우 기존처럼 delta로 재해석한다.
 */
export function isOffGridCanvasRelease(
  active: DragData | undefined,
  over: DropData | undefined,
  release: ReleaseAt,
): boolean {
  if (over) return false;
  if (!active) return false;
  if (active.from !== "canvas" && active.from !== "canvas-resize") return false;
  if (!release.point || !release.rect) return false;
  return !isClientPointInsideRect(release.point, release.rect);
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
  /** 자석 스냅 후보용 현재 레이아웃 박스(드래그 중 정적). 미지정이면 자석 없음. */
  boxes?: LayoutBox[];
  /** Alt/Option fine-snap(5분) 라이브 상태 ref. true면 snapMin=5. */
  fineSnapRef?: MutableRefObject<boolean>;
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
    boxes,
    fineSnapRef,
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
    void qc.invalidateQueries({ queryKey: ["signalPlacements"] });
    void qc.invalidateQueries({ queryKey: ["signalTimeTotals"] });
  };

  /** ["signalPlacements"] 캐시 optimistic 패치 — 렌더는 placement가 SSOT라 이걸 패치해야 스냅백이 없다. */
  const patchPlacementCaches = (signalId: string, patch: PlacementPatch) => {
    qc.setQueriesData<SignalDayPlacement[]>({ queryKey: ["signalPlacements"] }, (old) =>
      old ? applyPlacementPatch(old, signalId, patch) : old,
    );
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
    const overData = ev.over?.data.current as DropData | undefined;
    // 키보드 드래그(KeyboardSensor)는 last pointer가 사용자가 가리킨 곳이 아니므로 release 분류 제외.
    const isPointerDrag = !(ev.activatorEvent instanceof KeyboardEvent);
    const release: ReleaseAt | undefined = isPointerDrag
      ? {
          point: pointerClientRef?.current ?? null,
          rect: gridElRef?.current?.getBoundingClientRect() ?? null,
        }
      : undefined;
    // canvas/canvas-resize를 그리드 밖에서 릴리스하면 커밋하지 않고 스냅백 + 토스트(이전엔 delta로
    // 그리드 상단에 커밋됐다). collision-miss(포인터는 그리드 안)는 off-grid가 아니라 그대로 커밋.
    if (release && isOffGridCanvasRelease(a, overData, release)) {
      useToastStore.getState().pushError("timeline.drop", "타임라인 영역 밖이라 되돌렸습니다");
      return;
    }
    let o = normalizeDropDataForDragEnd(a, overData, release);
    // tray/routine 드래그가 over 없이 끝났을 때: 마지막 포인터가 그리드 rect 안이면 canvas 배치로
    // 폴백(무음 noop 방지), 밖이면 토스트로 알린다.
    if (shouldSynthesizeCanvasDropFromPointer(a, o, isPointerDrag)) {
      const p = pointerClientRef?.current;
      const rect = gridElRef?.current?.getBoundingClientRect();
      if (p && rect && isClientPointInsideRect(p, rect)) {
        o = { to: "canvas", gridY: 0 };
      } else {
        useToastStore
          .getState()
          .pushError("timeline.drop", "타임라인 영역 안에 놓아야 배치할 수 있습니다");
      }
    }
    if (!a || !o) return;

    const snapMin = fineSnapRef?.current ? 5 : 15;
    const snapOptsFor = (blockId: string) => ({
      snapMin,
      magnetEdges: magnetEdgesFromBoxes(boxes ?? [], anchorDate, blockId),
    });

    // ── 1: tray → canvas ─────────────────────────────────────────────
    if (a.from === "tray" && o.to === "canvas") {
      const cal =
        defaultCalendarFor(a.signalId) ?? (await promptCalendarPicker(a.signalId, "signal"));
      if (!cal) return;
      const at = pixelToLocalIso(anchorDate, days, resolveCanvasGridY(o.gridY));
      const durationMin = a.durationMin ?? DEFAULT_SCHEDULE_MIN;
      patchSignalCaches(a.signalId, { at, durationMin, calendarId: cal });
      patchPlacementCaches(a.signalId, {
        type: "upsert",
        date: localDateOf(at),
        startAt: at,
        durationMin,
      });
      try {
        await stage({
          kind: "schedule",
          targetSignalId: a.signalId,
          at,
          durationMin,
          calendarId: cal,
          title: a.title,
        });
        void qc.invalidateQueries({ queryKey: ["signalTimeTotals"] });
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
        snapOpts: snapOptsFor(a.blockId),
      });
      // 루틴은 occurrence 날짜 안으로 클램프 — routine_checks(date+HH:MM)가 다음 날 새벽을
      // 표현하지 못한다(스펙 §5). top 핸들이 날짜를 넘으면 그 날 00:00에서 멈춘다.
      // 동기화된 루틴의 이벤트 블록(routineId 동봉)도 time_override가 같은 구조라 동일 클램프.
      const occDate = localDateOf(a.startISO);
      const routineBacked =
        a.blockKind === "routine" || (a.blockKind === "event" && a.routineId != null);
      const at = routineBacked ? clampIsoToDate(resized.at, occDate) : resized.at;
      // 클램프로 시작이 밀렸으면 끝 시각 고정을 위해 duration을 보정(absMin 차이만큼).
      // 루틴은 끝도 자정을 넘지 못한다(bottom-resize 상한 — Google master end 누수 방지).
      let clamped =
        at === resized.at
          ? resized.durationMin
          : resized.durationMin + (absMin(resized.at, occDate) - absMin(at, occDate));
      if (routineBacked) clamped = clampDurationToDate(at, occDate, clamped);
      if (clamped === a.durationMin && at === a.startISO) return;
      if (a.blockKind === "event") {
        patchEventCache(a.calendarId, a.eventId, {
          start: at,
          durationMin: clamped,
        });
        // 루틴-backed면 루틴 캐시의 timeOverride도 같이 패치 — refetch 전 interim에도
        // routineMatchesEvent가 성립해 블록이 새 위치에 머문다.
        if (a.routineId) {
          patchRoutineCache(occDate, a.routineId, { timeOverride: hhmmOfIso(at) });
        }
      } else if (a.blockKind === "signal") {
        patchSignalCaches(a.signalId, {
          at,
          durationMin: clamped,
        });
        patchPlacementCaches(a.signalId, {
          type: "move",
          fromDate: localDateOf(a.startISO),
          date: localDateOf(at),
          startAt: at,
          durationMin: clamped,
        });
      } else if (a.blockKind === "routine") {
        // durationMin은 패치하지 않는다 — routine_checks엔 per-day duration 컬럼이 없어
        // 서버가 영속하지 않는 값(정의의 duration_min으로 refetch 시 복귀)을 캐시에 약속하면
        // 리사이즈 높이가 곧 스냅백한다. 시간 위치(time_override)만 optimistic.
        patchRoutineCache(occDate, a.routineId, { timeOverride: hhmmOfIso(at) });
      }
      try {
        if (a.blockKind === "event") {
          await stage({
            kind: "eventResize",
            eventId: a.eventId,
            calendarId: a.calendarId,
            at,
            durationMin: clamped,
            routineId: a.routineId,
            routineDate: a.routineId ? occDate : undefined,
          });
          if (a.routineId) void qc.invalidateQueries({ queryKey: ["routines"] });
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
            fromDate: localDateOf(a.startISO),
          });
          void qc.invalidateQueries({ queryKey: ["signalTimeTotals"] });
        }
      } catch {
        if (a.blockKind === "event") {
          invalidateEventCaches();
          if (a.routineId) void qc.invalidateQueries({ queryKey: ["routines"] });
        } else if (a.blockKind === "routine") {
          void qc.invalidateQueries({ queryKey: ["routines"] });
        } else {
          invalidateSignalCaches();
        }
      }
      return;
    }

    // ── 2: canvas → canvas (reschedule, 같은 캘린더 시간 이동) ───────
    if (a.from === "canvas" && o.to === "canvas") {
      const shifted = shiftIsoByPx(
        anchorDate,
        days,
        a.startISO,
        ev.delta.y,
        snapOptsFor(a.blockId),
      );
      // 루틴은 occurrence 날짜 안으로 클램프(스펙 §5) — event/signal은 자정 통과 자유.
      // 동기화된 루틴의 이벤트 블록(routineId 동봉)도 time_override(date+HH:MM) 구조라 동일 클램프.
      const occDate = localDateOf(a.startISO);
      const routineBacked =
        a.blockKind === "routine" || (a.blockKind === "event" && a.routineId != null);
      const at = routineBacked ? clampIsoToDate(shifted, occDate) : shifted;
      // 루틴-backed는 위치 클램프 후에도 끝이 자정을 넘을 수 있다(23:45+60분) — 루틴 분기와 동일 상한.
      const movedDurationMin = routineBacked
        ? clampDurationToDate(at, occDate, a.durationMin)
        : a.durationMin;
      if (a.blockKind === "event") {
        patchEventCache(a.calendarId, a.eventId, { start: at, durationMin: movedDurationMin });
        if (a.routineId) {
          patchRoutineCache(occDate, a.routineId, { timeOverride: hhmmOfIso(at) });
        }
      } else if (a.blockKind === "signal") {
        patchSignalCaches(a.signalId, { at });
        patchPlacementCaches(a.signalId, {
          type: "move",
          fromDate: localDateOf(a.startISO),
          date: localDateOf(at),
          startAt: at,
          durationMin: a.durationMin,
        });
      } else if (a.blockKind === "routine") {
        patchRoutineCache(occDate, a.routineId, { timeOverride: hhmmOfIso(at) });
      }
      try {
        if (a.blockKind === "event") {
          await stage({
            kind: "eventReschedule",
            eventId: a.eventId,
            calendarId: a.calendarId,
            at,
            durationMin: movedDurationMin,
            routineId: a.routineId,
            routineDate: a.routineId ? occDate : undefined,
          });
          if (a.routineId) void qc.invalidateQueries({ queryKey: ["routines"] });
        } else if (a.blockKind === "routine") {
          await stage({
            kind: "routineReschedule",
            routineId: a.routineId,
            date: occDate,
            at,
            durationMin: movedDurationMin,
          });
          void qc.invalidateQueries({ queryKey: ["routines"] });
        } else {
          await stage({
            kind: "reschedule",
            targetSignalId: a.signalId,
            at,
            durationMin: a.durationMin,
            fromDate: localDateOf(a.startISO),
          });
          void qc.invalidateQueries({ queryKey: ["signalTimeTotals"] });
        }
      } catch {
        if (a.blockKind === "event") {
          invalidateEventCaches();
          if (a.routineId) void qc.invalidateQueries({ queryKey: ["routines"] });
        } else if (a.blockKind === "routine") {
          void qc.invalidateQueries({ queryKey: ["routines"] });
        } else {
          invalidateSignalCaches();
        }
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
      patchPlacementCaches(signalId, { type: "remove", date: localDateOf(prevAt) });
      try {
        await stage({
          kind: "unschedule",
          targetSignalId: signalId,
          fromDate: localDateOf(prevAt),
        });
        // 1.5s 토스트 + undo 액션(다시 reschedule). pushInfo 자동 dismiss(2500ms)에 의존,
        // onUndo는 사용자가 명시적으로 눌렀을 때만 실행.
        useToastStore.getState().pushInfo("일정 해제됨", {
          onUndo: () => {
            // 되돌리기 = 원래 자리 복원: placements 캐시를 즉시 재패치해야 블록이 바로 돌아온다
            // (다른 DnD 분기들과 동일한 optimistic 규율).
            patchPlacementCaches(signalId, {
              type: "upsert",
              date: localDateOf(prevAt),
              startAt: prevAt,
              durationMin: prevDur,
            });
            void stage({
              kind: "reschedule",
              targetSignalId: signalId,
              at: prevAt,
              durationMin: prevDur,
              fromDate: localDateOf(prevAt),
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
      const at = shiftIsoByPx(anchorDate, days, a.startISO, ev.delta.y, snapOptsFor(a.blockId));
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

/**
 * 키보드 드래그 좌표 스텝 — 세로 타임라인이라 ArrowUp/Down만 처리(1px=1min): 기본 15분, Shift=1h.
 * 좌우 화살표는 무시(undefined → dnd-kit 무이동). Space/Enter(집기/놓기)·Esc(취소)는 KeyboardSensor가 처리.
 */
export const timelineKeyboardCoordinates: KeyboardCoordinateGetter = (
  event,
  { currentCoordinates },
) => {
  const step = event.shiftKey ? 60 : 15;
  if (event.code === "ArrowDown") {
    event.preventDefault();
    return { ...currentCoordinates, y: currentCoordinates.y + step };
  }
  if (event.code === "ArrowUp") {
    event.preventDefault();
    return { ...currentCoordinates, y: currentCoordinates.y - step };
  }
  return undefined;
};

/** sensors까지 묶어 한 번에 쓸 수 있는 컨테이너 컴포넌트 helper. */
export function useTodayDndSensors() {
  const sensors = useSensors(
    // distance 3px로 낮춤 — 6px은 일부 환경에서 활성화가 느렸다.
    // delay-based 활성화도 고려 가능(touch 친화)이지만 desktop은 distance가 적합.
    useSensor(PointerSensor, { activationConstraint: { distance: 3 } }),
    useSensor(KeyboardSensor, { coordinateGetter: timelineKeyboardCoordinates }),
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
