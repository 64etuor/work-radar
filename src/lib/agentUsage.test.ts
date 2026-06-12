import { describe, expect, it } from "vitest";

import { effectiveUsedPercent, formatResetIn, usageTone, usageWindowLabel } from "./agentUsage";

describe("usageTone", () => {
  it("70/90 경계로 ok→warn→crit", () => {
    expect(usageTone(0)).toBe("ok");
    expect(usageTone(69.9)).toBe("ok");
    expect(usageTone(70)).toBe("warn");
    expect(usageTone(89.9)).toBe("warn");
    expect(usageTone(90)).toBe("crit");
    expect(usageTone(100)).toBe("crit");
  });
});

describe("usageWindowLabel", () => {
  it("백엔드 윈도 id를 마이크로 라벨로", () => {
    expect(usageWindowLabel("five_hour")).toBe("5H");
    expect(usageWindowLabel("weekly")).toBe("WK");
    expect(usageWindowLabel("other")).toBe("OTHER");
  });
});

describe("formatResetIn", () => {
  const now = Date.parse("2026-06-11T12:00:00Z");

  it("분/시간/일 단위로 compact 포맷", () => {
    expect(formatResetIn("2026-06-11T12:45:00Z", now)).toBe("45m");
    expect(formatResetIn("2026-06-11T16:12:00Z", now)).toBe("4h 12m");
    expect(formatResetIn("2026-06-11T15:00:00Z", now)).toBe("3h");
    expect(formatResetIn("2026-06-13T15:00:00Z", now)).toBe("2d 3h");
  });

  it("과거/없음/깨진 입력은 null", () => {
    expect(formatResetIn("2026-06-11T11:00:00Z", now)).toBeNull();
    expect(formatResetIn(null, now)).toBeNull();
    expect(formatResetIn("not-a-date", now)).toBeNull();
  });
});

describe("effectiveUsedPercent — resets_at 경과 시 0%", () => {
  const now = Date.parse("2026-06-12T09:30:00Z");

  it("리셋이 미래면 수치 그대로", () => {
    expect(effectiveUsedPercent(100, "2026-06-12T10:00:00Z", now)).toBe(100);
    expect(effectiveUsedPercent(35, "2026-06-19T00:00:00Z", now)).toBe(35);
  });

  it("리셋이 지났으면 0% (롤오버 — 옛 수치를 사실처럼 그리지 않음)", () => {
    expect(effectiveUsedPercent(100, "2026-06-12T09:00:00Z", now)).toBe(0);
    // 정확히 리셋 시각도 경과로 취급.
    expect(effectiveUsedPercent(80, "2026-06-12T09:30:00Z", now)).toBe(0);
  });

  it("resetsAt 없음/파싱 불가/percent null은 그대로 통과", () => {
    expect(effectiveUsedPercent(42, null, now)).toBe(42);
    expect(effectiveUsedPercent(42, "not-a-date", now)).toBe(42);
    expect(effectiveUsedPercent(null, "2026-06-12T09:00:00Z", now)).toBeNull();
  });
});
