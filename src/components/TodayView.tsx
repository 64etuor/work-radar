import "./TodayView.css";

import type { DragMoveEvent, DragOverEvent } from "@dnd-kit/core";
import { DragOverlay } from "@dnd-kit/core";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";

import { CalendarPickerPopover } from "@/components/today/CalendarPickerPopover";
import { EventPopover } from "@/components/today/EventPopover";
import { HistoryRail } from "@/components/today/HistoryRail";
import { StagedBadge } from "@/components/today/StagedBadge";
import { TimelineCanvas } from "@/components/today/TimelineCanvas";
import type { DragDelta } from "@/components/today/timelinePreview";
import { TodayHeader } from "@/components/today/TodayHeader";
import { UnscheduledTray } from "@/components/today/UnscheduledTray";
import {
  buildDefaultCalendarFor,
  DndContext,
  type DragData,
  useTimelineDnd,
  useTodayDndSensors,
} from "@/components/today/useTimelineDnd";
import {
  timelineBlockDate,
  useTimelineScheduleActions,
} from "@/components/today/useTimelineScheduleActions";
import { useTimelineScroll } from "@/components/today/useTimelineScroll";
import { Button } from "@/components/ui/button";
import { useCalendarSyncEvents } from "@/lib/calendarSyncEvents";
import {
  localToday,
  useCalendarEventsForDates,
  useProjects,
  useTimelineNotesForDates,
  useToday,
  useTodayOverview,
  useTodayRoutinesForDates,
  useToggleRoutineCheck,
  useToggleTodayDone,
} from "@/lib/query";
import { computeLayout, type LayoutBox } from "@/lib/timelineLayout";
import { blockNoteTarget, buildTimelineBlocks, noteTargetMapKey } from "@/lib/todayBlocks";
import { useUIStore } from "@/store";

type DragGhostState = {
  activeDrag: DragData | null;
  activeDelta: DragDelta | null;
  isOverTray: boolean;
};

type DragGhostAction =
  | { type: "start"; data: DragData | null }
  | { type: "move"; delta: DragDelta }
  | { type: "over"; isOverTray: boolean }
  | { type: "reset" };

const INITIAL_DRAG_GHOST_STATE: DragGhostState = {
  activeDrag: null,
  activeDelta: null,
  isOverTray: false,
};

function dragGhostReducer(state: DragGhostState, action: DragGhostAction): DragGhostState {
  switch (action.type) {
    case "start":
      return { activeDrag: action.data, activeDelta: { x: 0, y: 0 }, isOverTray: false };
    case "move":
      return { ...state, activeDelta: action.delta };
    case "over":
      return { ...state, isOverTray: action.isOverTray };
    case "reset":
      return INITIAL_DRAG_GHOST_STATE;
  }
}

/**
 * Today — 하루 운영 콕핏(스펙 §3 통합 뷰).
 *   좌 미배치 트레이 + 우 24h 캔버스 + 헤더(날짜 네비 + Work Debt 4칩 + Staged 배지).
 * PR 5: DnD wiring — tray↔canvas schedule/reschedule/unschedule + cross-cal staged
 * (resize/createBlank은 후속 정련). 데이터: 레일·루틴·캘린더 일정 모두 선택 날짜(date)로
 * 재조회 — 날짜 네비게이션 시 그 날의 일정만 본다(오버뷰/Work Debt만 today 고정).
 */
export function TodayView() {
  const { goTo } = useUIStore();
  const today = localToday();
  // 캔버스 그리드 DOM — useTimelineDnd가 onDragEnd에서 fresh rect를 읽어 드롭 좌표를 환산한다.
  const gridElRef = useRef<HTMLDivElement | null>(null);
  const { anchorDate, date, handleCanvasScroll, handleDateChange, visibleDates, wrapRef } =
    useTimelineScroll({ today, gridElRef });

  // sync 실패 이벤트 → 토스트 + 캐시 invalidate(rollback).
  useCalendarSyncEvents();

  const overview = useTodayOverview(today);
  // 타임라인 데이터는 로드된 모든 날짜 — per-day 버킷(useQueries) 병합(스펙 §3).
  const eventsQ = useCalendarEventsForDates(visibleDates);
  const routinesQ = useTodayRoutinesForDates(visibleDates);
  // 레일은 선택 날짜로 조회 — 옵티미스틱 패치 키(["today", date])와도 일치.
  const todayRail = useToday(date);
  const projectsQ = useProjects();
  const toggleDone = useToggleTodayDone();
  const toggleRoutine = useToggleRoutineCheck();
  const { handleDeleteSchedule } = useTimelineScheduleActions();

  const projects = projectsQ.data ?? [];
  const noCalendarsConfigured =
    !projectsQ.isLoading &&
    projects.length > 0 &&
    projects.every((p) => {
      const ids = p.googleCalendarIds?.trim();
      return !ids || ids === "[]";
    });

  // 트레이/AllDay 스트립은 선택 날짜(date) 스코프 유지 — 캐시 버킷은 타임라인과 공유.
  const allDay = (eventsQ.byDate[date] ?? []).filter((e) => e.allDay);
  const rail = todayRail.data ?? [];
  const unscheduledTodays = rail.filter((s) => !s.scheduledAt);
  const routineList = routinesQ.byDate[date] ?? [];
  const unscheduledRoutines = routineList.filter((r) => !r.timeOverride && !r.timeOfDay);

  const blocks = buildTimelineBlocks({
    signals: rail,
    placements: [], // Task 8에서 실제 쿼리 연결
    eventsByDate: eventsQ.byDate,
    routinesByDate: routinesQ.byDate,
    dates: visibleDates,
  });
  const boxes = computeLayout(blocks, anchorDate);

  // 블록 위 메모 표시 — 날짜별 메모 1회 조회(N+1 회피) 후 blockId → body 맵으로 환원.
  // EventPopover와 동일한 blockNoteTarget 키를 써서 표시/편집이 항상 같은 메모를 가리킨다.
  const notesQ = useTimelineNotesForDates(visibleDates);
  // 멀티데이 병합이라 (target, 날짜)까지 키에 포함 — 같은 루틴의 인접 날짜 메모 충돌 방지.
  const byTarget = new Map<string, string>();
  for (const n of notesQ.all) {
    if (n.body.trim())
      byTarget.set(`${noteTargetMapKey(n.targetKind, n.targetId)}\u0000${n.date}`, n.body);
  }
  const memoByBlockId = new Map<string, string>();
  for (const box of boxes) {
    const t = blockNoteTarget(box.block);
    if (!t) continue;
    const body = byTarget.get(
      `${noteTargetMapKey(t.targetKind, t.targetId)}\u0000${timelineBlockDate(box.block)}`,
    );
    if (body) memoByBlockId.set(box.block.id, body);
  }

  const [popover, setPopover] = useState<{
    box: LayoutBox;
    anchor: { x: number; y: number };
  } | null>(null);

  const handleBlockClick = (box: LayoutBox, e: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // 블록 상단 중앙을 anchor로 → popover는 side="top" align="center"로 블록 위에 띄움.
    setPopover({ box, anchor: { x: rect.left + rect.width / 2, y: rect.top } });
  };
  /** 타임라인 ✓ 토글 — signal 또는 routine-linked calendar event는 로컬 DB 완료 상태만 바꾼다. */
  const handleBlockToggleDone = (box: LayoutBox, done: boolean) => {
    const { block } = box;
    // 블록이 놓인 날짜(occurrence) 기준으로 완료 기록 — 연속 타임라인에서 표시된 블록과 일관.
    if (block.kind === "signal") {
      const id = block.signalId ?? block.id.replace(/^signal:/, "");
      toggleDone.mutate({ id, date: timelineBlockDate(block), done });
    } else if (block.routineId) {
      toggleRoutine.mutate({ routineId: block.routineId, date: timelineBlockDate(block), done });
    }
  };
  const handlePopoverClose = () => setPopover(null);

  // ── DnD wiring ──────────────────────────────────────────────────────
  const defaultCalendarFor = buildDefaultCalendarFor(rail, projectsQ.data ?? []);

  /**
   * Picker state — useTimelineDnd가 `promptCalendarPicker(signalId)`를 호출하면
   * 여기서 popover를 띄우고 사용자가 고른 calendarId로 resolve. cancel 시 null resolve.
   * pointer 좌표는 마지막 pointermove 위치(없으면 화면 안쪽 기본값)로 anchor.
   */
  const [picker, setPicker] = useState<{
    targetId: string;
    targetKind: "signal" | "routine";
    anchor: { x: number; y: number };
    resolve: (calendarId: string | null) => void;
  } | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 200, y: 200 });
  // 활성 picker resolver — unmount 시 promise leak 방지용(아래 cleanup effect에서 resolve(null)).
  const pickerResolverRef = useRef<((v: string | null) => void) | null>(null);
  // TimelineCanvas 라이브 hover preview용 grid-local 좌표(드래그 중 가이드/프리뷰 렌더).
  const canvasPointerYRef = useRef<number | null>(null);
  const canvasPointerXRef = useRef<number | null>(null);

  const promptCalendarPicker = (targetId: string, targetKind: "signal" | "routine" = "signal") =>
    new Promise<string | null>((resolve) => {
      pickerResolverRef.current = resolve;
      setPicker({ targetId, targetKind, anchor: { ...lastPointerRef.current }, resolve });
    });

  // Unmount cleanup — 미해결 picker promise가 있으면 null로 resolve하고 ref 정리.
  useEffect(
    () => () => {
      pickerResolverRef.current?.(null);
      pickerResolverRef.current = null;
    },
    [],
  );

  // 트레이/캔버스 어디서든 pointer move를 트래킹 → picker anchor에 재사용.
  const trackPointer = (e: ReactPointerEvent<HTMLDivElement>) => {
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
  };

  const sensors = useTodayDndSensors();
  const { onDragEnd } = useTimelineDnd({
    date,
    anchorDate,
    days: visibleDates.length,
    defaultCalendarFor,
    promptCalendarPicker,
    gridElRef,
    pointerClientRef: lastPointerRef,
  });

  // Notion-스타일 ghost: 드래그 중 active item 미리보기를 cursor 따라 렌더.
  // dnd-kit 기본은 원본만 흐려지고 ghost가 없어 "옮기는 느낌"이 약함.
  const [{ activeDrag, activeDelta, isOverTray }, dispatchDragGhost] = useReducer(
    dragGhostReducer,
    INITIAL_DRAG_GHOST_STATE,
  );
  const activeDragStartRef = useRef<DragData | null>(null);
  const handleDragStart = (ev: {
    active: { id: string | number; data: { current?: unknown } };
  }) => {
    const data = (ev.active.data.current as DragData | undefined) ?? null;
    activeDragStartRef.current = data;
    dispatchDragGhost({ type: "start", data });
  };
  const handleDragMove = (ev: DragMoveEvent) => {
    dispatchDragGhost({ type: "move", delta: ev.delta });
  };
  const handleDragOver = (ev: DragOverEvent) => {
    dispatchDragGhost({ type: "over", isOverTray: ev.over?.id === "today-tray" });
  };
  const handleDragEndWithReset = async (ev: Parameters<typeof onDragEnd>[0]) => {
    const activeAtStart = activeDragStartRef.current;
    dispatchDragGhost({ type: "reset" });
    activeDragStartRef.current = null;
    await onDragEnd(ev, activeAtStart);
  };
  const handleDragCancel = () => {
    activeDragStartRef.current = null;
    dispatchDragGhost({ type: "reset" });
  };

  const pickerSignalProjectId =
    picker && picker.targetKind === "signal"
      ? (rail.find((s) => s.id === picker.targetId)?.projectId ?? null)
      : null;
  const pickerRoutineKind =
    picker && picker.targetKind === "routine"
      ? (routineList.find((r) => r.id === picker.targetId)?.kind ?? null)
      : null;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEndWithReset}
      onDragCancel={handleDragCancel}
    >
      <div className="today" onPointerMove={trackPointer}>
        <TodayHeader
          date={date}
          today={today}
          debt={overview.data?.workDebt ?? {}}
          onDateChange={handleDateChange}
        />
        <div className="today-staged-slot">
          <StagedBadge />
        </div>
        <div className="today-main">
          <UnscheduledTray
            unscheduledTodays={unscheduledTodays}
            unscheduledRoutines={unscheduledRoutines}
            allDayEvents={allDay}
            onToggleDone={(id, done) => toggleDone.mutate({ id, date, done })}
            onToggleRoutine={(routineId, done) => toggleRoutine.mutate({ routineId, date, done })}
          />
          <div className="today-canvas-wrap" ref={wrapRef} onScroll={handleCanvasScroll}>
            {noCalendarsConfigured ? (
              <div className="today-canvas-cta">
                <p>Google 계정이 연결되지 않았습니다.</p>
                <Button onClick={() => goTo("settings")}>Google 계정 연결</Button>
              </div>
            ) : (
              <TimelineCanvas
                dates={visibleDates}
                today={today}
                boxes={boxes}
                memoByBlockId={memoByBlockId}
                onBlockClick={handleBlockClick}
                onToggleDone={handleBlockToggleDone}
                pointerYRef={canvasPointerYRef}
                pointerXRef={canvasPointerXRef}
                gridElRef={gridElRef}
                activeDrag={activeDrag}
                activeDelta={activeDelta}
              />
            )}
          </div>
          <HistoryRail today={today} />
        </div>
        <EventPopover
          open={popover !== null}
          box={popover?.box ?? null}
          date={popover ? timelineBlockDate(popover.box.block) : date}
          anchor={popover?.anchor ?? null}
          onClose={handlePopoverClose}
          onDeleteSchedule={handleDeleteSchedule}
          onToggleDone={handleBlockToggleDone}
        />
        {picker && (
          <CalendarPickerPopover
            open
            anchor={picker.anchor}
            signalProjectId={pickerSignalProjectId}
            routineKind={pickerRoutineKind}
            onPick={(calendarId) => {
              picker.resolve(calendarId);
              pickerResolverRef.current = null;
              setPicker(null);
            }}
            onClose={() => {
              picker.resolve(null);
              pickerResolverRef.current = null;
              setPicker(null);
            }}
          />
        )}
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDrag ? <DragGhost data={activeDrag} isOverTray={isOverTray} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * 드래그 중 cursor를 따라다니는 ghost. dnd-kit `DragOverlay`는 Portal 렌더,
 * pointer 이벤트 무시 — Notion/Linear 류 "옮기는 느낌" 제공.
 * 캔버스 블록을 트레이 위로 끌면 인박스 카드 형태로 ghost를 전환해 unschedule 의도를 시각화.
 */
function DragGhost({ data, isOverTray }: { data: DragData; isOverTray: boolean }) {
  const isResize = data.from === "canvas-resize";
  if (isResize) {
    return <div className="today-drag-ghost today-drag-ghost-resize" />;
  }
  if (data.from === "canvas") {
    if (!isOverTray) return null;
    // 캔버스→트레이 드래그: 인박스 카드 비주얼로 전환(unschedule 미리보기).
    return (
      <div className="today-drag-ghost today-drag-ghost--card">
        <div className="today-drag-ghost-card-title">{data.title}</div>
      </div>
    );
  }
  // 여기까지 오면 from은 tray | routine (canvas, canvas-resize는 위에서 처리됨).
  return (
    <div className="today-drag-ghost">
      <span className="today-drag-ghost-grip" aria-hidden>
        ⠿
      </span>
      <span className="today-drag-ghost-title">{data.title}</span>
    </div>
  );
}
