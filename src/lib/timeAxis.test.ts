import { describe, expect, it } from "vitest";

import { absMin, addDays, dayDiff, isoFromAbsMin, localDateOf, tzOffsetForDate } from "./timeAxis";

describe("timeAxis", () => {
  it("dayDiff: 같은 날 0, 다음 날 1, 이전 날 -1, 월 경계", () => {
    expect(dayDiff("2026-06-11", "2026-06-11")).toBe(0);
    expect(dayDiff("2026-06-12", "2026-06-11")).toBe(1);
    expect(dayDiff("2026-06-10", "2026-06-11")).toBe(-1);
    expect(dayDiff("2026-07-01", "2026-06-30")).toBe(1);
  });

  it("addDays: 월/연 경계 통과", () => {
    expect(addDays("2026-06-30", 1)).toBe("2026-07-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2026-06-11", 0)).toBe("2026-06-11");
  });

  it("localDateOf: 로컬 ISO 앞 10자", () => {
    expect(localDateOf("2026-06-11T23:30:00+09:00")).toBe("2026-06-11");
    expect(localDateOf("2026-06-12T01:30:00")).toBe("2026-06-12");
  });

  it("absMin: 앵커 기준 절대 분 (자정 걸침이 양수 duration이 되는 근거)", () => {
    expect(absMin("2026-06-11T23:00:00", "2026-06-11")).toBe(23 * 60);
    expect(absMin("2026-06-12T01:30:00", "2026-06-11")).toBe(1440 + 90);
    expect(absMin("2026-06-10T23:00:00", "2026-06-11")).toBe(-60); // 앵커 이전 → 음수 허용
  });

  it("tzOffsetForDate: 해당 날짜 정오 기준 오프셋 문자열", () => {
    // KST 환경에서 +09:00. CI/로컬 모두 통과하도록 형식만 검증 + 자기일관성.
    expect(tzOffsetForDate("2026-06-11")).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(tzOffsetForDate("2026-06-11")).toBe(tzOffsetForDate("2026-06-12"));
  });

  it("isoFromAbsMin: 절대 분 → 날짜 넘김 포함 로컬 ISO(+offset)", () => {
    const off = tzOffsetForDate("2026-06-12");
    expect(isoFromAbsMin("2026-06-11", 1440 + 90)).toBe(`2026-06-12T01:30:00${off}`);
    expect(isoFromAbsMin("2026-06-11", 23 * 60)).toBe(
      `2026-06-11T23:00:00${tzOffsetForDate("2026-06-11")}`,
    );
  });
});
