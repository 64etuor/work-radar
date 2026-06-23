import { describe, expect, it } from "vitest";

import { DAY_PX } from "@/lib/timelineAxis";

import { shouldExtend } from "./useTimelineScroll";

// 뷰포트/콘텐츠 더미 — 가장자리 근접만 변주한다. scrollHeight는 충분히 크게 둔다.
const TALL = DAY_PX * 10;
const base = { clientHeight: 800, scrollHeight: TALL, extending: false, dragActive: false };

describe("shouldExtend", () => {
  it("nearTop (scrollTop < DAY_PX/2) + 비드래그 → up", () => {
    expect(shouldExtend({ ...base, scrollTop: DAY_PX / 2 - 1 })).toBe("up");
  });

  it("nearBottom + 비드래그 → down", () => {
    // scrollTop + clientHeight > scrollHeight - DAY_PX/2
    const scrollTop = TALL - 800 - (DAY_PX / 2 - 1);
    expect(shouldExtend({ ...base, scrollTop })).toBe("down");
  });

  it("중앙(가장자리 아님) → null", () => {
    const scrollTop = Math.floor((TALL - 800) / 2);
    expect(shouldExtend({ ...base, scrollTop })).toBeNull();
  });

  it("dragActive면 가장자리여도 동결(null) — 앵커 시프트 방지", () => {
    expect(shouldExtend({ ...base, scrollTop: 0, dragActive: true })).toBeNull();
    const bottomScroll = TALL - 800;
    expect(shouldExtend({ ...base, scrollTop: bottomScroll, dragActive: true })).toBeNull();
  });

  it("extending 가드 진행 중이면 null(중복 확장 방지)", () => {
    expect(shouldExtend({ ...base, scrollTop: 0, extending: true })).toBeNull();
  });

  it("정확히 경계(scrollTop == DAY_PX/2)는 nearTop 아님 → null", () => {
    expect(shouldExtend({ ...base, scrollTop: DAY_PX / 2 })).toBeNull();
  });
});
