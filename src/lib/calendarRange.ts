// 캘린더 드로어(P7) 일/주/월 범위 경계 계산 — native Date 순수 함수(date-fns 미도입).
// 범위/주경계/월경계가 단순(월요일 시작 주 + 달력 그리드)이라 새 의존성 없이 충분(가장 작은 변경).
// 반환은 모두 로컬 YYYY-MM-DD 문자열 — Rust range_window가 오프셋을 붙여 단일 [time_min,time_max]로 감싼다
// (캘린더당 단일 range 호출 — 주/월도 N일×1콜 아님).

/** 드로어 뷰 모드. */
export type CalendarViewMode = "day" | "week" | "month";

/** Date → 로컬 YYYY-MM-DD(타임존 보존, UTC 변환 안 함). */
export function toLocalISODate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 로컬 YYYY-MM-DD → 로컬 자정 Date(파싱 시 UTC 오해석 방지). */
export function parseLocalISODate(date: string): Date {
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** YYYY-MM-DD에 n일 더한 YYYY-MM-DD(음수 가능). 로컬 기준, DST/월 경계 native Date가 처리. */
export function addDays(date: string, n: number): string {
  const d = parseLocalISODate(date);
  d.setDate(d.getDate() + n);
  return toLocalISODate(d);
}

/** YYYY-MM-DD에 n개월 더한 같은 일자(말일 넘치면 native Date가 다음달로 보정). */
export function addMonths(date: string, n: number): string {
  const d = parseLocalISODate(date);
  d.setMonth(d.getMonth() + n);
  return toLocalISODate(d);
}

/** 주 시작(월요일) YYYY-MM-DD. JS getDay: 0=일 → 월요일까지 거슬러 올라간다. */
export function startOfWeek(date: string): string {
  const d = parseLocalISODate(date);
  const dow = d.getDay(); // 0=일..6=토
  const back = (dow + 6) % 7; // 월=0, 일=6 → 월요일까지 뒤로.
  return addDays(date, -back);
}

/** 주 끝(일요일) YYYY-MM-DD = 주 시작 + 6일. */
export function endOfWeek(date: string): string {
  return addDays(startOfWeek(date), 6);
}

/** 월 1일 YYYY-MM-DD. */
export function startOfMonth(date: string): string {
  const d = parseLocalISODate(date);
  return toLocalISODate(new Date(d.getFullYear(), d.getMonth(), 1));
}

/** 월 말일 YYYY-MM-DD(다음달 0일 = 이번달 말일). */
export function endOfMonth(date: string): string {
  const d = parseLocalISODate(date);
  return toLocalISODate(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

/**
 * 드로어 뷰의 [start, end] 범위(YYYY-MM-DD, end 포함). Rust range_window가 이 한 쌍을
 * 단일 윈도우로 감싸 캘린더당 단일 Google range 호출(주/월도 N콜 아님). 순수.
 *  - day: [date, date]
 *  - week: [월요일, 일요일]
 *  - month: [1일, 말일]
 */
export function viewRange(
  mode: CalendarViewMode,
  date: string,
): { start: string; end: string } {
  switch (mode) {
    case "day":
      return { start: date, end: date };
    case "week":
      return { start: startOfWeek(date), end: endOfWeek(date) };
    case "month":
      return { start: startOfMonth(date), end: endOfMonth(date) };
  }
}

/** 날짜 네비(< >)의 한 스텝 이동: day=±1일, week=±7일, month=±1개월. 순수. */
export function stepDate(
  mode: CalendarViewMode,
  date: string,
  dir: -1 | 1,
): string {
  switch (mode) {
    case "day":
      return addDays(date, dir);
    case "week":
      return addDays(date, dir * 7);
    case "month":
      return addMonths(date, dir);
  }
}

/**
 * 월(月) 뷰 달력 그리드(월요일 시작 6주 = 42칸)의 날짜 셀 목록. 표시 그리드만 만든다(데이터 fetch
 * 범위는 viewRange("month")로 따로 — 그리드는 앞/뒤 달 잔여일 포함이라 더 넓을 수 있다). 순수.
 */
export function monthGridDays(date: string): string[] {
  const first = startOfMonth(date);
  const gridStart = startOfWeek(first);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

/** 주(週) 뷰 7일(월~일) YYYY-MM-DD. 순수. */
export function weekDays(date: string): string[] {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}
