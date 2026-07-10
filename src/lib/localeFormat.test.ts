import { describe, expect, it } from "vitest";

import {
  formatMonthDay,
  WEEKDAY_SHORT_BY_CODE,
  WEEKDAY_SHORT_MON_FIRST,
  WEEKDAY_SHORT_SUN_FIRST,
} from "@/lib/localeFormat";

describe("localeFormat — 로케일 파생 라벨 단일 노브", () => {
  it("MON_FIRST는 월요일부터 7개", () => {
    expect(WEEKDAY_SHORT_MON_FIRST).toHaveLength(7);
    expect(WEEKDAY_SHORT_MON_FIRST[0]).toBe(WEEKDAY_SHORT_BY_CODE.mon);
    expect(WEEKDAY_SHORT_MON_FIRST[6]).toBe(WEEKDAY_SHORT_BY_CODE.sun);
  });

  // SUN_FIRST는 `Date#getDay()`(0=일요일) 인덱스로 소비된다(CalendarDrawer/HistoryRail).
  // 회전식 `(i+6)%7`의 off-by-one이 나면 요일 라벨이 통째로 밀린다 — 여기서 고정한다.
  it("SUN_FIRST는 getDay() 인덱스와 정렬된다", () => {
    expect(WEEKDAY_SHORT_SUN_FIRST).toHaveLength(7);
    expect(WEEKDAY_SHORT_SUN_FIRST[0]).toBe(WEEKDAY_SHORT_BY_CODE.sun);
    expect(WEEKDAY_SHORT_SUN_FIRST[1]).toBe(WEEKDAY_SHORT_BY_CODE.mon);
    expect(WEEKDAY_SHORT_SUN_FIRST[6]).toBe(WEEKDAY_SHORT_BY_CODE.sat);
    // 2026-07-12는 일요일 — 실제 Date 인덱싱과 대조.
    const sunday = new Date(2026, 6, 12);
    expect(sunday.getDay()).toBe(0);
    expect(WEEKDAY_SHORT_SUN_FIRST[sunday.getDay()]).toBe(WEEKDAY_SHORT_BY_CODE.sun);
  });

  // bindings의 `Weekday`(snake_case) 키와 매칭 — SprintTimer/TimelineCanvas가 코드로 색인한다.
  it("BY_CODE는 bindings Weekday(snake_case) 키 7개", () => {
    expect(Object.keys(WEEKDAY_SHORT_BY_CODE)).toHaveLength(7);
    expect(WEEKDAY_SHORT_BY_CODE.fri).toBe("금");
  });

  // 윤년 2/29가 유효해야 한다(내부 앵커가 윤년 고정인 이유).
  it("formatMonthDay는 2/29를 포함해 월-일을 로케일 포맷한다", () => {
    expect(formatMonthDay(7, 10)).toBe("7월 10일");
    expect(formatMonthDay(2, 29)).toBe("2월 29일");
  });
});
