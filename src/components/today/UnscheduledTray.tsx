import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Calendar, CheckCircle2, ChevronDown, ChevronRight, Circle, Repeat } from "lucide-react";
import { useState } from "react";

import type { CalendarEvent, RoutineToday, WorkSignal } from "@/bindings";
import type { DragData, DropData } from "@/components/today/useTimelineDnd";
import { calendarColorStyle } from "@/lib/projectCalendarColor";

type Props = {
  unscheduledTodays: WorkSignal[];
  unscheduledRoutines: RoutineToday[];
  allDayEvents: CalendarEvent[];
  onToggleDone: (id: string, done: boolean) => void;
  onToggleRoutine: (routineId: string, done: boolean) => void;
};

/** 트레이의 미배치 signal 한 row — useDraggable로 캔버스에 drop 가능. */
function SignalDraggableRow({
  signal,
  done,
  onToggleDone,
}: {
  signal: WorkSignal;
  done: boolean;
  onToggleDone: (id: string, done: boolean) => void;
}) {
  const data: DragData = {
    from: "tray",
    signalId: signal.id,
    title: signal.title,
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tray:signal:${signal.id}`,
    data,
  });
  return (
    <div
      ref={setNodeRef}
      className="today-tray-row"
      data-kind="today"
      data-dragging={isDragging || undefined}
      {...attributes}
      {...listeners}
      role="listitem"
      aria-label={`${signal.title} (Today, 드래그하여 시간축에 배치)`}
    >
      <span className="today-tray-grip" aria-hidden>
        ⠿
      </span>
      <button
        type="button"
        className="today-tray-check"
        aria-label={done ? "완료 취소" : "완료"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onToggleDone(signal.id, !done)}
      >
        {done ? (
          <CheckCircle2 className="text-q2 size-4" />
        ) : (
          <Circle className="text-wr-subtle size-4" />
        )}
      </button>
      <span className="today-tray-title">{signal.title}</span>
      <span className="today-tray-tag tag-today">Today</span>
    </div>
  );
}

/** 트레이의 미배치 routine 한 row — useDraggable로 캔버스에 drop 가능. */
function RoutineDraggableRow({
  routine,
  onToggleRoutine,
}: {
  routine: RoutineToday;
  onToggleRoutine: (routineId: string, done: boolean) => void;
}) {
  const data: DragData = {
    from: "routine",
    routineId: routine.id,
    title: routine.title,
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `tray:routine:${routine.id}`,
    data,
  });
  return (
    <div
      ref={setNodeRef}
      className="today-tray-row"
      data-kind="routine"
      data-dragging={isDragging || undefined}
      {...attributes}
      {...listeners}
      role="listitem"
      aria-label={`${routine.title} (루틴, 드래그하여 시간축에 배치)`}
    >
      <span className="today-tray-grip" aria-hidden>
        ⠿
      </span>
      <button
        type="button"
        className="today-tray-check"
        aria-label={routine.done ? "완료 취소" : "완료"}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => onToggleRoutine(routine.id, !routine.done)}
      >
        {routine.done ? (
          <CheckCircle2 className="text-q2 size-4" />
        ) : (
          <Circle className="text-wr-subtle size-4" />
        )}
      </button>
      <Repeat className="text-wr-subtle size-3.5" />
      <span className="today-tray-title">{routine.title}</span>
    </div>
  );
}

/**
 * 미배치 트레이(스펙 §3·§D2·§D3). 시간 미지정 Today + 시간 미지정 루틴 + 종일 이벤트(접힘).
 * PR 5: 전체 영역이 droppable("tray") — 캔버스에서 unschedule, signal/routine row는 draggable.
 */
export function UnscheduledTray({
  unscheduledTodays,
  unscheduledRoutines,
  allDayEvents,
  onToggleDone,
  onToggleRoutine,
}: Props) {
  const [allDayOpen, setAllDayOpen] = useState(false);
  const empty =
    unscheduledTodays.length === 0 && unscheduledRoutines.length === 0 && allDayEvents.length === 0;

  const dropData: DropData = { to: "tray" };
  const { setNodeRef, isOver } = useDroppable({ id: "today-tray", data: dropData });

  return (
    <aside
      ref={setNodeRef}
      className="today-tray"
      aria-label="미배치 항목"
      data-drop-over={isOver || undefined}
    >
      <div className="today-tray-head" id="today-tray-head">
        미배치
      </div>
      <div className="today-tray-body" role="list" aria-labelledby="today-tray-head">
        {empty && <div className="today-tray-empty">모든 항목이 시간축에 배치됐어요.</div>}
        {unscheduledTodays.map((s) => (
          <SignalDraggableRow
            key={`s-${s.id}`}
            signal={s}
            done={Boolean(s.todayDoneAt)}
            onToggleDone={onToggleDone}
          />
        ))}
        {unscheduledRoutines.map((r) => (
          <RoutineDraggableRow key={`r-${r.id}`} routine={r} onToggleRoutine={onToggleRoutine} />
        ))}
        {allDayEvents.length > 0 && (
          <div className="today-tray-section">
            <button
              type="button"
              className="today-tray-section-head"
              onClick={() => setAllDayOpen((v) => !v)}
              aria-expanded={allDayOpen}
              aria-controls="today-tray-allday-body"
              aria-label={`종일 이벤트 ${allDayEvents.length}건${allDayOpen ? "(펼침)" : "(접힘)"}`}
            >
              {allDayOpen ? (
                <ChevronDown className="size-3.5" aria-hidden />
              ) : (
                <ChevronRight className="size-3.5" aria-hidden />
              )}
              <Calendar className="size-3.5" aria-hidden />
              <span>종일</span>
              <span className="today-tray-count" aria-hidden>
                {allDayEvents.length}
              </span>
            </button>
            {allDayOpen && (
              <div
                id="today-tray-allday-body"
                className="today-tray-allday"
                role="list"
                aria-label="종일 이벤트 목록"
              >
                {allDayEvents.map((e) => (
                  <span
                    key={e.id}
                    role="listitem"
                    className="today-tray-chip"
                    style={calendarColorStyle(e.projectColor, e.projectTextColor)}
                    title={e.calendarSummary}
                  >
                    {e.title}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
