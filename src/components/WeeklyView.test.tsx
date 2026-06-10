import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DebtPoint, WeeklyReview } from "@/bindings";

import { LifeWheelHero, md } from "./WeeklyView";

// WeeklyView ↔ weeklyLifeWheel 통합: 순수 헬퍼 출력이 렌더-세이프하게 표시되는지 검증한다.
// 비싼 setup(jsdom/Tauri) 없이 react-dom/server SSR만 사용한다(AskUserCard.test와 동일 패턴).
// recharts ResponsiveContainer는 SSR에서 측정 effect가 돌지 않아 차트 SVG는 비지만, 점수/인사이트
// 사이드 패널(렌더-세이프 포맷의 핵심)은 그대로 그려진다.

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

describe("md — 날짜 포맷 헬퍼", () => {
  it("YYYY-MM-DD를 선행 0 없는 M/D로 줄인다", () => {
    expect(md("2026-06-09")).toBe("6/9");
    expect(md("2026-12-25")).toBe("12/25");
    expect(md("2026-01-05")).toBe("1/5");
  });
});

describe("LifeWheelHero — 빈 주간 폴백(measuredCount=0)", () => {
  it("레이더 대신 '아직 집계할 활동이 없습니다' 카피만 렌더(오해 부르는 0/100 없음)", () => {
    const html = renderToStaticMarkup(<LifeWheelHero review={review()} />);
    expect(html).toContain("이번 주는 아직 집계할 활동이 없습니다");
    // 빈 주간엔 점수 카드/인사이트가 없어야 한다(0점을 그리지 않음).
    expect(html).not.toContain("전체 주간 점수");
    expect(html).not.toContain("강점 축");
    // 7축 중 0축만 채워짐을 헤더에 명시.
    expect(html).toContain("0/7축");
  });
});

describe("LifeWheelHero — 집계 있는 주간(weeklyLifeWheel 매핑 소비)", () => {
  it("전체 점수·채워진 축 수·강점/취약 인사이트를 렌더한다", () => {
    // flow 100(captured 7), execution ~29(completed 2), promotion empty(0).
    const html = renderToStaticMarkup(
      <LifeWheelHero review={review({ throughput: { captured: 7, completed: 2, promoted: 0 } })} />,
    );
    expect(html).toContain("전체 주간 점수");
    expect(html).toContain("강점 축");
    expect(html).toContain("흐름 (캡처)"); // best 축 라벨
    expect(html).toContain("취약 축");
    expect(html).toContain("실행 (완료)"); // weakest 축 라벨
    // measured 2 + 나머지 empty → 부분 집계 배지.
    expect(html).toContain("부분 집계");
    expect(html).toContain("/7축");
  });

  it("score=null 인 인사이트(부채 움직임/루틴)는 0이 아니라 '—'로 렌더한다", () => {
    // 부채 추세·루틴 없음 → momentum/routine empty.
    const html = renderToStaticMarkup(
      <LifeWheelHero review={review({ throughput: { captured: 7, completed: 0, promoted: 0 } })} />,
    );
    expect(html).toContain("부채 움직임");
    expect(html).toContain("루틴 이행");
    expect(html).toContain("—");
    // empty 인사이트엔 '데이터 없음' confidence 배지가 붙는다(sparse-data 카피).
    expect(html).toContain("데이터 없음");
  });

  it("measured 축이 하나뿐이면 취약 축을 중복 표기하지 않는다", () => {
    // flow만 measured(captured 7), 나머지 empty → weakest===best → 취약 축 게이트로 숨김.
    const html = renderToStaticMarkup(
      <LifeWheelHero review={review({ throughput: { captured: 7, completed: 0, promoted: 0 } })} />,
    );
    expect(html).toContain("강점 축");
    expect(html).not.toContain("취약 축");
  });

  it("부채 추세가 줄면 모멘텀 detail을 '감소'로 렌더한다(렌더-세이프 카피)", () => {
    const html = renderToStaticMarkup(
      <LifeWheelHero
        review={review({
          throughput: { captured: 7, completed: 0, promoted: 0 },
          debtTrend: [debtPoint({ unclassified: 8 }), debtPoint({ unclassified: 3 })],
        })}
      />,
    );
    expect(html).toContain("5 감소");
  });
});
