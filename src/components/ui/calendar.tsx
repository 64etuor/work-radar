import { ChevronLeft, ChevronRight } from "lucide-react";
import * as React from "react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import {
  addDays,
  addMonths,
  endOfWeek,
  monthGridDays,
  startOfMonth,
  startOfWeek,
  toLocalISODate,
} from "@/lib/calendarRange";
import { WEEKDAY_SHORT_MON_FIRST } from "@/lib/localeFormat";

/** 로컬 오늘 'YYYY-MM-DD'. */
function localToday(): string {
  return toLocalISODate(new Date());
}

/** 'YYYY-MM-DD' → 'YYYY-MM'(같은 달 판정). */
function ym(date: string): string {
  return date.slice(0, 7);
}

/** 'YYYY-MM-DD' → "2026년 6월" 헤더 라벨. */
function monthLabel(date: string): string {
  const [y, m] = date.split("-");
  return `${y}년 ${Number(m)}월`;
}

type CalendarProps = {
  /** 선택된 날짜 'YYYY-MM-DD' | null. */
  selected: string | null;
  /** 날짜 선택(클릭/Enter/Space). */
  onSelect: (date: string) => void;
  /** 보이는 달 'YYYY-MM-DD'(제어). 비제어면 selected ?? today로 내부 초기화. */
  month?: string;
  onMonthChange?: (month: string) => void;
  /** 이 범위(inclusive) 밖 날짜는 비활성 — 포커스 가능하되 선택 불가(WAI-ARIA grid). */
  min?: string;
  max?: string;
  /** 오늘 기준(테스트 주입). 기본 = 로컬 오늘. */
  today?: string;
  className?: string;
};

/**
 * 순수 월(月) 그리드 — 날짜 1개 선택. fetch/영속 없음(표시·선택만). `calendarRange` 헬퍼 위에.
 * 월요일 시작 6×7. 키보드: 화살표=일 이동, Enter/Space=선택, PageUp/Down=월, Home/End=주 경계.
 * 비활성 날짜(min/max 밖)는 `aria-disabled`로 포커스만 가능(선택 불가) — 키보드 네비가 끊기지 않게.
 */
export function Calendar({
  selected,
  onSelect,
  month,
  onMonthChange,
  min,
  max,
  today,
  className,
}: CalendarProps) {
  const todayStr = today ?? localToday();
  const [internalMonth, setInternalMonth] = useState(() =>
    startOfMonth(month ?? selected ?? todayStr),
  );
  const viewMonth = month != null ? startOfMonth(month) : internalMonth;

  const setMonth = (m: string) => {
    const sm = startOfMonth(m);
    onMonthChange?.(sm);
    if (month == null) setInternalMonth(sm);
  };

  // roving tabindex 대상.
  const [focusedDate, setFocusedDate] = useState<string>(selected ?? todayStr);
  const gridRef = useRef<HTMLDivElement>(null);
  const didMount = useRef(false);

  // 키보드 이동 후에만 DOM 포커스를 옮긴다(초기 마운트엔 포커스 가로채지 않음 — Popover 자동
  // 포커스에 양보).
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDate}"]`)?.focus();
  }, [focusedDate]);

  const isDisabled = (d: string) => (min != null && d < min) || (max != null && d > max);

  const moveFocus = (next: string) => {
    setFocusedDate(next);
    if (ym(next) !== ym(viewMonth)) setMonth(next);
  };

  // 방향키 → 이동 대상 날짜('YYYY-MM-DD'). 비이동 키는 null.
  const moveFor = (key: string): string | null => {
    switch (key) {
      case "ArrowLeft":
        return addDays(focusedDate, -1);
      case "ArrowRight":
        return addDays(focusedDate, 1);
      case "ArrowUp":
        return addDays(focusedDate, -7);
      case "ArrowDown":
        return addDays(focusedDate, 7);
      case "PageUp":
        return addMonths(focusedDate, -1);
      case "PageDown":
        return addMonths(focusedDate, 1);
      case "Home":
        return startOfWeek(focusedDate);
      case "End":
        return endOfWeek(focusedDate);
      default:
        return null;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!isDisabled(focusedDate)) onSelect(focusedDate);
      return;
    }
    const next = moveFor(e.key);
    if (next === null) return;
    e.preventDefault();
    moveFocus(next);
  };

  return (
    <div className={cn("w-64 select-none", className)} data-slot="calendar">
      <div className="mb-1 flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-7 p-0"
          aria-label="이전 달"
          onClick={() => setMonth(addMonths(viewMonth, -1))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-xs font-semibold" aria-live="polite">
          {monthLabel(viewMonth)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="size-7 p-0"
          aria-label="다음 달"
          onClick={() => setMonth(addMonths(viewMonth, 1))}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>

      <div className="grid grid-cols-7" role="presentation">
        {WEEKDAY_SHORT_MON_FIRST.map((w) => (
          <div key={w} className="typo-caption-sm text-muted-foreground py-1 text-center">
            {w}
          </div>
        ))}
      </div>

      <div
        ref={gridRef}
        role="grid"
        tabIndex={0}
        className="grid grid-cols-7"
        onKeyDown={onKeyDown}
      >
        {monthGridDays(viewMonth).map((d) => {
          const inMonth = ym(d) === ym(viewMonth);
          const isSel = d === selected;
          const isToday = d === todayStr;
          const disabled = isDisabled(d);
          return (
            <button
              key={d}
              type="button"
              role="gridcell"
              data-date={d}
              aria-selected={isSel}
              aria-disabled={disabled || undefined}
              aria-current={isToday ? "date" : undefined}
              tabIndex={d === focusedDate ? 0 : -1}
              onClick={() => {
                if (!disabled) onSelect(d);
              }}
              onFocus={() => setFocusedDate(d)}
              className={cn(
                "m-0.5 flex size-8 items-center justify-center rounded-md text-xs",
                !inMonth && "text-muted-foreground/40",
                isToday && !isSel && "text-primary font-semibold",
                isSel && "bg-primary text-primary-foreground",
                !isSel && !disabled && "hover:bg-muted",
                disabled && "opacity-40",
              )}
            >
              {Number(d.slice(8, 10))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
