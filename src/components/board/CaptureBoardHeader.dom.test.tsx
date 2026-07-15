import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CaptureBoardHeader } from "./CaptureBoardHeader";

vi.mock("@/components/SprintTimer", () => ({
  SprintTimer: () => <span>Sprint 21m</span>,
}));

vi.mock("@/store", () => ({
  useUIStore: (selector: (state: { goTo: () => void }) => unknown) => selector({ goTo: vi.fn() }),
}));

describe("CaptureBoardHeader decision brief", () => {
  it("orders the capture workflow and its four live queues", () => {
    const html = renderToStaticMarkup(
      <CaptureBoardHeader
        brief={{ inbox: 4, decisions: 9, today: 3, routines: 2 }}
        okrQuarter="2026-Q3"
        okrObjectives={[]}
        okrCheckIns={[]}
      />,
    );

    expect(html).toContain("CAPTURE / DECIDE / EXECUTE");
    expect(html).toContain("<h1>Decision Board</h1>");
    expect(html).toContain("흩어진 신호를 붙이고, 직접 분류하고, 오늘의 실행으로 옮깁니다.");
    expect(html).toContain('aria-label="보드 현황"');

    const inboxIndex = html.indexOf("INBOX");
    const decisionIndex = html.indexOf("DECISIONS");
    const todayIndex = html.indexOf("TODAY");
    const routineIndex = html.indexOf("ROUTINES");

    expect(inboxIndex).toBeGreaterThan(-1);
    expect(inboxIndex).toBeLessThan(decisionIndex);
    expect(decisionIndex).toBeLessThan(todayIndex);
    expect(todayIndex).toBeLessThan(routineIndex);
    expect(html).toContain(">4<");
    expect(html).toContain(">9<");
    expect(html).toContain(">3<");
    expect(html).toContain(">2<");
  });
});
