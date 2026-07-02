// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BookkeepingTabBar, BookkeepingTabPanel } from "./BookkeepingTabBar";
import { BOOKKEEPING_TABS, type BookkeepingTabId, tabPanelIdDom } from "./bookkeepingTabs";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

/** BookkeepingView의 탭 셸 구조 재현 — 탭 바 + 다섯 패널 전부 항상 마운트. */
function renderShell(
  active: BookkeepingTabId,
  onSelect: (tab: BookkeepingTabId) => void = () => {},
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <>
        <BookkeepingTabBar active={active} reviewCount={3} onSelect={onSelect} />
        {BOOKKEEPING_TABS.map((tab) => (
          <BookkeepingTabPanel key={tab.id} tab={tab.id} active={active}>
            <span data-testid={`pane-${tab.id}`}>{tab.label} 내용</span>
          </BookkeepingTabPanel>
        ))}
      </>,
    ),
  );
}

describe("BookkeepingTabBar + BookkeepingTabPanel", () => {
  it("mounts all five tabpanels; only the active one is visible (others hidden)", () => {
    renderShell("ledger");
    for (const tab of BOOKKEEPING_TABS) {
      const panel = document.getElementById(tabPanelIdDom(tab.id));
      expect(panel, tab.id).not.toBeNull();
      expect(panel?.getAttribute("role")).toBe("tabpanel");
      expect(panel?.hasAttribute("hidden")).toBe(tab.id !== "ledger");
    }
  });

  it("keeps every tab's aria-controls pointing at an element that exists in the DOM", () => {
    renderShell("review");
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    expect(tabs).toHaveLength(BOOKKEEPING_TABS.length);
    for (const tab of tabs) {
      const controls = tab.getAttribute("aria-controls");
      expect(controls).toBeTruthy();
      const panel = document.getElementById(controls ?? "");
      expect(panel, controls ?? "").not.toBeNull();
      expect(panel?.getAttribute("aria-labelledby")).toBe(tab.id);
    }
  });

  it("marks only the active tab as selected and shows the review badge", () => {
    renderShell("reports");
    const selected = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'));
    expect(selected).toHaveLength(1);
    expect(selected[0]?.textContent).toContain("리포트");
    expect(document.querySelector(".bk-tab-badge")?.textContent).toBe("3");
  });

  it("invokes onSelect when a tab is clicked", () => {
    const onSelect = vi.fn();
    renderShell("review", onSelect);
    const importTab = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find(
      (el) => el.textContent?.includes("가져오기"),
    );
    act(() => importTab?.click());
    expect(onSelect).toHaveBeenCalledWith("import");
  });
});
