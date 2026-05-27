import { ChevronLeft, ChevronRight, Flame, Inbox, Trash2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { stepDate } from "@/lib/calendarRange";
import { useUIStore } from "@/store";

/**
 * Today 운영 부채(Work Debt) 카운트. `useTodayOverview().data?.workDebt`를 그대로 받는다.
 * 모든 필드는 선택적 — 데이터 미도착/비어있을 때 `—` 표기 (graceful degrade).
 */
type DebtCounts = {
  unclassified?: number;
  q1Overdue?: number;
  staleBacklog?: number;
  cleanupNeeded?: number;
};

type Props = {
  date: string;
  today: string;
  debt: DebtCounts;
  onDateChange: (d: string) => void;
};

const CHIPS: Array<{
  key: keyof DebtCounts;
  label: string;
  icon: ReactNode;
  tone: "urgent" | "warn" | "muted";
  go: "board" | "radar";
}> = [
  {
    key: "unclassified",
    label: "미분류",
    icon: <Inbox className="size-3.5" />,
    tone: "warn",
    go: "board",
  },
  {
    key: "q1Overdue",
    label: "Q1 overdue",
    icon: <Flame className="size-3.5" />,
    tone: "urgent",
    go: "board",
  },
  {
    key: "staleBacklog",
    label: "stale",
    icon: <TriangleAlert className="size-3.5" />,
    tone: "warn",
    go: "board",
  },
  {
    key: "cleanupNeeded",
    label: "cleanup",
    icon: <Trash2 className="size-3.5" />,
    tone: "muted",
    go: "radar",
  },
];

/**
 * Today 헤더(스펙 §3·§D13). 날짜 네비 + Work Debt 4칩을 한 줄에. native drag region.
 * 4칩은 별도 스트립이 아니라 헤더 우측에 흡수 — 운영 cockpit이 시각적으로 한 줄로 안정.
 */
export function TodayHeader({ date, today, debt, onDateChange }: Props) {
  const { goTo } = useUIStore();
  const isToday = date === today;
  return (
    <header className="today-head" data-tauri-drag-region>
      <span className="today-title">Today</span>
      <div className="today-nav">
        <Button
          variant="outline"
          size="sm"
          className="size-[26px] shrink-0 p-0"
          aria-label="이전 날짜"
          onClick={() => onDateChange(stepDate("day", date, -1))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="today-date">{date}</span>
        <Button
          variant="outline"
          size="sm"
          className="size-[26px] shrink-0 p-0"
          aria-label="다음 날짜"
          onClick={() => onDateChange(stepDate("day", date, 1))}
        >
          <ChevronRight className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-[26px] rounded-full px-3 text-[12px]"
          disabled={isToday}
          onClick={() => onDateChange(today)}
        >
          오늘로
        </Button>
      </div>
      <div className="today-debt-chips" role="group" aria-label="Work Debt 요약">
        {CHIPS.map((c) => {
          const n = debt[c.key];
          // a11y: 아이콘만 있는 chip이라 텍스트 라벨 + 숫자를 aria-label로 합쳐 노출.
          // 숫자 미도착 시 "데이터 없음"으로 fallback.
          const ariaLabel = n === undefined ? `${c.label} 데이터 없음` : `${c.label} ${n}건`;
          return (
            <button
              key={c.key}
              type="button"
              className={`today-debt-chip today-debt-${c.tone}`}
              onClick={() => goTo(c.go)}
              title={c.label}
              aria-label={ariaLabel}
            >
              {c.icon}
              <span>{c.label}</span>
              <span className="today-debt-num" aria-hidden>
                {n ?? "—"}
              </span>
            </button>
          );
        })}
      </div>
    </header>
  );
}
