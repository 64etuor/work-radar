/**
 * 연속 타임라인 visibleDates 윈도우 관리 — 순수 함수(TodayView가 소비).
 *
 * 캡(MAX_LOADED_DAYS)은 **확장 중단**이지 축출이 아니다: visibleDates는 항상 연속이고
 * 초기 멤버(today)와 네비 대상(date)은 절대 제거되지 않는다 — now 라인 소실/레일-캔버스
 * 버킷 불일치(critic MAJOR 2건)를 구조적으로 차단. 캡 도달 시 lazy-extend만 멈추고,
 * 날짜 네비(includeDate)는 의도적으로 캡을 넘어 확장할 수 있다(명시적 사용자 행동).
 */
import { addDays } from "./timeAxis";

/** 스크롤 lazy-extend — 캡 도달 시 무변경 반환(축출 없음). */
export function extendDates(prev: string[], dir: "up" | "down", max: number): string[] {
  if (prev.length >= max) return prev;
  return dir === "up"
    ? [addDays(prev[0], -1), ...prev]
    : [...prev, addDays(prev[prev.length - 1], 1)];
}

/** 날짜 네비 — 대상 날짜까지 연속으로 확장(이미 범위 안이면 무변경). 캡 비적용(명시적 이동). */
export function includeDate(prev: string[], date: string): string[] {
  let next = prev;
  while (date < next[0]) next = [addDays(next[0], -1), ...next];
  while (date > next[next.length - 1]) next = [...next, addDays(next[next.length - 1], 1)];
  return next;
}
