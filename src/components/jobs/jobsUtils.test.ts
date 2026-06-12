import { describe, expect, it } from "vitest";

import { isPinnedToBottom, runDurationSec } from "./jobsUtils";

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

describe("jobsUtils — isPinnedToBottom(로그 follow 판정)", () => {
  it("정확히 바닥 → pinned", () => {
    expect(isPinnedToBottom(1000, 800, 200)).toBe(true);
  });

  it("임계(40px) 안쪽 → pinned, 바깥 → unpinned", () => {
    expect(isPinnedToBottom(1000, 761, 200)).toBe(true); // 잔여 39px
    expect(isPinnedToBottom(1000, 760, 200)).toBe(false); // 잔여 40px
    expect(isPinnedToBottom(1000, 0, 200)).toBe(false); // 맨 위
  });

  it("스크롤 불필요(내용 < 뷰포트) → pinned", () => {
    expect(isPinnedToBottom(100, 0, 200)).toBe(true);
  });

  it("커스텀 임계 존중", () => {
    expect(isPinnedToBottom(1000, 700, 200, 150)).toBe(true);
  });
});
