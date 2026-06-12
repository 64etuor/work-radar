import { describe, expect, it } from "vitest";

import {
  BOX_MAX_PX,
  BOX_MIN_PX,
  boxWidth,
  formatElapsedCompact,
  overflowSplit,
  progressRatio,
  UNBOUNDED_SATURATE_SEC,
} from "@/lib/agentBar";

describe("agentBar — 경과 → 진행 ratio(P10a)", () => {
  it("timeout 있는 잡: elapsed/timeout, 0~1 클램프", () => {
    expect(progressRatio(0, 100)).toBe(0);
    expect(progressRatio(50, 100)).toBe(0.5);
    expect(progressRatio(100, 100)).toBe(1);
    // 상한 초과 → 1로 포화(무한 증가 금지).
    expect(progressRatio(200, 100)).toBe(1);
    // 음수 경과 → 0.
    expect(progressRatio(-5, 100)).toBe(0);
  });

  it("ratio는 경과에 대해 단조 증가 + 상한 포화", () => {
    const seq = [0, 25, 50, 75, 100, 150].map((s) => progressRatio(s, 100));
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
    }
    expect(seq[seq.length - 1]).toBe(1); // 결국 포화.
  });

  it("timeout 없는 세션(hermes/cmux): saturateSec 기준 경과만으로 채움", () => {
    // 기본 상한 30분 → 절반(15분)에서 0.5.
    expect(progressRatio(UNBOUNDED_SATURATE_SEC / 2, null)).toBeCloseTo(0.5, 5);
    expect(progressRatio(UNBOUNDED_SATURATE_SEC, null)).toBe(1);
    // 상한 도달 후 더 흘러도 포화 유지.
    expect(progressRatio(UNBOUNDED_SATURATE_SEC * 3, null)).toBe(1);
    // 커스텀 saturateSec.
    expect(progressRatio(60, null, 120)).toBe(0.5);
  });

  it("timeout<=0 이면 saturateSec로 폴백(0 나눗셈 방지)", () => {
    expect(progressRatio(60, 0, 120)).toBe(0.5);
    expect(progressRatio(60, -10, 120)).toBe(0.5);
  });
});

describe("agentBar — 경과 → 박스 width(P10a)", () => {
  it("idle: 항상 초기 width(경과 무시)", () => {
    expect(boxWidth(0, false)).toBe(BOX_MIN_PX);
    expect(boxWidth(0.7, false)).toBe(BOX_MIN_PX);
    expect(boxWidth(1, false)).toBe(BOX_MIN_PX);
  });

  it("working: 초기 width에서 단조 증가 + 상한 포화", () => {
    expect(boxWidth(0, true)).toBe(BOX_MIN_PX);
    expect(boxWidth(1, true)).toBe(BOX_MAX_PX);
    const mid = boxWidth(0.5, true);
    expect(mid).toBeGreaterThan(BOX_MIN_PX);
    expect(mid).toBeLessThan(BOX_MAX_PX);

    const seq = [0, 0.25, 0.5, 0.75, 1].map((r) => boxWidth(r, true));
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeGreaterThanOrEqual(seq[i - 1]);
    }
  });

  it("working: ratio>1 도 상한에서 포화(무한 증가 금지)", () => {
    expect(boxWidth(2, true)).toBe(BOX_MAX_PX);
    expect(boxWidth(-1, true)).toBe(BOX_MIN_PX);
  });

  it("커스텀 min/max 경계 존중", () => {
    expect(boxWidth(0, true, 50, 150)).toBe(50);
    expect(boxWidth(1, true, 50, 150)).toBe(150);
    expect(boxWidth(0.5, true, 50, 150)).toBe(100);
  });
});

describe("agentBar — 개수 상한 + '+N' 오버플로(P10a)", () => {
  it("상한 이하: 전부 표시, 오버플로 없음", () => {
    expect(overflowSplit(0)).toEqual({ visibleCount: 0, overflow: 0 });
    expect(overflowSplit(3)).toEqual({ visibleCount: 3, overflow: 0 });
    expect(overflowSplit(8)).toEqual({ visibleCount: 8, overflow: 0 });
  });

  it("상한 초과: max개 표시 + 나머지 '+N'", () => {
    expect(overflowSplit(9)).toEqual({ visibleCount: 8, overflow: 1 });
    expect(overflowSplit(12)).toEqual({ visibleCount: 8, overflow: 4 });
  });

  it("커스텀 max", () => {
    expect(overflowSplit(5, 3)).toEqual({ visibleCount: 3, overflow: 2 });
    expect(overflowSplit(2, 3)).toEqual({ visibleCount: 2, overflow: 0 });
  });

  it("음수/소수 입력 방어", () => {
    expect(overflowSplit(-1)).toEqual({ visibleCount: 0, overflow: 0 });
    expect(overflowSplit(8.7)).toEqual({ visibleCount: 8, overflow: 0 });
  });
});

describe("agentBar — 경과 컴팩트 라벨", () => {
  it("초/분/시 단계별 포맷", () => {
    expect(formatElapsedCompact(0)).toBe("0s");
    expect(formatElapsedCompact(42)).toBe("42s");
    expect(formatElapsedCompact(60)).toBe("1m");
    expect(formatElapsedCompact(12 * 60 + 30)).toBe("12m");
    expect(formatElapsedCompact(3600)).toBe("1h 0m");
    expect(formatElapsedCompact(3600 + 24 * 60)).toBe("1h 24m");
  });

  it("음수/NaN 방어 → 0s", () => {
    expect(formatElapsedCompact(-5)).toBe("0s");
    expect(formatElapsedCompact(Number.NaN)).toBe("0s");
  });
});
