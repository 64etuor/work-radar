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

import type { WorkSignal } from "@/bindings";
import type { DragDelta } from "@/components/today/timelinePreview";
import { applyTimelineCommitToCaches } from "@/lib/applyTimelineCommitToCaches";
import { stage } from "@/lib/calendarSync";
import { clientToGrid, totalPxForDays } from "@/lib/timelineAxis";
import { planTimelineDrag } from "@/lib/timelineDragPlan";
import { type LayoutBox } from "@/lib/timelineLayout";
import { useToastStore } from "@/lib/toast";

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
      /** signal이 Google 이벤트와 연결된 경우의 미러 이벤트 id — 언스케줄 시 캐시에서 제거용. */
      linkedEventId?: string;
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

/** stage IPC 인터랙션 종류 — 실패 토스트 카피를 한 곳에서 관리(분기별 무음 스냅백 방지, Phase 4). */
export type StageFailureKind =
  | "schedule"
  | "reschedule"
  | "resize"
  | "unschedule"
  | "moveCalendar"
  | "routineSchedule";

/**
 * stage 실패 시 사용자에게 띄울 토스트(scope+메시지) — 모든 분기가 cross-cal과 동일하게 실패를
 * 가시화한다(무음 롤백 금지). 롤백(invalidate)은 호출부 catch가 별도로 수행한다.
 */
export function stageFailureToast(kind: StageFailureKind): { scope: string; message: string } {
  switch (kind) {
    case "schedule":
      return { scope: "timeline.schedule", message: "일정 배치 실패 — 다시 시도하세요" };
    case "reschedule":
      return { scope: "timeline.reschedule", message: "시간 이동 적용 실패 — 다시 시도하세요" };
    case "resize":
      return { scope: "timeline.resize", message: "길이 조정 적용 실패 — 다시 시도하세요" };
    case "unschedule":
      return { scope: "timeline.unschedule", message: "일정 해제 실패 — 다시 시도하세요" };
    case "moveCalendar":
      return { scope: "calendar.stage", message: "캘린더 이동 스테이징 실패 — 다시 시도하세요" };
    case "routineSchedule":
      return { scope: "timeline.routine", message: "루틴 배치 실패 — 다시 시도하세요" };
  }
}

/**
 * 루틴 드래그/리사이즈가 occurrence 날짜(자정) 경계에 막혔는지 — 요청 위치/길이가 클램프로 바뀌면 true.
 * routine_checks(date+HH:MM)는 자정을 넘지 못하므로(스펙 §5), 이게 true면 "00:00에서 멈춤"을 사용자에게
 * 알린다(클램프 자체는 제거하지 않고 _가시화_만 — Phase 4 어포던스).
 */
export function routineBoundaryClamped(
  rawAt: string,
  clampedAt: string,
  rawDurationMin: number,
  clampedDurationMin: number,
): boolean {
  return rawAt !== clampedAt || rawDurationMin !== clampedDurationMin;
}

type Opts = {
  /**
   * 선택 날짜(레일/트레이 스코프) — 호출부 API 유지를 위해 남긴다. onDragEnd의 optimistic 캐시
   * 패치는 applyTimelineCommitToCaches가 `["today"]` prefix(전 버킷)로 일괄 처리하므로 더 이상
   * 단일 `["today", date]` 키를 직접 쓰지 않는다(SchedulePatch 필드는 날짜 무관 — 매칭 signal id만 변경).
   */
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
  /** operation delta = dnd-kit ev.delta(포인터·키보드 공통, P4). raw pointer는 크로스헤어/릴리스 분류 전용. */
  dragDeltaRef?: MutableRefObject<DragDelta | null>;
};

/**
 * onDragEnd 한 곳에서 7가지 인터랙션을 분기한다. 외부에서 `DndContext`로 감싸 사용한다
 * (또는 본 모듈의 `useTodayDndContext`가 sensors까지 묶는다).
 */
export function useTimelineDnd(opts: Opts) {
  const qc = useQueryClient();
  const {
    anchorDate,
    days,
    defaultCalendarFor,
    promptCalendarPicker,
    gridElRef,
    pointerClientRef,
    boxes,
    fineSnapRef,
    dragDeltaRef,
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
    return clientToGrid(p, rect, totalPxForDays(days)).y;
  };

  const resolveCanvasDragDelta = (fallback: DragDelta): DragDelta =>
    dragDeltaRef?.current ?? fallback;

  // commit-구동 optimistic 캐시 패치(layer-①+②)는 applyTimelineCommitToCaches(SSOT)가 소유한다.
  // 여기엔 reconciler 밖 concern만 남긴다: 롤백 invalidate(catch), unschedule undo의 placement 복원.

  const invalidateSignalCaches = () => {
    void qc.invalidateQueries({ queryKey: ["signals"] });
    void qc.invalidateQueries({ queryKey: ["today"] });
    void qc.invalidateQueries({ queryKey: ["signalPlacements"] });
    void qc.invalidateQueries({ queryKey: ["signalTimeTotals"] });
  };

  const invalidateEventCaches = () => {
    void qc.invalidateQueries({ queryKey: ["calendarEvents"] });
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
    // 드래그 OPERATION 수학(at/durationMin/branch)의 단일 정본 — preview와 동일 코드(planTimelineDrag).
    // schedule/routineSchedule의 픽셀→at는 resolveCanvasGridY로 보정한 gridY를 planner에 넘긴다.
    const plan = planTimelineDrag({
      anchorDate,
      days,
      boxes: boxes ?? [],
      activeDrag: a,
      drop:
        o.to === "canvas"
          ? { to: "canvas", gridY: resolveCanvasGridY(o.gridY) }
          : o.to === "canvas:cal"
            ? { to: "canvas:cal", calendarId: o.calendarId, gridY: resolveCanvasGridY(o.gridY) }
            : { to: "tray" },
      delta: resolveCanvasDragDelta(ev.delta), // == ev.delta(Task A); preview가 쓰는 동일 delta.
      snapMin,
      release,
    });
    if (!plan.commit) return; // no-op(zero movement); off-grid는 427에서 이미 return.
    const c = plan.commit;

    // ── 1: tray → canvas ─────────────────────────────────────────────
    if (c.kind === "schedule") {
      if (a.from !== "tray") return; // 타입 좁힘 — schedule commit은 tray 드래그에서만 나온다.
      const cal =
        defaultCalendarFor(c.targetSignalId) ??
        (await promptCalendarPicker(c.targetSignalId, "signal"));
      if (!cal) return;
      const { at, durationMin } = c;
      // planner는 schedule commit의 calendarId를 미해소(undefined)로 남긴다 — picker로 해소한 cal을
      // 주입해야 reconciler가 linkedCalendarId를 쓴다(미주입 시 회귀: 빈 calendarId로 렌더).
      applyTimelineCommitToCaches(qc, { ...c, calendarId: cal });
      try {
        await stage({
          kind: "schedule",
          targetSignalId: c.targetSignalId,
          at,
          durationMin,
          calendarId: cal,
          title: a.title,
        });
        void qc.invalidateQueries({ queryKey: ["signalTimeTotals"] });
      } catch {
        invalidateSignalCaches();
        const t = stageFailureToast("schedule");
        useToastStore.getState().pushError(t.scope, t.message);
      }
      return;
    }

    // ── 3: canvas-resize → canvas (block 상/하단 핸들 드래그) ───────
    if (c.kind === "eventResize") {
      const { at, durationMin } = c;
      applyTimelineCommitToCaches(qc, c);
      try {
        await stage({
          kind: "eventResize",
          eventId: c.eventId,
          calendarId: c.calendarId,
          at,
          durationMin,
          routineId: c.routineId,
          routineDate: c.routineDate,
        });
        if (c.routineId) void qc.invalidateQueries({ queryKey: ["routines"] });
      } catch {
        invalidateEventCaches();
        if (c.routineId) void qc.invalidateQueries({ queryKey: ["routines"] });
        const t = stageFailureToast("resize");
        useToastStore.getState().pushError(t.scope, t.message);
      }
      return;
    }

    if (c.kind === "routineResize") {
      const { at, durationMin, date: occDate, routineId } = c;
      // durationMin은 패치하지 않는다 — routine_checks엔 per-day duration 컬럼이 없어
      // 서버가 영속하지 않는 값(정의의 duration_min으로 refetch 시 복귀)을 캐시에 약속하면
      // 리사이즈 높이가 곧 스냅백한다(reconciler가 time_override만 패치). 시간 위치만 optimistic.
      applyTimelineCommitToCaches(qc, c);
      // 길이 고정 어포던스(Phase 4) — 루틴 길이는 정의로 고정이라 리사이즈는 높이를 바꾸지 못한다.
      // 무음 스냅백 대신 "시간만 옮겨진다"를 알린다(message-only — 마이그레이션/스키마 변경 없음).
      if (plan.routineLengthFixed) {
        useToastStore.getState().pushInfo("루틴 길이는 정의에서 고정 — 시간만 옮겨집니다");
      }
      try {
        await stage({ kind: "routineResize", routineId, date: occDate, at, durationMin });
        void qc.invalidateQueries({ queryKey: ["routines"] });
      } catch {
        void qc.invalidateQueries({ queryKey: ["routines"] });
        const t = stageFailureToast("resize");
        useToastStore.getState().pushError(t.scope, t.message);
      }
      return;
    }

    if (c.kind === "resize") {
      const { at, durationMin, targetSignalId, fromDate } = c;
      applyTimelineCommitToCaches(qc, c);
      try {
        await stage({ kind: "resize", targetSignalId, at, durationMin, fromDate });
        void qc.invalidateQueries({ queryKey: ["signalTimeTotals"] });
      } catch {
        invalidateSignalCaches();
        const t = stageFailureToast("resize");
        useToastStore.getState().pushError(t.scope, t.message);
      }
      return;
    }

    // ── 2: canvas → canvas (reschedule, 같은 캘린더 시간 이동) ───────
    if (c.kind === "eventReschedule") {
      const { at, durationMin } = c;
      applyTimelineCommitToCaches(qc, c);
      try {
        await stage({
          kind: "eventReschedule",
          eventId: c.eventId,
          calendarId: c.calendarId,
          at,
          durationMin,
          routineId: c.routineId,
          routineDate: c.routineDate,
        });
        if (c.routineId) void qc.invalidateQueries({ queryKey: ["routines"] });
      } catch {
        invalidateEventCaches();
        if (c.routineId) void qc.invalidateQueries({ queryKey: ["routines"] });
        const t = stageFailureToast("reschedule");
        useToastStore.getState().pushError(t.scope, t.message);
      }
      return;
    }

    if (c.kind === "routineReschedule") {
      const { at, durationMin, date: occDate, routineId } = c;
      applyTimelineCommitToCaches(qc, c);
      // 자정 클램프 어포던스(Phase 4) — 요청 위치/길이가 occurrence 날짜 경계에 막혔으면 알린다
      // (스펙 §5의 by-design 한계를 무음 stick 대신 가시화 — 클램프 자체는 유지).
      if (plan.routineBoundaryClamped) {
        useToastStore.getState().pushInfo("루틴은 자정을 넘을 수 없어 그 날 안에서 멈췄어요");
      }
      try {
        await stage({ kind: "routineReschedule", routineId, date: occDate, at, durationMin });
        void qc.invalidateQueries({ queryKey: ["routines"] });
      } catch {
        void qc.invalidateQueries({ queryKey: ["routines"] });
        const t = stageFailureToast("reschedule");
        useToastStore.getState().pushError(t.scope, t.message);
      }
      return;
    }

    if (c.kind === "reschedule") {
      const { at, durationMin, targetSignalId, fromDate } = c;
      applyTimelineCommitToCaches(qc, c);
      try {
        await stage({ kind: "reschedule", targetSignalId, at, durationMin, fromDate });
        void qc.invalidateQueries({ queryKey: ["signalTimeTotals"] });
      } catch {
        invalidateSignalCaches();
        const t = stageFailureToast("reschedule");
        useToastStore.getState().pushError(t.scope, t.message);
      }
      return;
    }

    // ── 4: canvas → tray (unschedule) ─────────────────────────────────
    if (c.kind === "unschedule") {
      // 사전 상태 캡처 — undo 시 정확한 prior state 복원용. a는 canvas signal로 좁혀짐.
      if (a.from !== "canvas" || a.blockKind !== "signal") return;
      const prevAt = a.startISO;
      const prevDur = a.durationMin;
      const prevCalendarId = a.calendarId;
      const prevTitle = a.title;
      const signalId = c.targetSignalId;
      const fromDate = c.fromDate;
      // 미러 이벤트 제거 + signal clearLink + placement remove는 reconciler가 소유.
      applyTimelineCommitToCaches(qc, c);
      try {
        await stage({ kind: "unschedule", targetSignalId: signalId, fromDate });
        // 1.5s 토스트 + undo 액션. pushInfo 자동 dismiss(2500ms)에 의존,
        // onUndo는 사용자가 명시적으로 눌렀을 때만 실행.
        useToastStore.getState().pushInfo("일정 해제됨", {
          onUndo: () => {
            // 되돌리기 = 미러 재생성(schedule-restore). reschedule은 기존 연결 이벤트를 전제하나
            // unschedule이 Google 미러를 삭제했으므로 schedule로 새 미러를 만들어야 한다.
            // prevCalendarId를 그대로 사용: 미러 카드면 동일 캘린더에 재생성, 로컬 전용이면
            // 빈 calendarId로 복원(기존 상태 그대로 — fallback/picker 없음).
            applyTimelineCommitToCaches(qc, {
              kind: "schedule",
              targetSignalId: signalId,
              at: prevAt,
              durationMin: prevDur,
              calendarId: prevCalendarId || undefined,
            });
            void stage({
              kind: "schedule",
              targetSignalId: signalId,
              at: prevAt,
              durationMin: prevDur,
              calendarId: prevCalendarId,
              title: prevTitle,
            });
          },
          undoLabel: "되돌리기",
        });
      } catch {
        invalidateSignalCaches();
        invalidateEventCaches();
        const t = stageFailureToast("unschedule");
        useToastStore.getState().pushError(t.scope, t.message);
      }
      return;
    }

    // ── 5: canvas → 다른 캘린더 zone (moveCalendar, staged) ──────────
    if (c.kind === "moveCalendar") {
      if (a.from !== "canvas") return; // 타입 좁힘 — moveCalendar는 canvas 드래그에서만.
      try {
        await stage({
          kind: "moveCalendar",
          targetSignalId: c.targetSignalId,
          calendarId: c.calendarId,
          at: c.at,
          durationMin: c.durationMin,
          title: a.title,
        });
      } catch {
        // stage IPC 자체가 실패하면 큐 행이 안 생겨 usePendingWrites에도 안 뜬다 —
        // 무음이면 사용자는 이동이 접수된 줄 안다. 토스트로 노출.
        const t = stageFailureToast("moveCalendar");
        useToastStore.getState().pushError(t.scope, t.message);
      }
      void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
      return;
    }

    // ── 7: routine → canvas (routineSchedule, 1회성 시간 배치) ────────
    if (c.kind === "routineSchedule") {
      if (a.from !== "routine") return; // 타입 좁힘 — routineSchedule은 routine 드래그에서만.
      // routine은 routineId 기반 calendar 매핑이 없으므로 picker만(default lookup 없음).
      const cal = await promptCalendarPicker(c.routineId, "routine");
      if (!cal) return;
      try {
        await stage({
          kind: "routineSchedule",
          routineId: c.routineId,
          // 드롭 위치의 날짜가 곧 occurrence — 인접 날짜 영역에 떨어뜨리면 그 날 배치.
          date: c.date,
          at: c.at,
          durationMin: c.durationMin,
          calendarId: cal,
          title: a.title,
        });
      } catch (e) {
        // success/failure 모두 한 번만 invalidate. catch 없는 try/finally는
        // React Compiler BuildHIR 미지원이라 finally 대신 양 경로에 명시.
        void qc.invalidateQueries({ queryKey: ["routines"] });
        const t = stageFailureToast("routineSchedule");
        useToastStore.getState().pushError(t.scope, t.message);
        throw e;
      }
      void qc.invalidateQueries({ queryKey: ["routines"] });
      return;
    }

    // 인터랙션 #6 createBlank(빈 슬롯 직접 그리기): 후속 commit (PR 7 정련).
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
