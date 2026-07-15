import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { RoutineTrackingItem } from "@/bindings";

import { RoutineTrackingView } from "./RoutineTrackingView";

const mocks: { trackingItems: RoutineTrackingItem[] } = vi.hoisted(() => ({
  trackingItems: [],
}));

vi.mock("@/components/board/LifeWheelPalette", () => ({
  KindAreaChips: () => <span>분류</span>,
}));

vi.mock("@/lib/query", () => ({
  localToday: () => "2026-07-15",
  useLifeWheelTags: () => ({ data: [] }),
  useRoutineTracking: () => ({
    data: mocks.trackingItems,
    error: null,
    isError: false,
    isLoading: false,
  }),
}));

vi.mock("@/lib/useScrollRestore", () => ({
  useScrollRestore: () => ({ current: null }),
}));

vi.mock("@/lib/useViewSessionState", () => ({
  useViewSessionState: () => [30, vi.fn()],
}));

function routine(overrides: Partial<RoutineTrackingItem>): RoutineTrackingItem {
  return {
    id: "routine-1",
    title: "뉴스 읽기",
    freq: "daily",
    area: "studies",
    areaTags: null,
    kind: "personal",
    due: 8,
    done: 4,
    ratePct: 50,
    streak: 3,
    history: [
      { date: "2026-07-14", done: false },
      { date: "2026-07-15", done: true },
    ],
    ...overrides,
  };
}

describe("RoutineTrackingView editorial scorecard", () => {
  it("renders weighted adherence and streak coverage when routine schedules differ", () => {
    mocks.trackingItems = [
      routine({}),
      routine({
        id: "routine-2",
        title: "주간 회고",
        freq: "weekly",
        due: 2,
        done: 2,
        ratePct: 100,
        streak: 0,
      }),
    ];

    const html = renderToStaticMarkup(<RoutineTrackingView />);

    expect(html).toContain('aria-label="전체 이행률 60%"');
    expect(html).toContain('aria-label="완료 기록 6/10"');
    expect(html).toContain('aria-label="연속 달성 중인 루틴 1개"');
    expect(html).toContain('aria-label="뉴스 읽기 루틴 성과"');
    expect(html).toContain('aria-label="7/15 완료"');
  });
});
