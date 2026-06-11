import { describe, expect, it } from "vitest";

import { extendDates, includeDate } from "./timelineWindow";

describe("timelineWindow", () => {
  it("extendDates: 위/아래로 하루씩 연속 확장", () => {
    const base = ["2026-06-10", "2026-06-11", "2026-06-12"];
    expect(extendDates(base, "up", 21)[0]).toBe("2026-06-09");
    expect(extendDates(base, "down", 21)[3]).toBe("2026-06-13");
  });

  it("extendDates: 캡 도달 시 확장 중단(축출 없음) — today가 절대 빠지지 않는다", () => {
    const base = ["2026-06-10", "2026-06-11", "2026-06-12"];
    const capped = extendDates(base, "down", 3);
    expect(capped).toBe(base); // 무변경 — 어느 쪽 끝도 drop되지 않음
    expect(capped).toContain("2026-06-11");
  });

  it("includeDate: 범위 밖 날짜까지 연속 확장(캡 비적용), 범위 안이면 무변경", () => {
    const base = ["2026-06-10", "2026-06-11", "2026-06-12"];
    const past = includeDate(base, "2026-06-07");
    expect(past[0]).toBe("2026-06-07");
    expect(past).toHaveLength(6);
    // 연속성 검증
    expect(past).toEqual([
      "2026-06-07",
      "2026-06-08",
      "2026-06-09",
      "2026-06-10",
      "2026-06-11",
      "2026-06-12",
    ]);
    expect(includeDate(base, "2026-06-11")).toBe(base);
    expect(includeDate(base, "2026-06-14")[4]).toBe("2026-06-14");
  });
});
