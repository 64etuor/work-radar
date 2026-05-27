import { useMemo, useState } from "react";
import "./TodayView.css";

import { TimelineCanvas } from "@/components/today/TimelineCanvas";
import { TodayHeader } from "@/components/today/TodayHeader";
import { UnscheduledTray } from "@/components/today/UnscheduledTray";
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
import { useUIStore } from "@/store";

/**
 * Today — 하루 운영 콕핏(스펙 §3 통합 뷰). PR 3 셸:
 *   좌 미배치 트레이 + 우 24h read-only 캔버스 + 헤더(날짜 네비 + Work Debt 4칩).
 * 블록 렌더는 PR 4, 드래그/배치는 PR 5에서 추가. 본 PR은 read-only 뼈대.
 * 데이터: today-bound(오버뷰/레일/루틴은 `today` 고정), 캘린더 일정만 선택 날짜 재조회.
 */
export function TodayView() {
  const { goTo } = useUIStore();
  const today = localToday();
  const weekday = localWeekday();
  const [date, setDate] = useState<string>(today);

  const overview = useTodayOverview(today);
  const events = useCalendarEvents(date);
  const todayRail = useToday(today);
  const routines = useTodayRoutines(today, weekday);
  const projectsQ = useProjects();
  const toggleDone = useToggleTodayDone();
  const toggleRoutine = useToggleRoutineCheck();

  // 캘린더 미연결 판정(P7 드로어 패턴 재사용 — 네트워크 없는 ambient 검사).
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

  return (
    <div className="today">
      <TodayHeader
        date={date}
        today={today}
        debt={overview.data?.workDebt ?? {}}
        onDateChange={setDate}
      />
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
            <TimelineCanvas date={date} today={today} />
          )}
        </div>
      </div>
    </div>
  );
}
