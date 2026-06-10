import { describe, expect, it } from "vitest";

import type { DebtPoint, WeeklyReview } from "@/bindings";
import {
  computeWeeklyLifeWheel,
  DEFAULT_LIFE_WHEEL_TARGETS,
  deriveLifeWheelInsights,
  type LifeWheelAxisId,
} from "@/lib/weeklyLifeWheel";

function debtPoint(over: Partial<DebtPoint> = {}): DebtPoint {
  return {
    date: "2026-06-01",
    unclassified: 0,
    q1Overdue: 0,
    staleBacklog: 0,
    cleanupNeeded: 0,
    prAttention: 0,
    ...over,
  };
}

function review(over: Partial<WeeklyReview> = {}): WeeklyReview {
  return {
    start: "2026-06-03",
    end: "2026-06-09",
    throughput: { captured: 0, completed: 0, promoted: 0 },
    prActivity: { attentionNew: 0, resolved: 0 },
    routineAdherence: { due: 0, done: 0, ratePct: 0 },
    debtTrend: [],
    ...over,
  };
}

function axis(wheel: ReturnType<typeof computeWeeklyLifeWheel>, id: LifeWheelAxisId) {
  const a = wheel.axes.find((x) => x.id === id);
  if (!a) throw new Error(`axis ${id} missing`);
  return a;
}

describe("computeWeeklyLifeWheel — 축 구성", () => {
  it("항상 7축을 고정 순서로 낸다", () => {
    const wheel = computeWeeklyLifeWheel(review());
    expect(wheel.axes.map((a) => a.id)).toEqual([
      "flow",
      "execution",
      "promotion",
      "pr_hygiene",
      "routine",
      "debt_health",
      "cleanup_momentum",
    ]);
  });
});

describe("zero/sparse — 오해 부르는 100 대신 empty/sparse", () => {
  it("완전 빈 주간: 모든 축 empty(score=null), overall=null, measuredCount=0", () => {
    const wheel = computeWeeklyLifeWheel(review());
    for (const a of wheel.axes) {
      expect(a.score).toBeNull();
      expect(a.confidence).toBe("empty");
    }
    expect(wheel.overall).toBeNull();
    expect(wheel.measuredCount).toBe(0);
  });

  it("핵심 케이스: due=0 루틴은 100%가 아니라 empty", () => {
    // done>due 같은 모순 입력에서도 due=0이면 근거 없음으로 처리.
    const wheel = computeWeeklyLifeWheel(
      review({ routineAdherence: { due: 0, done: 5, ratePct: 0 } }),
    );
    const r = axis(wheel, "routine");
    expect(r.score).toBeNull();
    expect(r.confidence).toBe("empty");
  });

  it("PR 활동 0건이면 pr_hygiene는 empty(0점 아님)", () => {
    const wheel = computeWeeklyLifeWheel(review());
    const pr = axis(wheel, "pr_hygiene");
    expect(pr.score).toBeNull();
    expect(pr.confidence).toBe("empty");
  });

  it("throughput 적은 값(≤sparseFloor)은 sparse 로 플래그하되 점수는 낸다", () => {
    const wheel = computeWeeklyLifeWheel(
      review({ throughput: { captured: 1, completed: 2, promoted: 0 } }),
    );
    expect(axis(wheel, "flow").confidence).toBe("sparse");
    expect(axis(wheel, "execution").confidence).toBe("sparse");
    // promoted=0 → empty
    expect(axis(wheel, "promotion").score).toBeNull();
  });

  it("debtTrend 1일치뿐이면 cleanup_momentum은 empty(2일 필요), debt_health는 sparse", () => {
    const wheel = computeWeeklyLifeWheel(review({ debtTrend: [debtPoint({ unclassified: 3 })] }));
    expect(axis(wheel, "cleanup_momentum").score).toBeNull();
    expect(axis(wheel, "cleanup_momentum").confidence).toBe("empty");
    expect(axis(wheel, "debt_health").confidence).toBe("sparse");
    expect(axis(wheel, "debt_health").score).not.toBeNull();
  });

  it("부채가 창 전체에서 0이면 모멘텀은 산출 근거 없음 → empty", () => {
    const wheel = computeWeeklyLifeWheel(
      review({ debtTrend: [debtPoint(), debtPoint({ date: "2026-06-02" })] }),
    );
    expect(axis(wheel, "cleanup_momentum").score).toBeNull();
  });
});

describe("점수 의미", () => {
  it("flow: 목표 도달이면 100, 절반이면 ~50, 초과는 100으로 cap", () => {
    const full = computeWeeklyLifeWheel(
      review({ throughput: { captured: 7, completed: 0, promoted: 0 } }),
    );
    expect(axis(full, "flow").score).toBe(100);
    expect(axis(full, "flow").confidence).toBe("measured");

    const over = computeWeeklyLifeWheel(
      review({ throughput: { captured: 20, completed: 0, promoted: 0 } }),
    );
    expect(axis(over, "flow").score).toBe(100);

    const half = computeWeeklyLifeWheel(
      review({ throughput: { captured: 4, completed: 0, promoted: 0 } }),
    );
    expect(axis(half, "flow").score).toBe(57); // round(4/7*100)
  });

  it("pr_hygiene: 정리 비율(resolved/(new+resolved))", () => {
    const wheel = computeWeeklyLifeWheel(review({ prActivity: { attentionNew: 1, resolved: 3 } }));
    const pr = axis(wheel, "pr_hygiene");
    expect(pr.score).toBe(75);
    expect(pr.confidence).toBe("measured");
  });

  it("routine: done/due 비율(due가 충분하면 measured)", () => {
    const wheel = computeWeeklyLifeWheel(
      review({ routineAdherence: { due: 10, done: 7, ratePct: 70 } }),
    );
    const r = axis(wheel, "routine");
    expect(r.score).toBe(70);
    expect(r.confidence).toBe("measured");
  });

  it("debt_health: 부채 0이면 100, tolerance 이상이면 0(역포화)", () => {
    const clean = computeWeeklyLifeWheel(
      review({ debtTrend: [debtPoint(), debtPoint(), debtPoint()] }),
    );
    expect(axis(clean, "debt_health").score).toBe(100);
    expect(axis(clean, "debt_health").confidence).toBe("measured");

    const heavy = computeWeeklyLifeWheel(
      review({
        debtTrend: [
          debtPoint(),
          debtPoint(),
          debtPoint({ unclassified: 10, q1Overdue: 5, staleBacklog: 5 }), // load 20 ≥ tol 15
        ],
      }),
    );
    expect(axis(heavy, "debt_health").score).toBe(0);
  });

  it("cleanup_momentum: 부채 감소=개선(>50), 증가=악화(<50), 변화없음=50", () => {
    const improving = computeWeeklyLifeWheel(
      review({
        debtTrend: [
          debtPoint({ unclassified: 8 }),
          debtPoint({ unclassified: 4 }),
          debtPoint({ unclassified: 0 }), // 8 → 0, improvement +8 == momentumScale → 100
        ],
      }),
    );
    expect(axis(improving, "cleanup_momentum").score).toBe(100);

    const worsening = computeWeeklyLifeWheel(
      review({
        debtTrend: [debtPoint({ unclassified: 0 }), debtPoint({ unclassified: 8 })],
      }),
    );
    expect(axis(worsening, "cleanup_momentum").score).toBe(0);

    const flat = computeWeeklyLifeWheel(
      review({
        debtTrend: [debtPoint({ unclassified: 3 }), debtPoint({ unclassified: 3 })],
      }),
    );
    expect(axis(flat, "cleanup_momentum").score).toBe(50);
    expect(axis(flat, "cleanup_momentum").detail).toBe("변화 없음");
  });

  it("overall: 근거 있는 축만 평균(empty 제외)", () => {
    const wheel = computeWeeklyLifeWheel(
      review({ throughput: { captured: 7, completed: 7, promoted: 3 } }),
    );
    // flow/execution/promotion = 100 each, 나머지 4축 empty
    expect(wheel.measuredCount).toBe(3);
    expect(wheel.overall).toBe(100);
  });
});

describe("deriveLifeWheelInsights — 인사이트 카드 파생", () => {
  it("완전 빈 주간: best/weakest=null, momentum/routine은 empty 축 객체로 존재", () => {
    const insights = deriveLifeWheelInsights(computeWeeklyLifeWheel(review()));
    expect(insights.best).toBeNull();
    expect(insights.weakest).toBeNull();
    expect(insights.momentum?.id).toBe("cleanup_momentum");
    expect(insights.momentum?.confidence).toBe("empty");
    expect(insights.routine?.id).toBe("routine");
    expect(insights.routine?.confidence).toBe("empty");
  });

  it("강점=최고점 축, 취약=최저점 축(measured만 비교)", () => {
    // flow 100(captured 7), execution ~29(completed 2), promotion empty(0)
    const insights = deriveLifeWheelInsights(
      computeWeeklyLifeWheel(review({ throughput: { captured: 7, completed: 2, promoted: 0 } })),
    );
    expect(insights.best?.id).toBe("flow");
    expect(insights.best?.score).toBe(100);
    expect(insights.weakest?.id).toBe("execution");
    expect(insights.weakest?.score).toBe(29); // round(2/7*100)
  });

  it("measured 축이 하나뿐이면 best===weakest(호출부에서 중복 게이트)", () => {
    const insights = deriveLifeWheelInsights(
      computeWeeklyLifeWheel(review({ throughput: { captured: 7, completed: 0, promoted: 0 } })),
    );
    expect(insights.best?.id).toBe("flow");
    expect(insights.weakest?.id).toBe("flow");
  });
});

describe("sparse-data 카피 — empty/sparse 축의 detail·confidence 문자열(WeeklyView 배지/툴팁 정본)", () => {
  it("완전 빈 주간: 각 empty 축의 detail 카피가 오해 없는 '데이터 없음' 계열이다", () => {
    const wheel = computeWeeklyLifeWheel(review());
    expect(axis(wheel, "flow").detail).toBe("이번 주 데이터 없음");
    expect(axis(wheel, "execution").detail).toBe("이번 주 데이터 없음");
    expect(axis(wheel, "promotion").detail).toBe("이번 주 데이터 없음");
    expect(axis(wheel, "pr_hygiene").detail).toBe("PR 활동 없음");
    expect(axis(wheel, "routine").detail).toBe("예정 루틴 없음");
    expect(axis(wheel, "debt_health").detail).toBe("추세 데이터 없음");
    expect(axis(wheel, "cleanup_momentum").detail).toBe("모멘텀 산출에 최소 2일 필요");
  });

  it("measured/sparse 축의 detail은 카운트만 노출한다(PII/시크릿 없음)", () => {
    const wheel = computeWeeklyLifeWheel(
      review({
        throughput: { captured: 4, completed: 0, promoted: 0 },
        prActivity: { attentionNew: 1, resolved: 3 },
        routineAdherence: { due: 10, done: 7, ratePct: 70 },
        debtTrend: [debtPoint(), debtPoint(), debtPoint({ unclassified: 5 })],
      }),
    );
    expect(axis(wheel, "flow").detail).toBe("4 / 목표 7");
    expect(axis(wheel, "pr_hygiene").detail).toBe("정리 3 / 활동 4");
    expect(axis(wheel, "routine").detail).toBe("7/10");
    expect(axis(wheel, "debt_health").detail).toBe("미해결 부채 5");
  });

  it("cleanup_momentum detail은 방향을 한글로 명시한다(감소/증가/변화 없음)", () => {
    const down = computeWeeklyLifeWheel(
      review({ debtTrend: [debtPoint({ unclassified: 8 }), debtPoint({ unclassified: 3 })] }),
    );
    expect(axis(down, "cleanup_momentum").detail).toBe("5 감소");

    const up = computeWeeklyLifeWheel(
      review({ debtTrend: [debtPoint({ unclassified: 3 }), debtPoint({ unclassified: 8 })] }),
    );
    expect(axis(up, "cleanup_momentum").detail).toBe("5 증가");
  });

  it("부채 없는 빈 모멘텀의 detail은 '부채 없음 — 모멘텀 없음'이다", () => {
    const wheel = computeWeeklyLifeWheel(
      review({ debtTrend: [debtPoint(), debtPoint({ date: "2026-06-02" })] }),
    );
    expect(axis(wheel, "cleanup_momentum").detail).toBe("부채 없음 — 모멘텀 없음");
  });
});

describe("debtTrend 폴백 — 추세 0건은 두 부채 축 모두 empty(WeeklyView '쌓이는 중' 힌트 경로)", () => {
  it("debtTrend 빈 배열이면 debt_health·cleanup_momentum 둘 다 score=null·confidence=empty", () => {
    const wheel = computeWeeklyLifeWheel(review({ debtTrend: [] }));
    const dh = axis(wheel, "debt_health");
    const cm = axis(wheel, "cleanup_momentum");
    expect(dh.score).toBeNull();
    expect(dh.confidence).toBe("empty");
    expect(cm.score).toBeNull();
    expect(cm.confidence).toBe("empty");
  });
});

describe("render-safe 불변식 — null 아닌 점수는 항상 유한 정수 0..100", () => {
  // 레이더/배지/% 표기가 NaN·Infinity·소수·범위 밖 값을 그리지 않도록 보장한다.
  const cases: Array<[string, Partial<WeeklyReview>]> = [
    ["빈 주간", {}],
    ["포화 초과", { throughput: { captured: 999, completed: 999, promoted: 999 } }],
    ["소수 비율 routine", { routineAdherence: { due: 3, done: 1, ratePct: 33 } }],
    ["소수 비율 pr", { prActivity: { attentionNew: 2, resolved: 1 } }],
    ["급증하는 부채", { debtTrend: [debtPoint(), debtPoint({ unclassified: 50, q1Overdue: 50 })] }],
    ["음수 카운트 방어", { throughput: { captured: -3, completed: -1, promoted: -9 } }],
  ];

  for (const [name, over] of cases) {
    it(`${name}: 모든 축 score는 null 또는 정수 0..100, overall도 동일`, () => {
      const wheel = computeWeeklyLifeWheel(review(over));
      for (const a of wheel.axes) {
        if (a.score === null) continue;
        expect(Number.isInteger(a.score)).toBe(true);
        expect(a.score).toBeGreaterThanOrEqual(0);
        expect(a.score).toBeLessThanOrEqual(100);
      }
      if (wheel.overall !== null) {
        expect(Number.isInteger(wheel.overall)).toBe(true);
        expect(wheel.overall).toBeGreaterThanOrEqual(0);
        expect(wheel.overall).toBeLessThanOrEqual(100);
      }
      // measuredCount는 score!==null 축 수와 일치(레이더 "채워짐 정도" 정합).
      expect(wheel.measuredCount).toBe(wheel.axes.filter((a) => a.score !== null).length);
    });
  }
});

describe("방어성", () => {
  it("음수 카운트는 0으로 방어(crash 없이 empty)", () => {
    const wheel = computeWeeklyLifeWheel(
      review({ throughput: { captured: -5, completed: 0, promoted: 0 } }),
    );
    expect(axis(wheel, "flow").score).toBeNull();
  });

  it("override 타깃을 존중한다", () => {
    const wheel = computeWeeklyLifeWheel(
      review({ throughput: { captured: 3, completed: 0, promoted: 0 } }),
      { ...DEFAULT_LIFE_WHEEL_TARGETS, capture: 3 },
    );
    expect(axis(wheel, "flow").score).toBe(100);
  });
});
