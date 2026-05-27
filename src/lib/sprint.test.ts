import { describe, expect, it } from "vitest";

import {
  formatCountdown,
  formatCountdownLabel,
  remainingSecondsUntil,
  WEEKDAY_LABELS,
} from "@/lib/sprint";

describe("sprint — 카운트다운 순수 헬퍼(P11)", () => {
  it("formatCountdown: 'D일 HH:MM' 포맷(분 단위, 초 버림)", () => {
    // 6일 9시간 0분 = 정확히 경계 정렬 케이스(Rust 단위테스트와 동일 값).
    const d = formatCountdown((6 * 24 + 9) * 3600);
    expect(d.text).toBe("6일 09:00");
    expect(d.compact).toBe("6일");
    expect(d.overdue).toBe(false);
  });

  it("formatCountdown: 시·분 패딩 + 초 버림", () => {
    const d = formatCountdown(2 * 86400 + 3 * 3600 + 5 * 60 + 59);
    expect(d.text).toBe("2일 03:05"); // 59초 버림
    expect(d.compact).toBe("2일");
  });

  it("formatCountdown: 0초 = '0일 00:00', overdue 아님", () => {
    const d = formatCountdown(0);
    expect(d.text).toBe("0일 00:00");
    expect(d.overdue).toBe(false);
  });

  it("formatCountdown: 음수 = overdue + 절댓값 포맷(색+라벨 병기 신호)", () => {
    const d = formatCountdown(-(1 * 86400 + 2 * 3600 + 30 * 60));
    expect(d.overdue).toBe(true);
    expect(d.text).toBe("1일 02:30");
    expect(d.compact).toBe("1일");
  });

  it("formatCountdownLabel: 헤더 문구에 일·시·분까지 표시", () => {
    expect(formatCountdownLabel(formatCountdown(2 * 86400 + 3 * 3600 + 5 * 60))).toBe(
      "2일 03:05 남음",
    );
    expect(formatCountdownLabel(formatCountdown(45 * 60))).toBe("0일 00:45 남음");
  });

  it("formatCountdownLabel: 음수 입력에도 지남 문구를 노출하지 않음", () => {
    expect(formatCountdownLabel(formatCountdown(-(1 * 86400 + 2 * 3600)))).toBe(
      "1일 02:00 남음",
    );
  });

  it("remainingSecondsUntil: 경계 - now(ms) 초 차이(양수=남음)", () => {
    const now = Date.parse("2026-05-23T12:00:00+09:00");
    const boundary = "2026-05-29T21:00:00+09:00";
    // 6일 9시간 = (6*24+9)*3600초.
    expect(remainingSecondsUntil(boundary, now)).toBe((6 * 24 + 9) * 3600);
  });

  it("remainingSecondsUntil: 경계가 과거면 음수(overdue)", () => {
    const now = Date.parse("2026-05-29T21:01:00+09:00");
    const boundary = "2026-05-29T21:00:00+09:00";
    expect(remainingSecondsUntil(boundary, now)).toBe(-60);
  });

  it("remainingSecondsUntil: 오프셋이 달라도 절대 인스턴트로 일관(표시 tick)", () => {
    // 같은 절대 순간을 다른 오프셋으로 표기 → 동일 결과.
    const now = Date.parse("2026-05-23T03:00:00Z"); // = 12:00 +09:00
    const boundary = "2026-05-29T21:00:00+09:00";
    expect(remainingSecondsUntil(boundary, now)).toBe((6 * 24 + 9) * 3600);
  });

  it("remainingSecondsUntil: 파싱 불가 → null(empty 처리)", () => {
    expect(remainingSecondsUntil("not-a-date")).toBeNull();
  });

  it("WEEKDAY_LABELS: bindings Weekday(snake_case) 키와 매칭", () => {
    expect(WEEKDAY_LABELS.fri).toBe("금");
    expect(Object.keys(WEEKDAY_LABELS)).toHaveLength(7);
  });
});
