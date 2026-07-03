// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { BookkeepingTransaction } from "@/bindings";
import { installRadixHappyDomShim } from "@/lib/test-support/radixHappyDom";

import { TransactionReadRow } from "./TransactionReadRow";

// CategorySelect의 taxonomy 쿼리(react-query 훅) 격리 — 컴포넌트 경계만 검증한다.
vi.mock("@/lib/query", () => ({
  useBookkeepingTaxonomy: () => ({
    data: [
      { code: "food", label: "식비", parentCode: null },
      { code: "transport", label: "교통", parentCode: null },
    ],
  }),
  localToday: () => "2026-07-02",
}));

beforeAll(installRadixHappyDomShim);

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
});

function makeTx(overrides: Partial<BookkeepingTransaction> = {}): BookkeepingTransaction {
  return {
    id: "tx-1",
    projectId: null,
    source: "manual",
    sourceRef: null,
    merchant: "김밥천국",
    description: null,
    amountMinor: 9000,
    currency: "KRW",
    spentAt: "2026-07-01",
    category: "food",
    reviewStatus: "approved",
    note: null,
    paymentMethodKind: "card",
    paymentMethodLabel: null,
    paymentMethodLast4: null,
    expenseKind: "variable",
    recurringExpenseId: null,
    recurringOccurrenceId: null,
    direction: "expense",
    account: null,
    subcategory: null,
    categoryCode: null,
    subcategoryCode: null,
    rawCategory: null,
    spentAtTime: null,
    confidence: null,
    fieldConfidenceJson: "{}",
    reviewReasonsJson: "[]",
    duplicateOfTransactionId: null,
    orderNo: null,
    paymentNo: null,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-01T00:00:00Z",
    reviewedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

function setup(overrides: Partial<BookkeepingTransaction> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const onCategoryChange = vi.fn<(code: string) => void>();
  act(() =>
    root?.render(
      <TransactionReadRow
        tx={makeTx(overrides)}
        disabled={false}
        onEdit={onEdit}
        onDelete={onDelete}
        onCategoryChange={onCategoryChange}
      />,
    ),
  );
  return { onEdit, onDelete, onCategoryChange };
}

function query<T extends Element>(selector: string): T {
  const el = container?.querySelector<T>(selector);
  if (!el) throw new Error(`not found: ${selector}`);
  return el;
}

function click(el: Element) {
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

// 편집/삭제는 아이콘 전용 ghost 버튼 — aria-label과 title이 함께 있어야 매칭한다(둘 다 필수 계약).
function buttonByText(text: string): HTMLButtonElement {
  const el = [...(container?.querySelectorAll("button") ?? [])].find(
    (b) =>
      b.textContent?.includes(text) ||
      (b.getAttribute("aria-label")?.includes(text) === true &&
        b.getAttribute("title")?.includes(text) === true),
  );
  if (!el) throw new Error(`button not found: ${text}`);
  return el;
}

describe("TransactionReadRow", () => {
  it("opens the editor when the row body is clicked", () => {
    const { onEdit } = setup();
    click(query("strong"));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("does not double-open when inner action buttons are clicked", () => {
    const { onEdit, onDelete } = setup();
    click(buttonByText("삭제"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("does not open the editor from the quick category select trigger", () => {
    const { onEdit } = setup();
    const trigger = query(`[id="bk-quick-tx-1-category"]`);
    click(trigger);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("uses the edit-form effective category for legacy rows (category fallback)", () => {
    // 레거시 행: categoryCode=null, category="food" → 미분류가 아니라 "food"를 보여야 한다.
    setup({ categoryCode: null, category: "food" });
    expect(query(".bk-row-quick-category").getAttribute("data-category")).toBe("food");
  });

  it("prefers the taxonomy code when present", () => {
    setup({ categoryCode: "transport", category: "food" });
    expect(query(".bk-row-quick-category").getAttribute("data-category")).toBe("transport");
  });

  it("adds no generic focus stop on the row; keyboard access is the visible edit button", () => {
    setup();
    const row = query("article");
    expect(row.hasAttribute("tabindex")).toBe(false);
    expect(row.hasAttribute("role")).toBe(false);
    expect(buttonByText("편집").tagName).toBe("BUTTON");
  });
});
