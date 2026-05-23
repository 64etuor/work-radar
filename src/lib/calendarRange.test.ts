import { describe, expect, it } from "vitest";

import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  monthGridDays,
  startOfMonth,
  startOfWeek,
  stepDate,
  viewRange,
  weekDays,
} from "@/lib/calendarRange";

describe("calendarRange — 일/주/월 범위 경계(P7)", () => {
  it("addDays/addMonths: 월·연 경계 넘김(native Date 보정)", () => {
    expect(addDays("2026-05-31", 1)).toBe("2026-06-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addMonths("2026-01-31", 1)).toBe("2026-03-03"); // 1/31 +1달 → 2월 없음 → native 3/3
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
  });

  it("startOfWeek=월요일, endOfWeek=일요일(주 시작 요일)", () => {
    // 2026-05-21 = 목요일 → 주 시작 5/18(월), 끝 5/24(일).
    expect(startOfWeek("2026-05-21")).toBe("2026-05-18");
    expect(endOfWeek("2026-05-21")).toBe("2026-05-24");
    // 일요일은 같은 주의 끝(이전 월요일이 시작).
    expect(startOfWeek("2026-05-24")).toBe("2026-05-18");
    expect(endOfWeek("2026-05-24")).toBe("2026-05-24");
    // 월요일 자신.
    expect(startOfWeek("2026-05-18")).toBe("2026-05-18");
  });

  it("startOfMonth=1일, endOfMonth=말일(월 경계, 윤년 2월)", () => {
    expect(startOfMonth("2026-05-21")).toBe("2026-05-01");
    expect(endOfMonth("2026-05-21")).toBe("2026-05-31");
    // 2026-02는 28일(평년).
    expect(endOfMonth("2026-02-10")).toBe("2026-02-28");
    // 2028-02는 윤년 29일.
    expect(endOfMonth("2028-02-10")).toBe("2028-02-29");
  });

  it("viewRange: day/week/month 각 [start,end]", () => {
    expect(viewRange("day", "2026-05-21")).toEqual({
      start: "2026-05-21",
      end: "2026-05-21",
    });
    expect(viewRange("week", "2026-05-21")).toEqual({
      start: "2026-05-18",
      end: "2026-05-24",
    });
    expect(viewRange("month", "2026-05-21")).toEqual({
      start: "2026-05-01",
      end: "2026-05-31",
    });
  });

  it("stepDate: day=±1일, week=±7일, month=±1개월", () => {
    expect(stepDate("day", "2026-05-21", 1)).toBe("2026-05-22");
    expect(stepDate("day", "2026-05-21", -1)).toBe("2026-05-20");
    expect(stepDate("week", "2026-05-21", 1)).toBe("2026-05-28");
    expect(stepDate("week", "2026-05-21", -1)).toBe("2026-05-14");
    expect(stepDate("month", "2026-05-21", 1)).toBe("2026-06-21");
    expect(stepDate("month", "2026-05-21", -1)).toBe("2026-04-21");
  });

  it("weekDays=7일(월~일), monthGridDays=42칸(월요일 시작 6주)", () => {
    const wk = weekDays("2026-05-21");
    expect(wk).toHaveLength(7);
    expect(wk[0]).toBe("2026-05-18"); // 월
    expect(wk[6]).toBe("2026-05-24"); // 일

    const grid = monthGridDays("2026-05-21");
    expect(grid).toHaveLength(42);
    // 2026-05-01 = 금요일 → 그리드 시작은 그 주 월요일 4/27.
    expect(grid[0]).toBe("2026-04-27");
    // 첫 행 마지막(일요일) = 5/3.
    expect(grid[6]).toBe("2026-05-03");
  });
});
