import { useState } from "react";

import { Calendar } from "@/components/ui/calendar";
import { cn } from "@/components/ui/cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** 'YYYY-MM-DD' → 'YYYY.MM.DD' 표시(로캘 라이브러리 없이 순수 변환). */
function formatTrigger(value: string): string {
  return value.slice(0, 10).replace(/-/g, ".");
}

type DatePickerProps = {
  /** 선택값 'YYYY-MM-DD' | null. */
  value: string | null;
  onChange: (date: string | null) => void;
  /** 빈 값일 때 트리거 라벨. */
  placeholder?: string;
  /** 선택 가능 범위(inclusive). end≥start 등 교차 제약에 사용. */
  min?: string;
  max?: string;
  disabled?: boolean;
  /** <label htmlFor>와 연결할 트리거 id. */
  id?: string;
  ariaLabel?: string;
  /** 값 지우기(빈 날짜=null) 허용. 기본 true. */
  clearable?: boolean;
  /** 트리거 클래스 override(소비처 높이/폭 맞춤). */
  className?: string;
};

/**
 * 네이티브 `<input type="date">` 드롭인 대체 — 트리거 버튼 + Popover + 순수 `Calendar`.
 * 값 계약은 'YYYY-MM-DD' 문자열(빈 값=null). Esc/바깥클릭 닫힘·포커스 복원은 Popover 프리미티브가
 * 보증(overlay-stack 계약). 선택 시 onChange + 닫힘. clearable면 "지우기"로 onChange(null).
 */
export function DatePicker({
  value,
  onChange,
  placeholder = "날짜",
  min,
  max,
  disabled,
  id,
  ariaLabel,
  clearable = true,
  className,
}: DatePickerProps) {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        data-date-picker-trigger
        className={cn(
          "border-input bg-background text-foreground focus-visible:ring-ring inline-flex h-9 items-center justify-start rounded-md border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
          !value && "text-muted-foreground",
          className,
        )}
      >
        {value ? formatTrigger(value) : placeholder}
      </PopoverTrigger>
      <PopoverContent
        className="w-auto p-3"
        align="start"
        onOpenAutoFocus={(e) => {
          // Radix 기본은 첫 tabbable(이전 달 버튼)에 포커스 → 키보드-우선 위해 roving 날짜 셀로.
          // 셀을 못 찾으면 preventDefault 안 함(Radix 기본 포커스로 안전 폴백).
          const cell = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>(
            '[role="gridcell"][tabindex="0"]',
          );
          if (cell) {
            e.preventDefault();
            cell.focus();
          }
        }}
      >
        <Calendar
          selected={value}
          onSelect={(d) => {
            onChange(d);
            setOpen(false);
          }}
          min={min}
          max={max}
        />
        {clearable && value && (
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground mt-2 w-full text-center text-xs"
            onClick={() => {
              onChange(null);
              setOpen(false);
            }}
          >
            지우기
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
