import "./TodayView.css";

import type { DragMoveEvent, DragOverEvent } from "@dnd-kit/core";
import { DragOverlay } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { type CalendarEvent, commands } from "@/bindings";
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
import { Button } from "@/components/ui/button";
import { stage } from "@/lib/calendarSync";
import { useCalendarSyncEvents } from "@/lib/calendarSyncEvents";
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
import { unwrap } from "@/lib/query/client";
import { computeLayout, type LayoutBox } from "@/lib/timelineLayout";
import { useToastStore } from "@/lib/toast";
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
  const qc = useQueryClient();
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

  const allEvents = useMemo(() => events.data ?? [], [events.data]);
  const allDay = allEvents.filter((e) => e.allDay);
  const rail = useMemo(() => todayRail.data ?? [], [todayRail.data]);
  const unscheduledTodays = rail.filter((s) => !s.scheduledAt);
  const routineList = useMemo(() => routines.data ?? [], [routines.data]);
  const unscheduledRoutines = routineList.filter((r) => !r.timeOverride && !r.timeOfDay);

  const blocks = useMemo(
    () => buildTodayBlocks({ signals: rail, events: allEvents, routines: routineList, date }),
    [rail, allEvents, routineList, date],
  );
  const boxes = useMemo(() => computeLayout(blocks), [blocks]);

  const [popover, setPopover] = useState<{
    box: LayoutBox;
    anchor: { x: number; y: number };
  } | null>(null);

  const handleBlockClick = useCallback((box: LayoutBox, e: ReactMouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // 블록 상단 중앙을 anchor로 → popover는 side="top" align="center"로 블록 위에 띄움.
    setPopover({ box, anchor: { x: rect.left + rect.width / 2, y: rect.top } });
  }, []);
  /** 타임라인 ✓ 토글 — block.kind에 따라 signal/routine mutation 분기(event는 done 개념 없음 → 무시). */
  const handleBlockToggleDone = useCallback(
    (box: LayoutBox, done: boolean) => {
      const { block } = box;
      if (block.kind === "signal") {
        const id = block.id.replace(/^signal:/, "");
        toggleDone.mutate({ id, date: today, done });
      } else if (block.kind === "routine" && block.routineId) {
        toggleRoutine.mutate({ routineId: block.routineId, date: today, done });
      }
    },
    [today, toggleDone, toggleRoutine],
  );
  const handlePopoverClose = useCallback(() => setPopover(null), []);
  const removeEventFromCache = useCallback(
    (calendarId: string, eventId: string) => {
      qc.setQueryData<CalendarEvent[]>(["calendarEvents", date], (old) =>
        old?.filter((event) => !(event.calendarId === calendarId && event.id === eventId)),
      );
    },
    [date, qc],
  );
  const handleDeleteSchedule = useCallback(
    (box: LayoutBox) => {
      const { block } = box;
      const title = block.title;
      const linkedEventId = block.linkedEventId;
      const calendarId = block.calendarId;
      const run = async () => {
        // 모든 kind에서 unschedule 가능 — signal/routine은 linkedEventId 없어도 stage(unschedule)
        // 자체는 동작(타임라인에서만 빼고 카드는 Today 잔류). Google 캐시 제거는 linkedEventId 있을 때만.
        if (block.kind === "signal") {
          const signalId = block.id.replace(/^signal:/, "");
          await stage({ kind: "unschedule", targetSignalId: signalId });
          if (linkedEventId && calendarId) removeEventFromCache(calendarId, linkedEventId);
          void qc.invalidateQueries({ queryKey: ["signals"] });
          void qc.invalidateQueries({ queryKey: ["today"] });
        } else if (block.kind === "event") {
          const eventId = block.linkedEventId ?? block.id.replace(/^event:/, "");
          await stage({ kind: "eventUnschedule", eventId, calendarId });
          removeEventFromCache(calendarId, eventId);
        } else if (block.kind === "routine" && block.routineId) {
          const routineId = block.routineId;
          // 루틴 목록/블록은 today-bound(useTodayRoutines(today, …))라 "오늘 빼기"는 항상 today를
          // 대상으로 한다 — 날짜 네비게이션 중에도 navigated date가 아닌 today에 EXDATE를 쓴다
          // (done-토글과 동일). date를 쓰면 동기화 루틴의 엉뚱한 미래 occurrence가 조용히 지워진다.
          // "오늘 빼기" = EXDATE: 로컬 skip 행 + 동기화 ON이면 master event EXDATE PATCH.
          await unwrap(commands.unscheduleRoutineToday(routineId, today));
          // per-instance Google 이벤트가 있으면(드물게 드래그로 배치됐던 경우) 함께 정리.
          if (linkedEventId && calendarId) {
            await stage({ kind: "routineUnschedule", routineId, date: today });
            removeEventFromCache(calendarId, linkedEventId);
            void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
          }
          void qc.invalidateQueries({ queryKey: ["routines"] });
          // 되돌리기 토스트(useTimelineDnd 언스케줄 패턴과 동일 — 자동 dismiss 안에 누르면 복구).
          useToastStore.getState().pushInfo(`오늘 타임라인에서 뺐어요: ${title}`, {
            undoLabel: "되돌리기",
            onUndo: () => {
              void unwrap(commands.restoreRoutineToday(routineId, today))
                .then(() => qc.invalidateQueries({ queryKey: ["routines"] }))
                .catch((err) => useToastStore.getState().pushError("routine.restore", err));
            },
          });
          return;
        }
        void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
        useToastStore.getState().pushSuccess(`일정 삭제됨: ${title}`);
      };
      void run().catch((err) => {
        void qc.invalidateQueries({ queryKey: ["signals"] });
        void qc.invalidateQueries({ queryKey: ["today"] });
        void qc.invalidateQueries({ queryKey: ["routines"] });
        void qc.invalidateQueries({ queryKey: ["calendarEvents", date] });
        useToastStore.getState().pushError("calendar.delete", err);
      });
    },
    [date, today, qc, removeEventFromCache],
  );

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
    targetId: string;
    targetKind: "signal" | "routine";
    anchor: { x: number; y: number };
    resolve: (calendarId: string | null) => void;
  } | null>(null);
  const lastPointerRef = useRef<{ x: number; y: number }>({ x: 200, y: 200 });
  // 활성 picker resolver — unmount 시 promise leak 방지용(아래 cleanup effect에서 resolve(null)).
  const pickerResolverRef = useRef<((v: string | null) => void) | null>(null);
  // TimelineCanvas pointer Y — useTimelineDnd가 onDragEnd에서 읽는다.
  const canvasPointerYRef = useRef<number | null>(null);
  const canvasPointerXRef = useRef<number | null>(null);

  const promptCalendarPicker = useCallback(
    (targetId: string, targetKind: "signal" | "routine" = "signal") =>
      new Promise<string | null>((resolve) => {
        pickerResolverRef.current = resolve;
        setPicker({ targetId, targetKind, anchor: { ...lastPointerRef.current }, resolve });
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
  const [activeDelta, setActiveDelta] = useState<DragDelta | null>(null);
  const [isOverTray, setIsOverTray] = useState(false);
  const activeDragStartRef = useRef<DragData | null>(null);
  const handleDragStart = useCallback(
    (ev: { active: { id: string | number; data: { current?: unknown } } }) => {
      const data = (ev.active.data.current as DragData | undefined) ?? null;
      activeDragStartRef.current = data;
      setActiveDrag(data);
      setActiveDelta({ x: 0, y: 0 });
      setIsOverTray(false);
    },
    [],
  );
  const handleDragMove = useCallback((ev: DragMoveEvent) => {
    setActiveDelta(ev.delta);
  }, []);
  const handleDragOver = useCallback((ev: DragOverEvent) => {
    setIsOverTray(ev.over?.id === "today-tray");
  }, []);
  const handleDragEndWithReset = useCallback(
    async (ev: Parameters<typeof onDragEnd>[0]) => {
      const activeAtStart = activeDragStartRef.current;
      setActiveDrag(null);
      setActiveDelta(null);
      setIsOverTray(false);
      activeDragStartRef.current = null;
      await onDragEnd(ev, activeAtStart);
    },
    [onDragEnd],
  );
  const handleDragCancel = useCallback(() => {
    activeDragStartRef.current = null;
    setActiveDrag(null);
    setActiveDelta(null);
    setIsOverTray(false);
  }, []);

  const pickerSignalProjectId = useMemo(() => {
    if (!picker) return null;
    if (picker.targetKind !== "signal") return null;
    return rail.find((s) => s.id === picker.targetId)?.projectId ?? null;
  }, [picker, rail]);
  const pickerRoutineKind = useMemo(() => {
    if (!picker || picker.targetKind !== "routine") return null;
    return routineList.find((r) => r.id === picker.targetId)?.kind ?? null;
  }, [picker, routineList]);

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
                onToggleDone={handleBlockToggleDone}
                pointerYRef={canvasPointerYRef}
                pointerXRef={canvasPointerXRef}
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
          date={date}
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
