import type { CalendarEvent } from "@/bindings";
import { cn } from "@/components/ui/cn";
import { EmptyState } from "@/components/ui/empty-state";
import {
  type CalendarViewMode,
  monthGridDays,
  parseLocalISODate,
  startOfMonth,
  toLocalISODate,
  weekDays,
} from "@/lib/calendarRange";
import { WEEKDAY_SHORT_MON_FIRST } from "@/lib/localeFormat";
import { calendarColorStyle } from "@/lib/projectCalendarColor";

/** 한 이벤트가 속한 로컬 날짜(YYYY-MM-DD). timed=RFC3339 시작, all-day=date. */
function eventDate(ev: CalendarEvent): string {
  if (ev.allDay) return ev.start.slice(0, 10);
  // timed = RFC3339 → 로컬 날짜로 변환(드로어는 로컬 일자 그리드).
  const d = new Date(ev.start);
  return Number.isNaN(d.getTime()) ? ev.start.slice(0, 10) : toLocalISODate(d);
}

/** timed 이벤트 시작 시각 "HH:mm"(로컬). all-day는 null. */
function eventTime(ev: CalendarEvent): string | null {
  if (ev.allDay) return null;
  const d = new Date(ev.start);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 날짜별 이벤트 버킷(YYYY-MM-DD → 이벤트[]). 입력은 이미 시간순(Rust merge_sort). */
function bucketByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const key = eventDate(ev);
    const arr = map.get(key);
    if (arr) arr.push(ev);
    else map.set(key, [ev]);
  }
  return map;
}

const WEEKDAY_LABELS = WEEKDAY_SHORT_MON_FIRST;

type Props = {
  /** 표시할 이벤트(시간순 병합된 ambient 사본). */
  events: CalendarEvent[];
  /** 일/주/월 뷰. */
  mode: CalendarViewMode;
  /** 기준 날짜(YYYY-MM-DD) — day=그날, week=그 주, month=그 달. */
  date: string;
  /** 셀/이벤트 클릭(P8/P9 재사용 훅 — 드로어는 미사용 가능). */
  onSelectDate?: (date: string) => void;
};

/**
 * 재사용 캘린더 뷰(P7 드로어 본문 · P8 긴급도 · P9 Today에서 재사용). 조회 전용(읽기) — 일정 생성/편집
 * 없음(기존 등록 모달과 분리, plan 확정). DESIGN.md calendar-drawer: 일=시간 행 / 주=7열 / 월=셀 그리드,
 * 이벤트=radius sm 블록(종일/시간 분리). 순수 표시 컴포넌트(상태/fetch는 호출부).
 */
export function CalendarView({ events, mode, date, onSelectDate }: Props) {
  const buckets = bucketByDate(events);
  const todayIso = toLocalISODate(new Date());

  if (mode === "day") {
    const dayEvents = buckets.get(date) ?? [];
    return (
      <div className="calv calv-day">
        {dayEvents.length === 0 ? (
          <EmptyState className="calv-empty">이 날짜에 일정 없음</EmptyState>
        ) : (
          dayEvents.map((ev) => <EventBlock key={ev.id} ev={ev} showTime />)
        )}
      </div>
    );
  }

  if (mode === "week") {
    const days = weekDays(date);
    return (
      <div className="calv calv-week">
        {days.map((d, i) => {
          const list = buckets.get(d) ?? [];
          const dd = parseLocalISODate(d);
          return (
            <div key={d} className={cn("calv-col", d === todayIso && "is-today")}>
              {onSelectDate ? (
                <button
                  type="button"
                  className="calv-col-head w-full border-0 bg-transparent p-0"
                  onClick={() => onSelectDate(d)}
                  aria-label={`${d} 선택`}
                >
                  <span className="calv-dow">{WEEKDAY_LABELS[i]}</span>
                  <span className="calv-dom">{dd.getDate()}</span>
                </button>
              ) : (
                <div className="calv-col-head">
                  <span className="calv-dow">{WEEKDAY_LABELS[i]}</span>
                  <span className="calv-dom">{dd.getDate()}</span>
                </div>
              )}
              <div className="calv-col-body">
                {list.length === 0 ? (
                  <div className="calv-col-empty">·</div>
                ) : (
                  list.map((ev) => <EventBlock key={ev.id} ev={ev} compact />)
                )}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  // month
  const grid = monthGridDays(date);
  const monthIso = startOfMonth(date).slice(0, 7); // YYYY-MM (당월 판별).
  return (
    <div className="calv calv-month">
      <div className="calv-month-dows">
        {WEEKDAY_LABELS.map((w) => (
          <span key={w} className="calv-dow">
            {w}
          </span>
        ))}
      </div>
      <div className="calv-month-grid">
        {grid.map((d) => {
          const list = buckets.get(d) ?? [];
          const dd = parseLocalISODate(d);
          const outside = d.slice(0, 7) !== monthIso;
          return (
            <div
              key={d}
              className={cn("calv-cell", outside && "is-outside", d === todayIso && "is-today")}
            >
              {onSelectDate ? (
                <button
                  type="button"
                  className="calv-cell-dom w-fit border-0 bg-transparent p-0 text-left"
                  onClick={() => onSelectDate(d)}
                  aria-label={`${d} 선택`}
                >
                  {dd.getDate()}
                </button>
              ) : (
                <span className="calv-cell-dom">{dd.getDate()}</span>
              )}
              <div className="calv-cell-events">
                {list.slice(0, 3).map((ev) => (
                  <span
                    key={ev.id}
                    className={cn("calv-dot", ev.allDay && "is-allday")}
                    title={ev.title}
                    style={calendarColorStyle(ev.projectColor, ev.projectTextColor)}
                  >
                    {ev.title}
                  </span>
                ))}
                {list.length > 3 && <span className="calv-more">+{list.length - 3}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 단일 이벤트 블록(종일/시간 분리). showTime=일뷰 시각 표시, compact=주뷰 축약. */
function EventBlock({
  ev,
  showTime = false,
  compact = false,
}: {
  ev: CalendarEvent;
  showTime?: boolean;
  compact?: boolean;
}) {
  const time = eventTime(ev);
  const body = (
    <div
      className={cn("calv-ev", ev.allDay && "is-allday", compact && "is-compact")}
      style={calendarColorStyle(ev.projectColor, ev.projectTextColor)}
    >
      {showTime && <span className="calv-ev-time">{ev.allDay ? "종일" : (time ?? "")}</span>}
      <span className="calv-ev-title">{ev.title}</span>
      {ev.calendarSummary && !compact && <span className="calv-ev-cal">{ev.calendarSummary}</span>}
    </div>
  );
  if (ev.url) {
    return (
      <a className="calv-ev-link" href={ev.url} target="_blank" rel="noreferrer" title={ev.title}>
        {body}
      </a>
    );
  }
  return body;
}
