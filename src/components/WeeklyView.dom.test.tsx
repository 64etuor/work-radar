import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WeeklyReview } from "@/bindings";

import { WeeklyView } from "./WeeklyView";

const review: WeeklyReview = {
  start: "2026-07-13",
  end: "2026-07-19",
  throughput: { captured: 3, completed: 5, promoted: 1 },
  prActivity: { attentionNew: 2, resolved: 4 },
  routineAdherence: { due: 12, done: 9, ratePct: 75 },
  debtTrend: [],
  timeSpent: { totalMin: 420, byArea: [{ area: "work", totalMin: 420 }] },
};

vi.mock("@/lib/okr", () => ({
  uncheckedKrCount: () => 2,
  weekStartMonday: () => "2026-07-13",
}));

vi.mock("@/lib/query", () => ({
  useCompleted: () => ({ data: [] }),
  useLifeWheelTags: () => ({ data: [] }),
  useObjectives: () => ({ data: [] }),
  useOkrCheckIns: () => ({ data: [] }),
  useRoutineTracking: () => ({ data: [] }),
  useWeeklyReview: () => ({ data: review, error: null, isError: false }),
}));

vi.mock("@/lib/useScrollRestore", () => ({
  useScrollRestore: () => ({ current: null }),
}));

vi.mock("@/lib/useWeekNav", () => ({
  useWeekNav: () => ({
    today: "2026-07-15",
    offset: 0,
    range: { start: "2026-07-13", end: "2026-07-19" },
    isCurrent: true,
    isOldest: false,
    prev: vi.fn(),
    next: vi.fn(),
    reset: vi.fn(),
    goto: vi.fn(),
  }),
}));

vi.mock("@/store", () => ({
  useUIStore: (selector: (state: { goTo: (view: string) => void }) => unknown) =>
    selector({ goTo: vi.fn() }),
}));

vi.mock("@/components/weekly/SystemDiagnosis", () => ({
  SystemDiagnosis: () => <div>주간 목표와 스프린트</div>,
}));

vi.mock("@/components/weekly/LifeOsAdvisorPanel", () => ({
  LifeOsAdvisorPanel: () => <div>Life OS 추천</div>,
}));

vi.mock("@/components/weekly/LifeWheelRadar", () => ({
  LifeWheelRadar: () => <div>Life Wheel 분포</div>,
}));

vi.mock("@/components/weekly/ReflectionSection", () => ({
  CompletedList: () => <div>완료한 일 목록</div>,
  ReflectionRank: () => <div>회고 태깅</div>,
}));

vi.mock("@/components/weekly/ArchiveAccordion", () => ({
  ArchiveAccordion: () => <div>보관함</div>,
}));

describe("WeeklyView editorial briefing", () => {
  it("orders weekly direction, evidence, completion, and reflection as one review narrative", () => {
    const html = renderToStaticMarkup(<WeeklyView />);

    expect(html).toContain("REVIEW / WEEKLY BRIEFING");
    expect(html).toContain("<h1>Weekly Review</h1>");
    expect(html).toContain('aria-label="주간 실행 증거"');
    expect(html).toContain("FLOW");
    expect(html).toContain("ROUTINE");
    expect(html).toContain("PULL REQUESTS");
    expect(html).toContain("FOCUSED TIME");

    const promptIndex = html.indexOf("OKR 체크인 2개 남음");
    const directionIndex = html.indexOf("이번 주 방향");
    const evidenceIndex = html.indexOf("이번 주 증거");
    const balanceIndex = html.indexOf("균형과 부채");
    const completionIndex = html.indexOf("완료한 일 목록");
    const reflectionIndex = html.indexOf("회고 태깅");

    expect(promptIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeLessThan(directionIndex);
    expect(directionIndex).toBeLessThan(evidenceIndex);
    expect(evidenceIndex).toBeLessThan(balanceIndex);
    expect(completionIndex).toBeLessThan(reflectionIndex);
  });
});
