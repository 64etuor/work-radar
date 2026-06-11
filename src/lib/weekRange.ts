// src/lib/weekRange.ts
/** 주차 네비게이션 날짜 수학(순수). 월요일 시작 주, 일요일이 주의 끝(weeklyReview endDate). */

import { addDays, parseLocalISODate } from "@/lib/calendarRange";

/** 스크러바/페이저가 다루는 과거 주 윈도우 길이(주). 가장 오래된 주 = offset -(WEEKS_WINDOW-1). */
export const WEEKS_WINDOW = 12;

/** 그 날짜가 속한 주의 월요일(YYYY-MM-DD). JS getDay(): 0=일..6=토. */
export function mondayOf(yyyymmdd: string): string {
  const dt = parseLocalISODate(yyyymmdd);
  const dow = dt.getDay(); // 0=Sun
  const deltaToMonday = dow === 0 ? -6 : 1 - dow; // Sun→-6, Mon→0, Tue→-1 ...
  return addDays(yyyymmdd, deltaToMonday);
}

export interface WeekRange {
  start: string; // 월요일
  end: string; // 일요일 (weeklyReview endDate)
}

/** today 기준 offset주(0=이번 주, 음수=과거)의 [월,일] 범위. */
export function weekRangeForOffset(today: string, offset: number): WeekRange {
  const thisMonday = mondayOf(today);
  const start = addDays(thisMonday, offset * 7);
  const end = addDays(start, 6);
  return { start, end };
}

/** 'YYYY-MM-DD' → 'M/D' 표시 포맷(주간/회고 표면 공용). */
export function monthDay(yyyymmdd: string): string {
  const [, m, d] = yyyymmdd.split("-");
  return `${Number(m)}/${Number(d)}`;
}

/**
 * 날짜 달린 항목들을 today 기준 주 offset(-(WEEKS_WINDOW-1)..0) 버킷으로 분배(순수).
 * 윈도우 밖(미래·12주 이전) 날짜는 버린다. 모든 offset 키가 빈 배열로라도 존재한다.
 */
export function bucketByWeekOffset<T>(
  entries: { date: string; value: T }[],
  today: string,
): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (let o = -(WEEKS_WINDOW - 1); o <= 0; o++) map.set(o, []);
  const thisMonday = parseLocalISODate(mondayOf(today)).getTime();
  const weekMs = 7 * 24 * 3600 * 1000;
  for (const { date, value } of entries) {
    const monday = parseLocalISODate(mondayOf(date)).getTime();
    const offset = Math.round((monday - thisMonday) / weekMs);
    if (offset > 0 || offset < -(WEEKS_WINDOW - 1)) continue;
    map.get(offset)!.push(value);
  }
  return map;
}

/** ISO-8601 주 번호(목요일 기준). */
export function isoWeekNumber(yyyymmdd: string): number {
  const dt = parseLocalISODate(yyyymmdd);
  const target = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const dayNr = (target.getDay() + 6) % 7; // Mon=0..Sun=6
  target.setDate(target.getDate() - dayNr + 3); // 그 주의 목요일
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  const firstDayNr = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() - firstDayNr + 3);
  const diff = target.getTime() - firstThursday.getTime();
  return 1 + Math.round(diff / (7 * 24 * 3600 * 1000));
}
