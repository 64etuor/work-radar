import { useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Flame,
  GanttChart,
} from "lucide-react";

import type { CalendarEvent, WorkSignal } from "@/bindings";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  ageFromForDate,
  localToday,
  openExternal,
  useCalendarEvents,
  useSignals,
  useToday,
} from "@/lib/query";
import { useUIStore } from "@/store";

/** YYYY-MM-DD 를 delta일 만큼 이동(로컬). */
function shiftDate(date: string, delta: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(y, m - 1, d + delta);
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${dt.getFullYear()}-${mm}-${dd}`;
}

/** RFC3339 → 시작 시각 시(0-23). all-day엔 호출 안 함. */
function startHour(iso: string): number {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 0 : d.getHours();
}
function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Timeline — 하루의 시간축 아젠다(Phase 11b). 캘린더 타임드 이벤트를 시간대별로 배치하고,
 * all-day + (오늘이면) Today 레일·Q1을 상단 untimed 밴드에 모은다. 날짜 피커로 앞뒤 이동.
 * 전부 read 합성 — 외부 변경 없음. 캘린더는 ambient(미연결 graceful degrade).
 */
export function TimelineView() {
  const { goTo } = useUIStore();
  const today = localToday();
  const [date, setDate] = useState(today);
  const isToday = date === today;

  const events = useCalendarEvents(date);
  // Today 레일/Q1 오버레이는 "오늘의 focus"라 오늘일 때만 표시(쿼리는 board와 공유·캐시).
  const todayRail = useToday(today);
  const signals = useSignals();

  const all = events.data ?? [];
  const allDay = all.filter((e) => e.allDay);
  const timed = all
    .filter((e) => !e.allDay)
    .sort((a, b) => a.start.localeCompare(b.start));
  const railItems = isToday ? (todayRail.data ?? []) : [];
  const q1Items = isToday
    ? (signals.data ?? []).filter((s) => s.quadrant === "q1_do_now")
    : [];

  // 타임드 이벤트가 걸친 시간 범위(없으면 업무시간 기본 8–20). 시간 행으로 렌더.
  const hours = timed.map((e) => startHour(e.start));
  const lo = hours.length ? Math.min(8, ...hours) : 8;
  const hi = hours.length ? Math.max(20, ...hours) + 1 : 21;
  const hourRows: number[] = [];
  for (let h = lo; h < hi; h++) hourRows.push(h);
  const byHour = new Map<number, CalendarEvent[]>();
  for (const e of timed) {
    const h = startHour(e.start);
    const arr = byHour.get(h) ?? [];
    arr.push(e);
    byHour.set(h, arr);
  }

  const hasUntimed = allDay.length > 0 || railItems.length > 0 || q1Items.length > 0;

  return (
    <div className="tl">
      <header className="tl-head" data-tauri-drag-region>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-full"
          onClick={() => goTo("board")}
        >
          <ArrowLeft className="size-4" />
          보드
        </Button>
        <span className="tl-title">Timeline</span>
        <div className="tl-nav">
          <Button
            variant="outline"
            size="sm"
            className="size-8 p-0"
            aria-label="이전 날짜"
            onClick={() => setDate(shiftDate(date, -1))}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className={cn("gap-1.5 rounded-md font-mono", isToday && "border-wr-accent")}
            onClick={() => setDate(today)}
            title="오늘로"
          >
            {date}
            {isToday && <span className="tl-today-tag">오늘</span>}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="size-8 p-0"
            aria-label="다음 날짜"
            onClick={() => setDate(shiftDate(date, 1))}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </header>

      <div className="tl-scroll">
        {events.isError && (
          <div className="tl-hint">캘린더를 불러오지 못했습니다 — 설정에서 Google Calendar 연결을 확인하세요.</div>
        )}

        {/* untimed 밴드: all-day + (오늘) Today 레일 + Q1 */}
        {hasUntimed && (
          <section className="tl-band">
            <div className="tl-band-label">
              종일{railItems.length + q1Items.length > 0 ? " · focus" : ""}
            </div>
            <div className="tl-band-items">
              {allDay.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="tl-chip tl-chip-cal"
                  onClick={() => e.url && void openExternal(e.url)}
                  title={e.calendarSummary}
                >
                  {e.title}
                </button>
              ))}
              {q1Items.map((s: WorkSignal) => (
                <span key={s.id} className="tl-chip tl-chip-q1">
                  <Flame className="size-3" />
                  {s.title}
                </span>
              ))}
              {railItems.map((s) => (
                <span key={s.id} className="tl-chip tl-chip-focus">
                  {s.title}
                  {s.todayForDate && ageFromForDate(s.todayForDate) > 1 && (
                    <span className="tl-chip-age">+{ageFromForDate(s.todayForDate)}</span>
                  )}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* 시간 그리드 */}
        {timed.length === 0 ? (
          <div className="tl-hint">
            {events.isError ? "" : "이 날짜의 시간 지정 일정이 없습니다 (연결된 캘린더 기준)."}
          </div>
        ) : (
          <div className="tl-grid">
            {hourRows.map((h) => {
              const evs = byHour.get(h) ?? [];
              return (
                <div key={h} className={`tl-hour${evs.length ? "" : " tl-hour-empty"}`}>
                  <span className="tl-hour-label">{String(h).padStart(2, "0")}:00</span>
                  <div className="tl-hour-events">
                    {evs.map((e) => (
                      <button
                        key={e.id}
                        type="button"
                        className="tl-event"
                        onClick={() => e.url && void openExternal(e.url)}
                      >
                        <span className="tl-event-time">
                          {hhmm(e.start)}
                          {e.end ? `–${hhmm(e.end)}` : ""}
                        </span>
                        <span className="tl-event-title">{e.title}</span>
                        <span className="tl-event-cal">{e.calendarSummary}</span>
                        {e.url && <ExternalLink className="size-3.5 text-wr-subtle" />}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="tl-foot">
          <GanttChart className="size-3.5" />
          {isToday ? "오늘 · Today 레일·Q1 오버레이 포함" : "다른 날짜 · 캘린더 일정만"}
        </div>
      </div>
    </div>
  );
}
