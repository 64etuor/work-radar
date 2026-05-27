import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import "./TodayView.css";

import { CalendarPickerPopover } from "@/components/today/CalendarPickerPopover";
import { EventPopover } from "@/components/today/EventPopover";
import { StagedBadge } from "@/components/today/StagedBadge";
import { TimelineCanvas } from "@/components/today/TimelineCanvas";
import { TodayHeader } from "@/components/today/TodayHeader";
import { UnscheduledTray } from "@/components/today/UnscheduledTray";
import { DragOverlay } from "@dnd-kit/core";
import {
  DndContext,
  buildDefaultCalendarFor,
  useTimelineDnd,
  useTodayDndSensors,
  type DragData,
} from "@/components/today/useTimelineDnd";
import { useCalendarSyncEvents } from "@/lib/calendarSyncEvents";
import { Button } from "@/components/ui/button";
import {
  localToday,
  localWeekday,
  useCalendarEvents,
  useProjects,
  useToday,
  useTodayOverview,
  useTodayRoutines,
  useToggleRoutineCheck,
  useToggleTodayDone,
} from "@/lib/query";
import { computeLayout, type LayoutBox } from "@/lib/timelineLayout";
import { buildTodayBlocks } from "@/lib/todayBlocks";
import { useUIStore } from "@/store";

/**
 * Today — 하루 운영 콕핏(스펙 §3 통합 뷰).
 *   좌 미배치 트레이 + 우 24h 캔버스 + 헤더(날짜 네비 + Work Debt 4칩 + Staged 배지).
 * PR 5: DnD wiring — tray↔canvas schedule/reschedule/unschedule + cross-cal staged
 * (resize/createBlank은 후속 정련). 데이터: today-bound(오버뷰/레일/루틴은 today 고정),
 * 캘린더 일정만 선택 날짜 재조회.
 */
export function TodayView() {
  const { goTo } = useUIStore();
  const today = localToday();
  const weekday = localWeekday();
  const [date, setDate] = useState<string>(today);

  // sync 실패 이벤트 → 토스트 + 캐시 invalidate(rollback).
  useCalendarSyncEvents();

  const overview = useTodayOverview(today);
  const events = useCalendarEvents(date);
  const todayRail = useToday(today);
  const routines = useTodayRoutines(today, weekday);
  const projectsQ = useProjects();
  const toggleDone = useToggleTodayDone();
  const toggleRoutine = useToggleRoutineCheck();

  const noCalendarsConfigured = useMemo(() => {
    const projects = projectsQ.data ?? [];
    if (projectsQ.isLoading || projects.length === 0) return false;
    return projects.every((p) => {
      const ids = p.googleCalendarIds?.trim();
      return !ids || ids === "[]";
    });
  }, [projectsQ.data, projectsQ.isLoading]);

  const allEvents = events.data ?? [];
  const allDay = allEvents.filter((e) => e.allDay);
  const rail = todayRail.data ?? [];
  const unscheduledTodays = rail.filter((s) => !s.scheduledAt);
  const routineList = routines.data ?? [];
  const unscheduledRoutines = routineList.filter(
    (r) => !r.timeOverride && !r.timeOfDay,
  );

  const blocks = useMemo(
    () => buildTodayBlocks({ signals: rail, events: allEvents, routines: routineList, date }),
    [rail, allEvents, routineList, date],
  );
  const boxes = useMemo(() => computeLayout(blocks), [blocks]);

  const [popover, setPopover] = useState<{
    box: LayoutBox;
    anchor: { x: number; y: number };
  } | null>(null);

  const handleBlockClick = useCallback(
    (box: LayoutBox, e: ReactMouseEvent<HTMLButtonElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      setPopover({ box, anchor: { x: rect.right + 8, y: rect.top } });
    },
    [],
  );
  const handlePopoverClose = useCallback(() => setPopover(null), []);
  const handleOpenFullModal = useCallback(() => {
    setPopover(null);
  }, []);

  // ── DnD wiring ──────────────────────────────────────────────────────
  const defaultCalendarFor = useMemo(
    () => buildDefaultCalendarFor(rail, projectsQ.data ?? []),
    [rail, projectsQ.data],
  );

  /**
   * Picker state — useTimelineDnd가 `promptCalendarPicker(signalId)`를 호출하면
   * 여기서 popover를 띄우고 사용자가 고른 calendarId로 resolve. cancel 시 null resolve.
   * pointer 좌표는 마지막 pointermove 위치(없으면 화면 안쪽 기본값)로 anchor.
   */
  const [picker, setPicker] = useState<{
    signalId: string;
    anchor: { x: number; y: number };
    resolve: (calendarId: string | null) => void;
  } | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 200, y: 200 });
  // 활성 picker resolver — unmount 시 promise leak 방지용(아래 cleanup effect에서 resolve(null)).
  const pickerResolverRef = useRef<((v: string | null) => void) | null>(null);
  // TimelineCanvas pointer Y — useTimelineDnd가 onDragEnd에서 읽는다.
  const canvasPointerYRef = useRef<number | null>(null);

  const promptCalendarPicker = useCallback(
    (signalId: string) =>
      new Promise<string | null>((resolve) => {
        pickerResolverRef.current = resolve;
        setPicker({ signalId, anchor: { ...lastPointerRef.current }, resolve });
      }),
    [],
  );

  // Unmount cleanup — 미해결 picker promise가 있으면 null로 resolve하고 ref 정리.
  useEffect(
    () => () => {
      pickerResolverRef.current?.(null);
      pickerResolverRef.current = null;
    },
    [],
  );

  // 트레이/캔버스 어디서든 pointer move를 트래킹 → picker anchor에 재사용.
  const trackPointer = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    lastPointerRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const sensors = useTodayDndSensors();
  const { onDragEnd } = useTimelineDnd({
    date,
    defaultCalendarFor,
    promptCalendarPicker,
    canvasPointerYRef,
  });

  // Notion-스타일 ghost: 드래그 중 active item 미리보기를 cursor 따라 렌더.
  // dnd-kit 기본은 원본만 흐려지고 ghost가 없어 "옮기는 느낌"이 약함.
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  const handleDragStart = useCallback(
    (ev: { active: { id: string | number; data: { current?: unknown } } }) => {
      // 디버그: 캔버스 블록·resize 핸들 드래그가 시작 안 되는 증상 추적용.
      // eslint-disable-next-line no-console
      console.log("[today.dnd] onDragStart", ev.active.id, ev.active.data.current);
      setActiveDrag(ev.active.data.current as DragData | undefined ?? null);
    },
    [],
  );
  const handleDragEndWithReset = useCallback(
    async (ev: Parameters<typeof onDragEnd>[0]) => {
      // eslint-disable-next-line no-console
      console.log("[today.dnd] onDragEnd", {
        active: ev.active.id,
        over: ev.over?.id,
        activeData: ev.active.data.current,
        overData: ev.over?.data.current,
        delta: ev.delta,
      });
      setActiveDrag(null);
      await onDragEnd(ev);
    },
    [onDragEnd],
  );
  const handleDragCancel = useCallback(() => setActiveDrag(null), []);

  const pickerSignalProjectId = useMemo(() => {
    if (!picker) return null;
    return rail.find((s) => s.id === picker.signalId)?.projectId ?? null;
  }, [picker, rail]);

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEndWithReset}
      onDragCancel={handleDragCancel}
    >
      <div className="today" onPointerMove={trackPointer}>
        <TodayHeader
          date={date}
          today={today}
          debt={overview.data?.workDebt ?? {}}
          onDateChange={setDate}
        />
        <div className="today-staged-slot">
          <StagedBadge />
        </div>
        <div className="today-main">
          <UnscheduledTray
            unscheduledTodays={unscheduledTodays}
            unscheduledRoutines={unscheduledRoutines}
            allDayEvents={allDay}
            onToggleDone={(id, done) => toggleDone.mutate({ id, date: today, done })}
            onToggleRoutine={(routineId, done) =>
              toggleRoutine.mutate({ routineId, date: today, done })
            }
          />
          <div className="today-canvas-wrap">
            {noCalendarsConfigured ? (
              <div className="today-canvas-cta">
                <p>Google 계정이 연결되지 않았습니다.</p>
                <Button onClick={() => goTo("settings")}>Google 계정 연결</Button>
              </div>
            ) : (
              <TimelineCanvas
                date={date}
                today={today}
                boxes={boxes}
                onBlockClick={handleBlockClick}
                pointerYRef={canvasPointerYRef}
              />
            )}
          </div>
        </div>
        <EventPopover
          open={popover !== null}
          box={popover?.box ?? null}
          anchor={popover?.anchor ?? null}
          onClose={handlePopoverClose}
          onOpenFullModal={handleOpenFullModal}
          onToggleRoutineDone={(routineId, done) =>
            toggleRoutine.mutate({ routineId, date: today, done })
          }
        />
        {picker && (
          <CalendarPickerPopover
            open
            anchor={picker.anchor}
            signalProjectId={pickerSignalProjectId}
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
        {activeDrag ? <DragGhost data={activeDrag} /> : null}
      </DragOverlay>
    </DndContext>
  );
}

/**
 * 드래그 중 cursor를 따라다니는 ghost. dnd-kit `DragOverlay`는 Portal 렌더,
 * pointer 이벤트 무시 — Notion/Linear 류 "옮기는 느낌" 제공.
 */
function DragGhost({ data }: { data: DragData }) {
  const title =
    data.from === "tray" || data.from === "canvas" || data.from === "routine"
      ? data.title
      : "block";
  const isResize = data.from === "canvas-resize";
  if (isResize) {
    return <div className="today-drag-ghost today-drag-ghost-resize" />;
  }
  return (
    <div className="today-drag-ghost">
      <span className="today-drag-ghost-grip" aria-hidden>⠿</span>
      <span className="today-drag-ghost-title">{title}</span>
    </div>
  );
}
