import { useState } from "react";
import {
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Repeat,
} from "lucide-react";

import type { CalendarEvent, RoutineToday, WorkSignal } from "@/bindings";
import { calendarColorStyle } from "@/lib/projectCalendarColor";

type Props = {
  unscheduledTodays: WorkSignal[];
  unscheduledRoutines: RoutineToday[];
  allDayEvents: CalendarEvent[];
  onToggleDone: (id: string, done: boolean) => void;
  onToggleRoutine: (routineId: string, done: boolean) => void;
};

/**
 * 미배치 트레이(스펙 §3·§D2·§D3). 시간 미지정 Today + 시간 미지정 루틴 + 종일 이벤트(접힘).
 * 본 PR(3)은 read-only — 토글만 동작, 드래그는 PR 5에서 추가.
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
    unscheduledTodays.length === 0 &&
    unscheduledRoutines.length === 0 &&
    allDayEvents.length === 0;

  return (
    <aside className="today-tray">
      <div className="today-tray-head">미배치</div>
      <div className="today-tray-body">
        {empty && (
          <div className="today-tray-empty">모든 항목이 시간축에 배치됐어요.</div>
        )}
        {unscheduledTodays.map((s) => {
          const done = Boolean(s.todayDoneAt);
          return (
            <div key={`s-${s.id}`} className="today-tray-row" data-kind="today">
              <button
                type="button"
                className="today-tray-check"
                aria-label={done ? "완료 취소" : "완료"}
                onClick={() => onToggleDone(s.id, !done)}
              >
                {done ? (
                  <CheckCircle2 className="size-4 text-q2" />
                ) : (
                  <Circle className="size-4 text-wr-subtle" />
                )}
              </button>
              <span className="today-tray-title">{s.title}</span>
              <span className="today-tray-tag tag-today">Today</span>
            </div>
          );
        })}
        {unscheduledRoutines.map((r) => (
          <div key={`r-${r.id}`} className="today-tray-row" data-kind="routine">
            <button
              type="button"
              className="today-tray-check"
              aria-label={r.done ? "완료 취소" : "완료"}
              onClick={() => onToggleRoutine(r.id, !r.done)}
            >
              {r.done ? (
                <CheckCircle2 className="size-4 text-q2" />
              ) : (
                <Circle className="size-4 text-wr-subtle" />
              )}
            </button>
            <Repeat className="size-3.5 text-wr-subtle" />
            <span className="today-tray-title">{r.title}</span>
          </div>
        ))}
        {allDayEvents.length > 0 && (
          <div className="today-tray-section">
            <button
              type="button"
              className="today-tray-section-head"
              onClick={() => setAllDayOpen((v) => !v)}
            >
              {allDayOpen ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              <Calendar className="size-3.5" />
              <span>종일</span>
              <span className="today-tray-count">{allDayEvents.length}</span>
            </button>
            {allDayOpen && (
              <div className="today-tray-allday">
                {allDayEvents.map((e) => (
                  <span
                    key={e.id}
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
