import { type ReactNode, useRef } from "react";

import {
  BOOKKEEPING_TABS,
  type BookkeepingTabId,
  reviewBadgeLabel,
  tabIdDom,
  tabPanelIdDom,
} from "./bookkeepingTabs";

/** 탭 패널 셸 — 다섯 패널 전부 항상 마운트하고 비활성만 native `hidden`으로 감춘다.
 *  aria-controls가 언제나 실존 id를 가리키고(tablist 표준 패턴), 카드-로컬 상태
 *  (리뷰 필터/선택·행 편집 드래프트)가 탭 전환에도 구조적으로 살아남는다. */
export function BookkeepingTabPanel({
  tab,
  active,
  children,
}: {
  tab: BookkeepingTabId;
  active: BookkeepingTabId;
  children: ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={tabPanelIdDom(tab)}
      aria-labelledby={tabIdDom(tab)}
      tabIndex={-1}
      className="bk-pane"
      hidden={tab !== active}
    >
      {children}
    </div>
  );
}

/** 가계부 세그먼트 탭 바 — control-room ProjectTabs의 tablist 문법(roving tabIndex +
 *  ArrowLeft/Right 순환)을 따른다. 검토 탭은 리뷰 대기 건수 배지를 함께 노출. */
export function BookkeepingTabBar({
  active,
  reviewCount,
  onSelect,
}: {
  active: BookkeepingTabId;
  reviewCount: number;
  onSelect: (tab: BookkeepingTabId) => void;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = (index + delta + BOOKKEEPING_TABS.length) % BOOKKEEPING_TABS.length;
    onSelect(BOOKKEEPING_TABS[next].id);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="bk-tabs" role="tablist" aria-label="가계부 영역">
      {BOOKKEEPING_TABS.map((tab, index) => {
        const selected = tab.id === active;
        const badge = tab.id === "review" ? reviewBadgeLabel(reviewCount) : null;
        return (
          <button
            key={tab.id}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={tabIdDom(tab.id)}
            aria-selected={selected}
            aria-controls={tabPanelIdDom(tab.id)}
            tabIndex={selected ? 0 : -1}
            className="bk-tab typo-label-sm"
            data-selected={selected || undefined}
            onClick={() => onSelect(tab.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            <span className="bk-tab-name">{tab.label}</span>
            {badge !== null && (
              <span className="bk-tab-badge" aria-label={`리뷰 대기 ${reviewCount}건`}>
                {badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
