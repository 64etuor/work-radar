// 가계부 IA 세그먼트 탭 — 순수 정의/헬퍼 (셸 컴포넌트는 BookkeepingTabs.tsx).

export const BOOKKEEPING_TABS = [
  { id: "review", label: "검토" },
  { id: "ledger", label: "원장" },
  { id: "recurring", label: "정기" },
  { id: "budget", label: "예산" },
  { id: "reports", label: "리포트" },
  { id: "import", label: "가져오기" },
] as const;

export type BookkeepingTabId = (typeof BOOKKEEPING_TABS)[number]["id"];

export const BOOKKEEPING_DEFAULT_TAB: BookkeepingTabId = "review";

// HermesView("hermes.sidebarOpen") 패턴을 따르는 view-네임스페이스 키.
export const BOOKKEEPING_TAB_STORAGE_KEY = "bookkeeping.activeTab";

export function isBookkeepingTabId(value: string | null): value is BookkeepingTabId {
  return BOOKKEEPING_TABS.some((tab) => tab.id === value);
}

/** 저장된 탭 복원 — 값이 없거나 알 수 없는 id면 기본 탭(검토)으로. storage 접근 실패도 흡수. */
export function readStoredBookkeepingTab(read: (key: string) => string | null): BookkeepingTabId {
  try {
    const stored = read(BOOKKEEPING_TAB_STORAGE_KEY);
    return isBookkeepingTabId(stored) ? stored : BOOKKEEPING_DEFAULT_TAB;
  } catch {
    return BOOKKEEPING_DEFAULT_TAB;
  }
}

/** 마지막 탭 유지 — private mode 등 storage 예외는 조용히 무시(탭 전환 자체를 막지 않음). */
export function writeStoredBookkeepingTab(
  write: (key: string, value: string) => void,
  tab: BookkeepingTabId,
): void {
  try {
    write(BOOKKEEPING_TAB_STORAGE_KEY, tab);
  } catch {
    // storage 불가 환경에서는 세션 내 useState만으로 동작.
  }
}

/** tablist ↔ tabpanel을 잇는 DOM id 쌍 (aria-controls / aria-labelledby). */
export function tabIdDom(tab: BookkeepingTabId): string {
  return `bk-tab-${tab}`;
}

export function tabPanelIdDom(tab: BookkeepingTabId): string {
  return `bk-tabpanel-${tab}`;
}

/** 검토 탭 배지 라벨 — 0건이면 배지 숨김(null), 100건 이상은 "99+"로 캡. */
export function reviewBadgeLabel(count: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? "99+" : String(Math.floor(count));
}

/** 검토 탭 밖에서만 리뷰 큐 점프 칩을 보인다. 현재 탭에서는 탭 배지가 이미 같은 정보를 소유한다. */
export function shouldShowReviewJumpChip(count: number, activeTab: BookkeepingTabId): boolean {
  return reviewBadgeLabel(count) !== null && activeTab !== "review";
}
