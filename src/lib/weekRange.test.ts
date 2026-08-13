// src/lib/weekRange.test.ts
import { describe, expect, it } from "vitest";

import {
  bucketByWeekOffset,
  isoWeekNumber,
  mondayOf,
  monthDay,
  weekRangeForOffset,
  WEEKS_WINDOW,
} from "./weekRange";

describe("mondayOf", () => {
  it("returns Monday for a mid-week date", () => {
    expect(mondayOf("2026-06-10")).toBe("2026-06-08"); // Wed → Mon
  });
  it("returns same date when already Monday", () => {
    expect(mondayOf("2026-06-08")).toBe("2026-06-08");
  });
  it("handles Sunday (week's last day)", () => {
    expect(mondayOf("2026-06-14")).toBe("2026-06-08"); // Sun → that week's Mon
  });
});

describe("weekRangeForOffset", () => {
  const today = "2026-06-10"; // Wed, week Mon 6/8 – Sun 6/14
  it("offset 0 = current week Mon..Sun", () => {
    expect(weekRangeForOffset(today, 0)).toEqual({ start: "2026-06-08", end: "2026-06-14" });
  });
  it("offset -1 = previous week", () => {
    expect(weekRangeForOffset(today, -1)).toEqual({ start: "2026-06-01", end: "2026-06-07" });
  });
  it("offset -2 = two weeks back", () => {
    expect(weekRangeForOffset(today, -2)).toEqual({ start: "2026-05-25", end: "2026-05-31" });
  });
});

describe("isoWeekNumber", () => {
  it("computes ISO week of year", () => {
    expect(isoWeekNumber("2026-06-10")).toBe(24);
  });
});

describe("WEEKS_WINDOW", () => {
  it("is 12", () => {
    expect(WEEKS_WINDOW).toBe(12);
  });
});

describe("monthDay", () => {
  it("YYYY-MM-DD를 M/D로 (0 패딩 제거)", () => {
    expect(monthDay("2026-06-09")).toBe("6/9");
    expect(monthDay("2026-12-31")).toBe("12/31");
  });
});

describe("bucketByWeekOffset", () => {
  // 2026-06-11(목): 이번 주 = 6/8(월)–6/14(일)
  const today = "2026-06-11";

  it("이번 주/지난주/주 경계(월·일요일)를 올바른 offset에 담는다", () => {
    const map = bucketByWeekOffset(
      [
        { date: "2026-06-08", value: "mon-cur" }, // 이번 주 월요일
        { date: "2026-06-14", value: "sun-cur" }, // 이번 주 일요일
        { date: "2026-06-07", value: "sun-prev" }, // 지난주 일요일
      ],
      today,
    );
    expect(map.get(0)).toEqual(["mon-cur", "sun-cur"]);
    expect(map.get(-1)).toEqual(["sun-prev"]);
  });

  it("윈도우 밖(미래·12주 이전)은 버리고, 모든 offset 키는 빈 배열로 존재한다", () => {
    const map = bucketByWeekOffset(
      [
        { date: "2026-06-15", value: "future" }, // 다음 주 월요일
        { date: "2024-01-01", value: "ancient" },
      ],
      today,
    );
    expect(map.size).toBe(WEEKS_WINDOW);
    for (const [, v] of map) expect(v).toEqual([]);
  });

  it("가장 오래된 주(offset -(WEEKS_WINDOW-1)) 시작일은 포함된다", () => {
    const oldestStart = weekRangeForOffset(today, -(WEEKS_WINDOW - 1)).start;
    const map = bucketByWeekOffset([{ date: oldestStart, value: "edge" }], today);
    expect(map.get(-(WEEKS_WINDOW - 1))).toEqual(["edge"]);
  });

  it("잘못된 날짜 항목은 크래시하지 않고 버린다", () => {
    const map = bucketByWeekOffset([{ date: "not-a-date", value: "invalid" }], today);
    expect([...map.values()].flat()).toEqual([]);
  });
});
