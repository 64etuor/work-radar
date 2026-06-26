import type { RoutineFreq, RoutineMonthlyPattern, RoutineToday, Weekday } from "@/bindings";

/** 루틴 생성 입력(폼 → CaptureBoard). kind/area는 카드에서 즉시 갱신(IPC)되므로 폼은 안 받는다. */
export type RoutineDraft = {
  title: string;
  freq: RoutineFreq;
  weekdays: Weekday[];
  anchorDate: string | null;
  /** 활성 구간 시작일 'YYYY-MM-DD'. null = 하한 없음(생성 시점부터). 구간 밖은 due 아님. */
  startDate: string | null;
  /** 활성 구간 종료일 'YYYY-MM-DD'(inclusive). null = 무기한. */
  endDate: string | null;
  timeOfDay: string | null;
  reminderOffsetMin: number | null;
  /** monthly 풍부 패턴. monthly가 아니면 null(백엔드가 NULL로 정리). */
  monthlyPattern: RoutineMonthlyPattern | null;
  /** nth_weekday 주차(1..5, -1=마지막). nth_weekday가 아니면 null. */
  monthlyNthWeek: number | null;
  /** Google 동기화 시 이벤트 길이(분). null=기본 30분 fallback. */
  durationMin: number | null;
};

export const DAYS: { label: string; key: Weekday }[] = [
  { label: "월", key: "mon" },
  { label: "화", key: "tue" },
  { label: "수", key: "wed" },
  { label: "목", key: "thu" },
  { label: "금", key: "fri" },
  { label: "토", key: "sat" },
  { label: "일", key: "sun" },
];

export const FREQS: { value: RoutineFreq; label: string }[] = [
  { value: "daily", label: "매일" },
  { value: "weekly", label: "매주" },
  { value: "biweekly", label: "격주" },
  { value: "monthly", label: "매월" },
];

export const MONTHLY_PATTERNS: { value: RoutineMonthlyPattern; label: string }[] = [
  { value: "day_of_month", label: "같은 날짜" },
  { value: "nth_weekday", label: "N번째 요일" },
];

// nth_weekday 주차. -1=마지막(달의 마지막 해당 요일). 백엔드 검증/매핑과 동일 도메인(1..5, -1).
export const NTH_WEEKS: { value: number; label: string }[] = [
  { value: 1, label: "첫째" },
  { value: 2, label: "둘째" },
  { value: 3, label: "셋째" },
  { value: 4, label: "넷째" },
  { value: 5, label: "다섯째" },
  { value: -1, label: "마지막" },
];

export function schedLabel(r: RoutineToday): string {
  if (r.freq === "daily") return "매일";
  if (r.freq === "monthly") {
    if (r.monthlyPattern === "nth_weekday") {
      const nthLabel = NTH_WEEKS.find((w) => w.value === r.monthlyNthWeek)?.label;
      const dayLabel = DAYS.find((d) => d.key === r.weekdays[0])?.label;
      return nthLabel && dayLabel ? `매월 ${nthLabel} ${dayLabel}` : "매월";
    }
    const day = r.anchorDate ? Number(r.anchorDate.split("-")[2]) : null;
    return day ? `매월 ${day}일` : "매월";
  }
  const order = DAYS.map((d) => d.key);
  const days = r.weekdays
    .slice()
    .sort((a, b) => order.indexOf(a) - order.indexOf(b))
    .map((w) => DAYS.find((d) => d.key === w)?.label ?? w)
    .join("·");
  return r.freq === "biweekly" ? `격주 ${days}` : days;
}
