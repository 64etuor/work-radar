/**
 * `planTimelineDrag` — Today 타임라인 드래그 규칙의 단일 순수 정본(SSOT).
 *
 * 현재 드래그 OPERATION 규칙(resize/move 수학, routine occurrence 클램프, post-clamp duration
 * 보정, snap/magnet, off-grid 분류)은 두 곳에 **중복**되어 서로 일치해야 한다:
 *   - preview: `src/components/today/timelinePreview.ts`
 *   - commit:  `src/components/today/useTimelineDnd.ts` onDragEnd 분기
 *
 * 이 모듈은 그 규칙을 한 순수 함수로 모아 preview(previewBoxes/guide)와 commit이 같은 코드에서
 * 계산되도록 한다. **본 모듈은 빌드만 하고 아직 와이어링하지 않는다(Task 4.3/4.4)** — 즉
 * timelinePreview.ts/useTimelineDnd.ts는 변경 없이 그대로 두고, 본 함수가 동일 산출을 재현한다.
 *
 * 순수성: @dnd-kit import 금지(이 파일은 `src/lib`). Date.now/DOM 사용 금지.
 * INVARIANT #7: 로컬-오프셋 ISO는 timeAxis 문자열 연산(`absMin`/`isoFromAbsMin`)으로만 — `toISOString()`/
 * `new Date().getHours()` 금지. 픽셀 상수는 timelineAxis SSOT(새 상수 정의 금지).
 */
import type { DragData } from "@/components/today/useTimelineDnd";

import { absMin, localDateOf } from "./timeAxis";
import {
  clampDurationToDate,
  clampIsoToDate,
  pixelToLocalIso,
  plusMinutesLocal,
  resizeIsoByPx,
  shiftIsoByPx,
} from "./timelineCoords";
import {
  computeLayout,
  type LayoutBox,
  magnetEdgesFromBoxes,
  type TimedBlock,
} from "./timelineLayout";

/** signal 신규 배치 기본 길이(분) — useTimelineDnd `DEFAULT_SCHEDULE_MIN`. */
const DEFAULT_SCHEDULE_MIN = 60;
/** routine 신규 배치 길이(분) — useTimelineDnd `ROUTINE_SCHEDULE_MIN`. */
const ROUTINE_SCHEDULE_MIN = 30;

/** RFC3339-구조 client point/rect 대체 타입(DOM 비의존 — off-grid 분류 입력). */
export type DOMRectLike = { left: number; right: number; top: number; bottom: number };

export type TimelineDragInput = {
  /** 연속 절대 분 축의 0점(로드된 첫 날짜). */
  anchorDate: string;
  /** 로드된 일수 — 픽셀↔ISO 클램프 상한. */
  days: number;
  /** 드래그 중 정적인 현재 레이아웃 박스(magnet 후보·preview 베이스). */
  boxes: LayoutBox[];
  /** 드래그 중인 아이템(a). */
  activeDrag: DragData | null;
  /** 드롭 타겟(o). null = over 없음(off-grid 분류 후보). */
  drop: { to: "canvas" | "tray" | "canvas:cal"; gridY?: number; calendarId?: string } | null;
  /** dnd-kit ev.delta(P4 Task A 이후 이미 operation delta). */
  delta: { x: number; y: number };
  /** 그리드 스냅 단위(분). 15(기본) 또는 5(fine-snap). */
  snapMin: number;
  /** off-grid 분류 입력(display + release 전용). */
  release?: { point?: { x: number; y: number } | null; rect?: DOMRectLike | null } | null;
};

export type TimelineCommit =
  | { kind: "resize"; targetSignalId: string; at: string; durationMin: number; fromDate: string }
  | {
      kind: "eventResize";
      eventId: string;
      calendarId: string;
      at: string;
      durationMin: number;
      routineId?: string;
      routineDate?: string;
    }
  | { kind: "routineResize"; routineId: string; date: string; at: string; durationMin: number }
  | {
      kind: "reschedule";
      targetSignalId: string;
      at: string;
      durationMin: number;
      fromDate: string;
    }
  | {
      kind: "eventReschedule";
      eventId: string;
      calendarId: string;
      at: string;
      durationMin: number;
      routineId?: string;
      routineDate?: string;
    }
  | { kind: "routineReschedule"; routineId: string; date: string; at: string; durationMin: number }
  | {
      kind: "schedule";
      targetSignalId: string;
      at: string;
      durationMin: number;
      calendarId?: string;
      title?: string;
    }
  | {
      kind: "routineSchedule";
      routineId: string;
      date: string;
      at: string;
      durationMin: number;
      title?: string;
    }
  | { kind: "unschedule"; targetSignalId: string; fromDate: string }
  | {
      kind: "moveCalendar";
      targetSignalId: string;
      calendarId: string;
      at: string;
      durationMin: number;
      title?: string;
    };

export type TimelineDragGuide = {
  x: number;
  y: number;
  durationMin: number;
};

export type TimelineDragPlan = {
  /** active 블록을 preview 위치로 이동/리사이즈한 박스(== previewTimelineBoxes). */
  previewBoxes: LayoutBox[];
  /** dragGuideFromLayout과 동일 shape. null = canvas 드래그 아님. */
  guide: TimelineDragGuide | null;
  /** commit payload. null = off-grid/no-op(스냅백/early-return). */
  commit: TimelineCommit | null;
  /**
   * 루틴 길이 고정 어포던스(canvas-resize routine 분기) — 현재 useTimelineDnd가
   * pushInfo("루틴 길이는 정의에서 고정 …")로 띄우는 신호. 와이어링 시 caller가 surface.
   */
  routineLengthFixed?: boolean;
  /**
   * 자정 클램프 어포던스(canvas reschedule routine 분기) — 현재 useTimelineDnd가
   * routineBoundaryClamped 시 pushInfo로 알리는 신호. 와이어링 시 caller가 surface.
   */
  routineBoundaryClamped?: boolean;
};

/** 드래그 중인 캔버스 블록의 정본 id — DragData.blockId(timelinePreview.blockIdForDrag와 동일). */
function blockIdForDrag(data: DragData): string | null {
  if (data.from !== "canvas" && data.from !== "canvas-resize") return null;
  return data.blockId;
}

/** routine-backed 판정 — useTimelineDnd/timelinePreview와 동일 규칙. */
function isRoutineBacked(activeDrag: DragData): boolean {
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") return false;
  return (
    activeDrag.blockKind === "routine" ||
    (activeDrag.blockKind === "event" && activeDrag.routineId != null)
  );
}

function isClientPointInsideRect(point: { x: number; y: number }, rect: DOMRectLike): boolean {
  return (
    point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
  );
}

/**
 * canvas/canvas-resize 드래그가 droppable 없이 끝났는데 release 포인터가 그리드 rect 밖이면
 * "off-grid 릴리스"로 분류(커밋 안 함 — 스냅백). isOffGridCanvasRelease(useTimelineDnd)와 동치.
 */
function isOffGridCanvasRelease(input: TimelineDragInput): boolean {
  const { activeDrag, drop, release } = input;
  if (drop) return false;
  if (!activeDrag) return false;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") return false;
  if (!release?.point || !release?.rect) return false;
  return !isClientPointInsideRect(release.point, release.rect);
}

/**
 * preview 박스 계산 — previewTimelineBoxes(timelinePreview.ts)와 동일 산출.
 * canvas/canvas-resize 드래그만 active 블록을 이동/리사이즈; 그 외엔 입력 박스 그대로.
 */
function computePreviewBoxes(input: TimelineDragInput): LayoutBox[] {
  const { boxes, activeDrag, delta, anchorDate, days, snapMin } = input;
  if (!activeDrag) return boxes;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") return boxes;
  const activeId = blockIdForDrag(activeDrag);
  if (!activeId) return boxes;

  const snapOpts = {
    snapMin,
    magnetEdges: magnetEdgesFromBoxes(boxes, anchorDate, activeId),
  };

  let changed = false;
  const blocks: TimedBlock[] = boxes.map((box) => {
    const block = box.block;
    if (block.id !== activeId) return block;

    const occDate = localDateOf(activeDrag.startISO);
    const routineBacked = isRoutineBacked(activeDrag);

    if (activeDrag.from === "canvas") {
      const shifted = shiftIsoByPx(anchorDate, days, activeDrag.startISO, delta.y, snapOpts);
      const startISO = routineBacked ? clampIsoToDate(shifted, occDate) : shifted;
      const durationMin = routineBacked
        ? clampDurationToDate(startISO, occDate, activeDrag.durationMin)
        : activeDrag.durationMin;
      const endISO = plusMinutesLocal(startISO, durationMin);
      changed = startISO !== block.startISO || endISO !== block.endISO;
      return { ...block, startISO, endISO };
    }

    const resized = resizeIsoByPx({
      anchorDate,
      days,
      startISO: activeDrag.startISO,
      durationMin: activeDrag.durationMin,
      edge: activeDrag.edge,
      deltaPx: delta.y,
      snapOpts,
    });
    const at = routineBacked ? clampIsoToDate(resized.at, occDate) : resized.at;
    let durationMin =
      at === resized.at
        ? resized.durationMin
        : resized.durationMin + (absMin(resized.at, occDate) - absMin(at, occDate));
    if (routineBacked) durationMin = clampDurationToDate(at, occDate, durationMin);
    const endISO = plusMinutesLocal(at, durationMin);
    changed = at !== block.startISO || endISO !== block.endISO;
    return { ...block, startISO: at, endISO };
  });

  return changed ? computeLayout(blocks, anchorDate) : boxes;
}

/** guide 계산 — dragGuideFromLayout(timelinePreview.ts)와 동일 산출.
 *  단 gridWidth 의존 x는 와이어링(Task 4.3)에서 합성하므로, 여기선 y/durationMin만 정본으로 둔다 —
 *  x는 caller가 gridWidth로 합성(planner는 gridWidth를 받지 않음). */
function computeGuide(input: TimelineDragInput): TimelineDragGuide | null {
  const { boxes, activeDrag, delta, days } = input;
  if (!activeDrag) return null;
  if (activeDrag.from !== "canvas" && activeDrag.from !== "canvas-resize") return null;
  const activeId = blockIdForDrag(activeDrag);
  if (!activeId) return null;
  const activeBox = boxes.find((box) => box.id === activeId);
  if (!activeBox) return null;

  const maxY = days * 1440;
  const routineBacked = isRoutineBacked(activeDrag);
  const dayStart = Math.floor(activeBox.visual.topPx / 1440) * 1440;

  if (activeDrag.from === "canvas-resize") {
    const rawEdgeY =
      activeDrag.edge === "top"
        ? activeBox.visual.topPx + delta.y
        : activeBox.visual.topPx + activeBox.visual.heightPx + delta.y;
    const edgeY = !routineBacked
      ? rawEdgeY
      : activeDrag.edge === "top"
        ? Math.max(dayStart, Math.min(dayStart + 1440 - 15, rawEdgeY))
        : Math.max(dayStart + 15, Math.min(dayStart + 1440, rawEdgeY));
    return {
      x: 0,
      y: Math.max(0, Math.min(maxY, edgeY)),
      durationMin: activeDrag.durationMin,
    };
  }

  const moveY = activeBox.visual.topPx + delta.y;
  const clampedY = routineBacked
    ? Math.max(dayStart, Math.min(dayStart + 1440 - 15, moveY))
    : moveY;
  return {
    x: 0,
    y: Math.max(0, Math.min(maxY, clampedY)),
    durationMin: activeDrag.durationMin,
  };
}

/** canvas-resize 분기 commit — useTimelineDnd `a.from === "canvas-resize"`와 동치. */
function planResize(input: TimelineDragInput): {
  commit: TimelineCommit | null;
  routineLengthFixed?: boolean;
} {
  const { activeDrag, anchorDate, days, delta, snapMin, boxes } = input;
  if (!activeDrag || activeDrag.from !== "canvas-resize") return { commit: null };

  const snapOpts = {
    snapMin,
    magnetEdges: magnetEdgesFromBoxes(boxes, anchorDate, activeDrag.blockId),
  };
  const resized = resizeIsoByPx({
    anchorDate,
    days,
    startISO: activeDrag.startISO,
    durationMin: activeDrag.durationMin,
    edge: activeDrag.edge,
    deltaPx: delta.y,
    snapOpts,
  });
  const occDate = localDateOf(activeDrag.startISO);
  const routineBacked = isRoutineBacked(activeDrag);
  const at = routineBacked ? clampIsoToDate(resized.at, occDate) : resized.at;
  let clamped =
    at === resized.at
      ? resized.durationMin
      : resized.durationMin + (absMin(resized.at, occDate) - absMin(at, occDate));
  if (routineBacked) clamped = clampDurationToDate(at, occDate, clamped);
  // no-op(스냅백) — duration·시작 둘 다 변화 없음.
  if (clamped === activeDrag.durationMin && at === activeDrag.startISO) return { commit: null };

  if (activeDrag.blockKind === "event") {
    return {
      commit: {
        kind: "eventResize",
        eventId: activeDrag.eventId,
        calendarId: activeDrag.calendarId,
        at,
        durationMin: clamped,
        routineId: activeDrag.routineId,
        routineDate: activeDrag.routineId ? occDate : undefined,
      },
    };
  }
  if (activeDrag.blockKind === "routine") {
    return {
      commit: {
        kind: "routineResize",
        routineId: activeDrag.routineId,
        date: occDate,
        at,
        durationMin: clamped,
      },
      routineLengthFixed: true,
    };
  }
  return {
    commit: {
      kind: "resize",
      targetSignalId: activeDrag.signalId,
      at,
      durationMin: clamped,
      fromDate: localDateOf(activeDrag.startISO),
    },
  };
}

/** canvas reschedule 분기 commit — useTimelineDnd `a.from === "canvas" && o.to === "canvas"`와 동치. */
function planReschedule(input: TimelineDragInput): {
  commit: TimelineCommit | null;
  routineBoundaryClamped?: boolean;
} {
  const { activeDrag, anchorDate, days, delta, snapMin, boxes } = input;
  if (!activeDrag || activeDrag.from !== "canvas") return { commit: null };

  const snapOpts = {
    snapMin,
    magnetEdges: magnetEdgesFromBoxes(boxes, anchorDate, activeDrag.blockId),
  };
  const shifted = shiftIsoByPx(anchorDate, days, activeDrag.startISO, delta.y, snapOpts);
  const occDate = localDateOf(activeDrag.startISO);
  const routineBacked = isRoutineBacked(activeDrag);
  const at = routineBacked ? clampIsoToDate(shifted, occDate) : shifted;
  const movedDurationMin = routineBacked
    ? clampDurationToDate(at, occDate, activeDrag.durationMin)
    : activeDrag.durationMin;

  if (activeDrag.blockKind === "event") {
    return {
      commit: {
        kind: "eventReschedule",
        eventId: activeDrag.eventId,
        calendarId: activeDrag.calendarId,
        at,
        durationMin: movedDurationMin,
        routineId: activeDrag.routineId,
        routineDate: activeDrag.routineId ? occDate : undefined,
      },
    };
  }
  if (activeDrag.blockKind === "routine") {
    return {
      commit: {
        kind: "routineReschedule",
        routineId: activeDrag.routineId,
        date: occDate,
        at,
        durationMin: movedDurationMin,
      },
      // routineBoundaryClamped: 요청 위치/길이가 occurrence 경계에 막혔는지.
      routineBoundaryClamped: shifted !== at || activeDrag.durationMin !== movedDurationMin,
    };
  }
  // signal: useTimelineDnd reschedule은 duration을 a.durationMin 그대로 stage한다(movedDurationMin 아님).
  return {
    commit: {
      kind: "reschedule",
      targetSignalId: activeDrag.signalId,
      at,
      durationMin: activeDrag.durationMin,
      fromDate: localDateOf(activeDrag.startISO),
    },
  };
}

/** commit 분기 — useTimelineDnd onDragEnd의 dispatch 순서/조건을 동일하게 재현. */
function computeCommit(input: TimelineDragInput): {
  commit: TimelineCommit | null;
  routineLengthFixed?: boolean;
  routineBoundaryClamped?: boolean;
} {
  const { activeDrag, drop } = input;
  // off-grid 릴리스(useTimelineDnd: isOffGridCanvasRelease → return) — 커밋 안 함.
  if (isOffGridCanvasRelease(input)) return { commit: null };
  if (!activeDrag || !drop) return { commit: null };

  // ── 1: tray → canvas (schedule) ─────────────────────────────────
  if (activeDrag.from === "tray" && drop.to === "canvas") {
    const at = pixelToAt(input, drop.gridY ?? 0);
    const durationMin = activeDrag.durationMin ?? DEFAULT_SCHEDULE_MIN;
    return {
      commit: {
        kind: "schedule",
        targetSignalId: activeDrag.signalId,
        at,
        durationMin,
        // calendarId는 caller(picker/default lookup)가 해소 — planner는 고르지 않는다.
        title: activeDrag.title,
      },
    };
  }

  // ── 3: canvas-resize → canvas (resize) ──────────────────────────
  if (activeDrag.from === "canvas-resize" && drop.to === "canvas") {
    return planResize(input);
  }

  // ── 2: canvas → canvas (reschedule) ─────────────────────────────
  if (activeDrag.from === "canvas" && drop.to === "canvas") {
    return planReschedule(input);
  }

  // ── 4: canvas → tray (unschedule) ───────────────────────────────
  if (activeDrag.from === "canvas" && activeDrag.blockKind === "signal" && drop.to === "tray") {
    return {
      commit: {
        kind: "unschedule",
        targetSignalId: activeDrag.signalId,
        fromDate: localDateOf(activeDrag.startISO),
      },
    };
  }

  // ── 5: canvas → 다른 캘린더 zone (moveCalendar) ─────────────────
  if (
    activeDrag.from === "canvas" &&
    activeDrag.blockKind === "signal" &&
    drop.to === "canvas:cal"
  ) {
    // 동일 캘린더면 noop(useTimelineDnd: o.calendarId === a.calendarId → return).
    if (drop.calendarId == null || drop.calendarId === activeDrag.calendarId)
      return { commit: null };
    const snapOpts = {
      snapMin: input.snapMin,
      magnetEdges: magnetEdgesFromBoxes(input.boxes, input.anchorDate, activeDrag.blockId),
    };
    const at = shiftIsoByPx(
      input.anchorDate,
      input.days,
      activeDrag.startISO,
      input.delta.y,
      snapOpts,
    );
    return {
      commit: {
        kind: "moveCalendar",
        targetSignalId: activeDrag.signalId,
        calendarId: drop.calendarId,
        at,
        durationMin: activeDrag.durationMin,
        title: activeDrag.title,
      },
    };
  }

  // ── 7: routine → canvas (routineSchedule) ───────────────────────
  if (activeDrag.from === "routine" && drop.to === "canvas") {
    const at = pixelToAt(input, drop.gridY ?? 0);
    return {
      commit: {
        kind: "routineSchedule",
        routineId: activeDrag.routineId,
        date: localDateOf(at),
        at,
        durationMin: ROUTINE_SCHEDULE_MIN,
        title: activeDrag.title,
      },
    };
  }

  return { commit: null };
}

/** gridY(px) → 로컬 ISO at. useTimelineDnd schedule/routineSchedule의 pixelToLocalIso와 동일.
 *  와이어링 시 caller가 resolveCanvasGridY로 보정한 gridY를 drop.gridY로 넘긴다(여기선 그대로 사용). */
function pixelToAt(input: TimelineDragInput, gridY: number): string {
  return pixelToLocalIso(input.anchorDate, input.days, gridY);
}

/**
 * Today 타임라인 드래그의 단일 순수 정본. preview(previewBoxes/guide)와 commit을 한 코드에서 산출한다.
 * 행동 변경 없음(hygiene): 출력은 현재 previewTimelineBoxes/dragGuideFromLayout/useTimelineDnd onDragEnd
 * 분기와 정확히 일치한다.
 */
export function planTimelineDrag(input: TimelineDragInput): TimelineDragPlan {
  const previewBoxes = computePreviewBoxes(input);
  const guide = computeGuide(input);
  const { commit, routineLengthFixed, routineBoundaryClamped } = computeCommit(input);
  return { previewBoxes, guide, commit, routineLengthFixed, routineBoundaryClamped };
}
