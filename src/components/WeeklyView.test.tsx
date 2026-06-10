import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { LifeWheelTagConfig, WorkSignal } from "@/bindings";

import { LifeWheelRadar } from "./weekly/LifeWheelRadar";

// Weekly Review 재설계 hero 레이더(LifeWheelRadar)의 렌더-세이프 검증. 비싼 setup(jsdom/Tauri/
// react-query) 없이 react-dom/server SSR만 사용한다(dev WeeklyView.test의 LifeWheelHero 패턴 계승).
// recharts ResponsiveContainer는 SSR에서 측정 effect가 안 돌아 차트 SVG는 비지만, 범례·빈/sparse
// 카피·바 폴백 등 "근거 없는 분포를 가짜로 그리지 않는다"는 핵심 표시는 그대로 렌더된다.

function tag(id: string, enabled = true): LifeWheelTagConfig {
  return { id, label: id.toUpperCase(), color: "#3f7d5e", builtIn: true, enabled };
}

function sig(id: string, area: string | null): WorkSignal {
  return {
    id,
    projectId: null,
    title: id,
    body: null,
    source: "manual" as never,
    type: "task" as never,
    quadrant: "q2" as never,
    suggestedQuadrant: null,
    kind: "work" as never,
    area: area as never,
    areaTags: null,
    suggestedArea: null,
    status: "active" as never,
    snoozeUntil: null,
    todayForDate: null,
    todayDoneAt: "2026-06-10",
    todayRank: null,
    impactHigh: null,
    regret: null,
    scheduledAt: null,
    scheduledDuration: null,
    linkedEventId: null,
    linkedCalendarId: null,
    createdAt: "2026-06-10T00:00:00Z",
    updatedAt: "2026-06-10T00:00:00Z",
  };
}

const noop = () => {};

describe("LifeWheelRadar — 태그 0개(빈 팔레트)", () => {
  it("레이더 대신 설정 딥링크 안내만 렌더한다", () => {
    const html = renderToStaticMarkup(
      <LifeWheelRadar
        weekSignals={[]}
        trailingWeeks={[[], [], [], []]}
        tags={[]}
        onOpenSettings={noop}
      />,
    );
    expect(html).toContain("Life Wheel 태그가 없습니다");
    expect(html).toContain("설정에서 추가");
  });
});

describe("LifeWheelRadar — 빈 주간(confidence=empty)", () => {
  it("0 분포 폴리곤 대신 '집계할 활동이 없습니다' 카피만 렌더한다(가짜 균형 차단)", () => {
    const tags = [tag("health"), tag("family"), tag("career")];
    const html = renderToStaticMarkup(
      <LifeWheelRadar
        weekSignals={[]}
        trailingWeeks={[[], [], [], []]}
        tags={tags}
        onOpenSettings={noop}
      />,
    );
    expect(html).toContain("이번 주는 아직 집계할 활동이 없습니다");
    expect(html).not.toContain("4주 평균"); // 범례를 그리지 않음
  });
});

describe("LifeWheelRadar — 표본 빈약(confidence=sparse, 3+축=레이더)", () => {
  it("범례와 함께 '참고용' 표본-빈약 노트를 렌더한다", () => {
    const tags = [tag("health"), tag("family"), tag("career")];
    const html = renderToStaticMarkup(
      <LifeWheelRadar
        weekSignals={[sig("a", "health")]} // total 1 ≤ floor(2) → sparse
        trailingWeeks={[[], [], [], []]}
        tags={tags}
        onOpenSettings={noop}
      />,
    );
    expect(html).toContain("이번 주");
    expect(html).toContain("4주 평균");
    expect(html).toContain("표본 빈약 — 분포는 참고용");
  });
});

describe("LifeWheelRadar — 1~2축 바 폴백(measured)", () => {
  it("축 라벨과 count를 바로 렌더하고, 충분 표본이면 sparse 노트는 없다", () => {
    const tags = [tag("health"), tag("family")]; // 2축 → bars
    const html = renderToStaticMarkup(
      <LifeWheelRadar
        weekSignals={[sig("a", "health"), sig("b", "health"), sig("c", "family")]} // total 3 > floor → measured
        trailingWeeks={[[], [], [], []]}
        tags={tags}
        onOpenSettings={noop}
      />,
    );
    expect(html).toContain("HEALTH");
    expect(html).toContain("FAMILY");
    expect(html).not.toContain("표본 빈약");
  });
});
