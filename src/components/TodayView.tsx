import "./TodayView.css";

import type { DragMoveEvent, DragOverEvent } from "@dnd-kit/core";
import { DragOverlay } from "@dnd-kit/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
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
  useCalendarEventsForDates,
  useProjects,
  useTimelineNotesForDates,
  useToday,
  useTodayOverview,
  useTodayRoutinesForDates,
  useToggleRoutineCheck,
  useToggleTodayDone,
} from "@/lib/query";
import { unwrap } from "@/lib/query/client";
import { addDays, dayDiff, localDateOf } from "@/lib/timeAxis";
import { computeLayout, type LayoutBox, type TimedBlock } from "@/lib/timelineLayout";
import { extendDates, includeDate } from "@/lib/timelineWindow";
import { useToastStore } from "@/lib/toast";
import { blockNoteTarget, buildTimelineBlocks, noteTargetMapKey } from "@/lib/todayBlocks";
import { useUIStore } from "@/store";

/** 로드 일수 상한 — DOM/메모리 바운드(스펙 §3의 윈도잉 의도를 캡으로 충족). */
const MAX_LOADED_DAYS = 21;
/** 하루 높이(px) — 60px/h × 24h. */
const DAY_PX = 24 * 60;

/**
 * Today — 하루 운영 콕핏(스펙 §3 통합 뷰).
 *   좌 미배치 트레이 + 우 24h 캔버스 + 헤더(날짜 네비 + Work Debt 4칩 + Staged 배지).
 * PR 5: DnD wiring — tray↔canvas schedule/reschedule/unschedule + cross-cal staged
 * (resize/createBlank은 후속 정련). 데이터: 레일·루틴·캘린더 일정 모두 선택 날짜(date)로
 * 재조회 — 날짜 네비게이션 시 그 날의 일정만 본다(오버뷰/Work Debt만 today 고정).
 */
export function TodayView() {
  const { goTo } = useUIStore();
  const qc = useQueryClient();
  const today = localToday();
  // 레일/트레이/KPI 스코프 날짜(기존 의미 유지). 타임라인은 visibleDates 연속 축.
  const [date, setDate] = useState<string>(today);
  // 연속 타임라인의 로드된 날짜들(연속·오름차순, 스펙 §3). 초기 [어제, 오늘, 내일].
  const [visibleDates, setVisibleDates] = useState<string[]>(() => [
    addDays(today, -1),
    today,
    addDays(today, 1),
  ]);
  const anchorDate = visibleDates[0];

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
    eventsByDate: eventsQ.byDate,
    routinesByDate: routinesQ.byDate,
    dates: visibleDates,
  });
  const boxes = computeLayout(blocks, anchorDate);

  // 블록이 표시된 날짜(occurrence) — 완료 기록/루틴 EXDATE/메모 키가 블록과 일관되도록.
  const blockDate = (block: TimedBlock) => localDateOf(block.startISO);

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
      `${noteTargetMapKey(t.targetKind, t.targetId)}\u0000${blockDate(box.block)}`,
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
      const id = block.id.replace(/^signal:/, "");
      toggleDone.mutate({ id, date: blockDate(block), done });
    } else if (block.routineId) {
      toggleRoutine.mutate({ routineId: block.routineId, date: blockDate(block), done });
    }
  };
  const handlePopoverClose = () => setPopover(null);
  const removeEventFromCache = (calendarId: string, eventId: string) => {
    // 자정 걸침 이벤트는 인접 날짜 버킷에 중복 존재 — 로드된 모든 버킷에서 제거.
    qc.setQueriesData<CalendarEvent[]>({ queryKey: ["calendarEvents"] }, (old) =>
      old?.filter((event) => !(event.calendarId === calendarId && event.id === eventId)),
    );
  };
  const handleDeleteSchedule = (box: LayoutBox) => {
    const { block } = box;
    const title = block.title;
    const linkedEventId = block.linkedEventId;
    const calendarId = block.calendarId;
    // 표시된 occurrence의 날짜 — 루틴 EXDATE/복구가 보이는 인스턴스와 일치(연속 타임라인).
    const occDate = blockDate(block);
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
        // 루틴 목록/블록이 선택 날짜(useTodayRoutines(date, …))로 조회되므로, "빼기"는 보고 있는
        // 날짜(date)의 occurrence를 대상으로 EXDATE 한다 — 표시된 인스턴스와 일치(today 고정 시
        // 다른 날짜를 보는 중에 엉뚱하게 오늘 occurrence가 지워진다).
        // 빼기 = EXDATE: 로컬 skip 행 + 동기화 ON이면 master event EXDATE PATCH.
        await unwrap(commands.unscheduleRoutineToday(routineId, occDate));
        // per-instance Google 이벤트가 있으면(드물게 드래그로 배치됐던 경우) 함께 정리.
        if (linkedEventId && calendarId) {
          await stage({ kind: "routineUnschedule", routineId, date: occDate });
          removeEventFromCache(calendarId, linkedEventId);
          void qc.invalidateQueries({ queryKey: ["pendingWrites"] });
        }
        void qc.invalidateQueries({ queryKey: ["routines"] });
        // 되돌리기 토스트(useTimelineDnd 언스케줄 패턴과 동일 — 자동 dismiss 안에 누르면 복구).
        useToastStore.getState().pushInfo(`타임라인에서 뺐어요: ${title}`, {
          undoLabel: "되돌리기",
          onUndo: () => {
            void unwrap(commands.restoreRoutineToday(routineId, occDate))
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
      void qc.invalidateQueries({ queryKey: ["calendarEvents"] });
      useToastStore.getState().pushError("calendar.delete", err);
    });
  };

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
  // 캔버스 그리드 DOM — useTimelineDnd가 onDragEnd에서 fresh rect를 읽어 드롭 좌표를 환산한다.
  const gridElRef = useRef<HTMLDivElement | null>(null);

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

  // ── 연속 스크롤 관리(스펙 §3·§4) ─────────────────────────────────────
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const prevAnchorRef = useRef(anchorDate);
  const didInitialScrollRef = useRef(false);
  const extendingRef = useRef(false);
  const prevNavDateRef = useRef(date);

  // 초기 1회: "지금"이 뷰포트 중앙에 오도록(스펙 §1 — 열면 현재시각 센터).
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el || didInitialScrollRef.current) return;
    const idx = visibleDates.indexOf(today);
    if (idx < 0) return;
    const now = new Date();
    const nowPx = idx * DAY_PX + now.getHours() * 60 + now.getMinutes();
    el.scrollTop = Math.max(0, nowPx - el.clientHeight / 2);
    didInitialScrollRef.current = true;
  }, [visibleDates, today]);

  // prepend(또는 상단 드롭) 시 scrollTop 보정 — anchor 변화량(일수×1440px)만큼.
  // 빼먹으면 위로 날짜를 붙일 때 화면이 점프한다(스펙 §3 prepend 앵커링).
  useLayoutEffect(() => {
    const el = wrapRef.current;
    const prev = prevAnchorRef.current;
    prevAnchorRef.current = anchorDate;
    if (!el || prev === anchorDate) return;
    el.scrollTop += dayDiff(prev, anchorDate) * DAY_PX;
  }, [anchorDate]);

  // 날짜 목록 갱신 반영 후 lazy-extend 가드 해제.
  useEffect(() => {
    extendingRef.current = false;
  }, [visibleDates]);

  /**
   * 프로그램 스크롤(네비/"오늘" 클릭) 중 표시 — smooth 애니메이션이 끝날 때까지
   * 스크롤 추종(setDate)·lazy-extend를 억제한다. 추종을 끄지 않으면 중간 날짜들로
   * date가 깜빡이고, extend의 prepend 보정이 애니메이션 목표 좌표를 흔든다.
   * 해제 = 목표 근접(8px) 또는 1.6s 타임아웃(사용자 휠 개입 등으로 미도달 시 fail-open).
   */
  const programmaticScrollRef = useRef<{ target: number; since: number } | null>(null);
  const followRafRef = useRef<number | null>(null);

  const smoothScrollTo = (top: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const clamped = Math.max(0, Math.min(el.scrollHeight - el.clientHeight, top));
    programmaticScrollRef.current = { target: clamped, since: performance.now() };
    el.scrollTo({ top: clamped, behavior: "smooth" });
  };

  const handleCanvasScroll = () => {
    const el = wrapRef.current;
    if (!el) return;

    // 프로그램 스크롤 진행 중 — 도달/타임아웃 전엔 추종·extend 모두 보류.
    const prog = programmaticScrollRef.current;
    if (prog) {
      const arrived = Math.abs(el.scrollTop - prog.target) < 8;
      const timedOut = performance.now() - prog.since > 1_600;
      if (!arrived && !timedOut) return;
      programmaticScrollRef.current = null;
    }

    // 스크롤 추종: 뷰포트 중앙이 속한 날짜로 헤더 date를 따라가게(rAF 1회로 합침).
    // 추종발 setDate는 네비가 아니므로 prevNavDateRef를 같이 맞춰 스크롤-투-날짜 effect를 무효화.
    if (followRafRef.current === null) {
      followRafRef.current = requestAnimationFrame(() => {
        followRafRef.current = null;
        const node = wrapRef.current;
        if (!node || programmaticScrollRef.current) return;
        const centerIdx = Math.floor((node.scrollTop + node.clientHeight / 2) / DAY_PX);
        const clampedIdx = Math.max(0, Math.min(visibleDates.length - 1, centerIdx));
        const viewDate = visibleDates[clampedIdx];
        if (viewDate && viewDate !== prevNavDateRef.current) {
          prevNavDateRef.current = viewDate;
          setDate(viewDate);
        }
      });
    }

    if (extendingRef.current) return;
    // 캡 도달 시 lazy-extend 자체를 멈춘다(가드 ref를 세우지 않음 — no-op setState 방지).
    if (visibleDates.length >= MAX_LOADED_DAYS) return;
    const nearTop = el.scrollTop < DAY_PX / 2;
    const nearBottom = el.scrollTop + el.clientHeight > el.scrollHeight - DAY_PX / 2;
    if (!nearTop && !nearBottom) return;
    extendingRef.current = true;
    // 캡 = 확장 중단(축출 아님) — today/date가 visibleDates에서 절대 빠지지 않아
    // now 라인 소실·레일↔캔버스 버킷 불일치가 구조적으로 불가능(timelineWindow.ts).
    setVisibleDates((prev) => extendDates(prev, nearTop ? "up" : "down", MAX_LOADED_DAYS));
  };

  // 추종 rAF 잔여분 unmount 정리.
  useEffect(
    () => () => {
      if (followRafRef.current !== null) cancelAnimationFrame(followRafRef.current);
    },
    [],
  );

  // 헤더 날짜 네비 — 레일 스코프 변경 + 타임라인을 그 날짜로 스크롤(범위 밖이면 로드 확장).
  const handleDateChange = (d: string) => {
    setDate(d);
    setVisibleDates((prev) => includeDate(prev, d));
  };

  // 네비로 date가 바뀐 뒤(같은 렌더 사이클에 visibleDates 확장 반영됨) 해당 날짜로 smooth 스크롤.
  // 오늘이면 현재시각 센터("오늘" 버튼의 자연 복귀), 다른 날짜는 08:00 상단.
  // 스크롤-추종발 변경은 prevNavDateRef가 이미 갱신돼 있어 여기서 스킵된다.
  useEffect(() => {
    if (prevNavDateRef.current === date) return;
    prevNavDateRef.current = date;
    const el = wrapRef.current;
    if (!el) return;
    const idx = dayDiff(date, anchorDate);
    if (idx < 0 || idx >= visibleDates.length) return;
    if (date === today) {
      const now = new Date();
      const nowPx = idx * DAY_PX + now.getHours() * 60 + now.getMinutes();
      smoothScrollTo(nowPx - el.clientHeight / 2);
    } else {
      smoothScrollTo(idx * DAY_PX + 8 * 60);
    }
  }, [date, anchorDate, visibleDates.length, today]);

  // Notion-스타일 ghost: 드래그 중 active item 미리보기를 cursor 따라 렌더.
  // dnd-kit 기본은 원본만 흐려지고 ghost가 없어 "옮기는 느낌"이 약함.
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null);
  const [activeDelta, setActiveDelta] = useState<DragDelta | null>(null);
  const [isOverTray, setIsOverTray] = useState(false);
  const activeDragStartRef = useRef<DragData | null>(null);
  const handleDragStart = (ev: {
    active: { id: string | number; data: { current?: unknown } };
  }) => {
    const data = (ev.active.data.current as DragData | undefined) ?? null;
    activeDragStartRef.current = data;
    setActiveDrag(data);
    setActiveDelta({ x: 0, y: 0 });
    setIsOverTray(false);
  };
  const handleDragMove = (ev: DragMoveEvent) => {
    setActiveDelta(ev.delta);
  };
  const handleDragOver = (ev: DragOverEvent) => {
    setIsOverTray(ev.over?.id === "today-tray");
  };
  const handleDragEndWithReset = async (ev: Parameters<typeof onDragEnd>[0]) => {
    const activeAtStart = activeDragStartRef.current;
    setActiveDrag(null);
    setActiveDelta(null);
    setIsOverTray(false);
    activeDragStartRef.current = null;
    await onDragEnd(ev, activeAtStart);
  };
  const handleDragCancel = () => {
    activeDragStartRef.current = null;
    setActiveDrag(null);
    setActiveDelta(null);
    setIsOverTray(false);
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
          date={popover ? blockDate(popover.box.block) : date}
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
