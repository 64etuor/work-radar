import type { BookkeepingRecurringMonthRow } from "@/bindings";
import { APP_LOCALE } from "@/lib/localeFormat";

/** 고정비 납부 상태 배지 — 백엔드는 `paid`만 판정하고(저장 없음),
 *  예정/미납 구분은 로컬 오늘 날짜와 비교해 표시 시점에 파생한다. */
export type RecurringPaymentBadge = {
  kind: "paid" | "upcoming" | "overdue";
  label: string;
};

const dueDateFormat = new Intl.DateTimeFormat(APP_LOCALE, {
  month: "short",
  day: "numeric",
});

/** YYYY-MM-DD → 로케일 짧은 날짜(타임존 시프트 방지 위해 로컬 자정으로 파싱). */
export function formatShortDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  if (!year || !month || !day) return isoDate;
  return dueDateFormat.format(new Date(year, month - 1, day));
}

export function recurringPaymentBadge(
  row: BookkeepingRecurringMonthRow,
  today: string,
): RecurringPaymentBadge {
  if (row.paid) {
    return {
      kind: "paid",
      label: `납부됨 · ${formatShortDate(row.matchedSpentAt ?? row.dueDate)}`,
    };
  }
  if (row.dueDate < today) {
    return { kind: "overdue", label: `미납 · ${formatShortDate(row.dueDate)} 예정` };
  }
  return { kind: "upcoming", label: `${formatShortDate(row.dueDate)} 예정` };
}
