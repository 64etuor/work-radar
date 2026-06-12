import { describe, expect, it } from "vitest";

import { runDurationSec } from "./jobsUtils";

describe("jobsUtils — runDurationSec(SQLite UTC)", () => {
  it("정상 쌍: finished - started 초", () => {
    expect(runDurationSec("2026-06-12 10:00:00", "2026-06-12 10:01:30")).toBe(90);
  });

  it("타임스탬프 누락 → null (미시작/실행 중)", () => {
    expect(runDurationSec(null, "2026-06-12 10:01:30")).toBeNull();
    expect(runDurationSec("2026-06-12 10:00:00", null)).toBeNull();
    expect(runDurationSec(null, null)).toBeNull();
  });

  it("finished < started(시계 스큐) → null", () => {
    expect(runDurationSec("2026-06-12 10:02:00", "2026-06-12 10:01:00")).toBeNull();
  });

  it("파싱 불가 문자열 → null", () => {
    expect(runDurationSec("not-a-date", "2026-06-12 10:01:30")).toBeNull();
  });
});
