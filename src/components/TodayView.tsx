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
import { DominoPanel } from "@/components/today/DominoPanel";
import { DragGhost } from "@/components/today/DragGhost";
import { dragGhostReducer, INITIAL_DRAG_GHOST_STATE } from "@/components/today/dragGhostState";
import { EventPopover } from "@/components/today/EventPopover";
import { HistoryRail } from "@/components/today/HistoryRail";
import { StagedBadge } from "@/components/today/StagedBadge";
import { TimelineCanvas } from "@/components/today/TimelineCanvas";
import { TodayHeader } from "@/components/today/TodayHeader";
import { UnscheduledTray } from "@/components/today/UnscheduledTray";
import { useKeyboardDragAnnounce } from "@/components/today/useKeyboardDragAnnounce";
import {
  buildDefaultCalendarFor,
  DndContext,
  type DragData,
  useTimelineDnd,
  useTodayDndSensors,
} from "@/components/today/useTimelineDnd";
import { useTimelinePointerDelta } from "@/components/today/useTimelinePointerDelta";
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
  useSignalPlacements,
  useSignalTimeTotals,
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
  // 드래그 인플라이트 신호(ref) — useTimelineScroll의 lazy-extend를 동결(앵커 시프트 방지, 아래 effect로 동기화).
  const dragActiveRef = useRef(false);
  const { anchorDate, date, handleCanvasScroll, handleDateChange, visibleDates, wrapRef } =
    useTimelineScroll({ today, gridElRef, dragActiveRef });

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

  const totalsQ = useSignalTimeTotals();
  const totalsBySignal = new Map(
    (totalsQ.data ?? []).map((t) => [t.signalId, { totalMin: t.totalMin, dayCount: t.dayCount }]),
  );

  const projects = projectsQ.data ?? [];
  const noCalendarsConfigured =
    !projectsQ.isLoading &&
    projects.length > 0 &&
    projects.every((p) => {
      const ids = p.googleCalendarIds?.trim();
      return !ids || ids === "[]";
    });

  const placementsQ = useSignalPlacements(
    visibleDates[0] ?? today,
    visibleDates[visibleDates.length - 1] ?? today,
  );
  const placements = placementsQ.data ?? [];

  // 트레이/AllDay 스트립은 선택 날짜(date) 스코프 유지 — 캐시 버킷은 타임라인과 공유.
  const allDay = (eventsQ.byDate[date] ?? []).filter((e) => e.allDay);
  const rail = todayRail.data ?? [];
  // carry-over: 미완료 카드가 "보는 날짜"에 배치가 없으면 트레이 — 과거 배치 기록은 보존된다.
  const placedOnDate = new Set<string>();
  for (const placement of placements) {
    if (placement.date === date) placedOnDate.add(placement.signalId);
  }
  const unscheduledTodays = rail.filter((s) => !placedOnDate.has(s.id));
  const routineList = routinesQ.byDate[date] ?? [];
  const unscheduledRoutines = routineList.filter((r) => !r.timeOverride && !r.timeOfDay);

  const blocks = buildTimelineBlocks({
    signals: rail,
    placements,
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

  // Calendar picker promise bridge — anchored at the last known pointer.
  const [picker, setPicker] = useState<{
    targetId: string;
    targetKind: "signal" | "routine";
    anchor: { x: number; y: number };
    resolve: (calendarId: string | null) => void;
  } | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 200, y: 200 });
  // Operation delta = dnd-kit ev.delta (authoritative, fixes freeze). Raw pointer kept only
  // for crosshair cursor (pointerGrid) and off-grid release classification.
  const {
    captureDragStart,
    clearDragDelta,
    dragDeltaRef,
    dragRawPointerRef,
    prepareDragEndDelta,
    updateDragMoveDelta,
  } = useTimelinePointerDelta({
    gridElRef,
    lastPointerRef,
    visibleDays: visibleDates.length,
  });
  // Alt/Option fine-snap(5분) — 드래그 시작 activator + 드래그 중 keydown/keyup으로 라이브 추적.
  // ref는 onDragEnd(커밋)가, state는 preview 리렌더(미리보기 스냅)가 읽는다 — 같은 소스라 preview==commit.
  const fineSnapRef = useRef(false);
  const [fineSnap, setFineSnap] = useState(false);
  const setFine = (v: boolean) => {
    fineSnapRef.current = v;
    setFineSnap((prev) => (prev === v ? prev : v));
  };
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
    boxes,
    fineSnapRef,
    dragDeltaRef,
  });
  // Notion-스타일 ghost: 드래그 중 active item 미리보기를 cursor 따라 렌더.
  // dnd-kit 기본은 원본만 흐려지고 ghost가 없어 "옮기는 느낌"이 약함.
  const [{ activeDrag, activeDelta, isOverTray, pointerGrid }, dispatchDragGhost] = useReducer(
    dragGhostReducer,
    INITIAL_DRAG_GHOST_STATE,
  );
  // reducer state(정본)를 ref로 미러 — lazy-extend 동결 게이트가 콜백 재생성 없이 읽는다.
  useEffect(() => {
    dragActiveRef.current = activeDrag != null;
  }, [activeDrag]);
  const {
    announce,
    announceKeyboardMove,
    clear: clearAnnounce,
  } = useKeyboardDragAnnounce({ boxes, anchorDate, days: visibleDates.length });
  const activeDragStartRef = useRef<DragData | null>(null);
  const handleDragStart = (ev: {
    active: { id: string | number; data: { current?: unknown } };
    activatorEvent?: Event;
  }) => {
    const data = (ev.active.data.current as DragData | undefined) ?? null;
    captureDragStart(ev.activatorEvent);
    activeDragStartRef.current = data;
    setFine(Boolean((ev.activatorEvent as { altKey?: boolean } | undefined)?.altKey));
    dispatchDragGhost({ type: "start", data });
  };
  const handleDragMove = (ev: DragMoveEvent) => {
    const { delta, pointerGrid } = updateDragMoveDelta(ev.delta);
    dispatchDragGhost({ type: "move", delta, pointerGrid });
    // 키보드 드래그만 라이브 리전으로 새 시각을 알린다(포인터 드래그는 pill이 시각 피드백).
    announceKeyboardMove(ev, activeDragStartRef.current);
  };
  const handleDragOver = (ev: DragOverEvent) => {
    dispatchDragGhost({ type: "over", isOverTray: ev.over?.id === "today-tray" });
  };
  const handleDragEndWithReset = async (ev: Parameters<typeof onDragEnd>[0]) => {
    const activeAtStart = activeDragStartRef.current;
    prepareDragEndDelta(ev.delta);
    dispatchDragGhost({ type: "reset" });
    activeDragStartRef.current = null;
    // ⚠ fineSnap 리셋은 commit(onDragEnd) 이후에 — onDragEnd가 fineSnapRef.current를 동기적으로 읽어
    // snapMin(Alt=5분)을 정한다. 먼저 false로 리셋하면 Alt fine-snap이 커밋에서 죽어 preview(5분)와
    // commit(15분)이 어긋난다(preview==commit 불변 위반). 순서를 바꾸지 말 것.
    await onDragEnd(ev, activeAtStart);
    clearDragDelta();
    setFine(false);
    clearAnnounce();
  };
  const handleDragCancel = () => {
    activeDragStartRef.current = null;
    clearDragDelta();
    dispatchDragGhost({ type: "reset" });
    setFine(false);
    clearAnnounce();
  };

  // DragOverlay can intercept .today pointermove, so drag-time raw pointer is captured on window.
  useEffect(() => {
    if (!activeDrag) return;
    const onMove = (e: PointerEvent) => {
      if (!e.isPrimary) return;
      const p = { x: e.clientX, y: e.clientY };
      dragRawPointerRef.current = p;
      lastPointerRef.current = p;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    const onKey = (e: KeyboardEvent) => setFine(e.altKey);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [activeDrag, dragRawPointerRef]);

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
        <output className="sr-only" aria-live="polite">
          {announce}
        </output>
        <TodayHeader
          date={date}
          today={today}
          debt={overview.data?.workDebt ?? {}}
          onDateChange={handleDateChange}
        />
        <div className="today-staged-slot">
          <StagedBadge />
        </div>
        <DominoPanel date={date} />
        <div className="today-main">
          <UnscheduledTray
            unscheduledTodays={unscheduledTodays}
            unscheduledRoutines={unscheduledRoutines}
            allDayEvents={allDay}
            onToggleDone={(id, done) => toggleDone.mutate({ id, date, done })}
            onToggleRoutine={(routineId, done) => toggleRoutine.mutate({ routineId, date, done })}
            totals={totalsBySignal}
            today={today}
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
                dragPointerGrid={pointerGrid}
                fineSnap={fineSnap}
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
