// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { BookkeepingTransaction } from "@/bindings";
import { installRadixHappyDomShim } from "@/lib/test-support/radixHappyDom";

import type { TransactionEditDraft } from "../bookkeepingDrafts";
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

function setup(
  overrides: Partial<BookkeepingTransaction> = {},
  patchResult: boolean | Promise<boolean> = true,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onOpenDetail = vi.fn();
  const onDelete = vi.fn();
  const onCategoryChange = vi.fn<(code: string) => void>();
  const onPatch = vi.fn<(patch: Partial<TransactionEditDraft>) => Promise<boolean>>(() =>
    Promise.resolve(patchResult),
  );
  act(() =>
    root?.render(
      // tr은 table/tbody 밖에서 렌더될 수 없다 — 실제 카드와 동일한 래핑.
      <table>
        <tbody>
          <TransactionReadRow
            tx={makeTx(overrides)}
            disabled={false}
            onOpenDetail={onOpenDetail}
            onDelete={onDelete}
            onCategoryChange={onCategoryChange}
            onPatch={onPatch}
          />
        </tbody>
      </table>,
    ),
  );
  return { onOpenDetail, onDelete, onCategoryChange, onPatch };
}

function query<T extends Element>(selector: string): T {
  const el = container?.querySelector<T>(selector);
  if (!el) throw new Error(`not found: ${selector}`);
  return el;
}

function click(el: Element) {
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

function buttonByLabel(text: string): HTMLButtonElement {
  const el = [...(container?.querySelectorAll("button") ?? [])].find(
    (b) => b.textContent?.includes(text) || b.getAttribute("aria-label")?.includes(text) === true,
  );
  if (!el) throw new Error(`button not found: ${text}`);
  return el;
}

async function commitInput(input: HTMLInputElement, next: string) {
  await act(async () => {
    const proto = Object.getPrototypeOf(input) as object;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
  });
}

describe("TransactionReadRow (원장 테이블 행 인라인 편집)", () => {
  it("가맹점 셀 클릭 → 인라인 입력 → Enter 커밋이 onPatch({merchant})로 간다", async () => {
    const { onPatch } = setup();
    click(buttonByLabel("가맹점 변경"));
    const input = query<HTMLInputElement>('input[aria-label="김밥천국 가맹점 변경"]');
    await commitInput(input, "성수김밥");
    expect(onPatch).toHaveBeenCalledWith({ merchant: "성수김밥" });
    // 성공 커밋 후 입력은 닫힌다.
    expect(container?.querySelector('input[aria-label="김밥천국 가맹점 변경"]')).toBeNull();
  });

  it("변경 없이 커밋하면 no-op으로 닫힌다(onPatch 미호출)", async () => {
    const { onPatch } = setup();
    click(buttonByLabel("가맹점 변경"));
    const input = query<HTMLInputElement>('input[aria-label="김밥천국 가맹점 변경"]');
    await commitInput(input, "김밥천국");
    expect(onPatch).not.toHaveBeenCalled();
    expect(container?.querySelector("input")).toBeNull();
  });

  it("Esc는 커밋 없이 취소하고 전역 Esc 계약으로 새지 않게 소비한다", () => {
    const { onPatch } = setup();
    click(buttonByLabel("가맹점 변경"));
    const input = query<HTMLInputElement>('input[aria-label="김밥천국 가맹점 변경"]');
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onPatch).not.toHaveBeenCalled();
    expect(container?.querySelector('input[aria-label="김밥천국 가맹점 변경"]')).toBeNull();
  });

  it("저장 실패 시 입력을 유지해 draft를 잃지 않는다", async () => {
    const { onPatch } = setup({}, false);
    click(buttonByLabel("가맹점 변경"));
    const input = query<HTMLInputElement>('input[aria-label="김밥천국 가맹점 변경"]');
    await commitInput(input, "성수김밥");
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(container?.querySelector('input[aria-label="김밥천국 가맹점 변경"]')).not.toBeNull();
  });

  it("금액 셀은 포맷 표시 ⇄ 원 단위 숫자 입력으로 스왑되고 onPatch({amount})로 커밋된다", async () => {
    const { onPatch } = setup();
    click(buttonByLabel("금액 변경"));
    const input = query<HTMLInputElement>('input[aria-label="김밥천국 금액 변경"]');
    expect(input.value).toBe("9000");
    await commitInput(input, "12000");
    expect(onPatch).toHaveBeenCalledWith({ amount: "12000" });
  });

  it("상세 편집/삭제 버튼은 각자 핸들러만 호출한다", () => {
    const { onOpenDetail, onDelete } = setup();
    click(buttonByLabel("상세 편집"));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
    click(buttonByLabel("삭제"));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("레거시 행(categoryCode=null)은 category 폴백을 유효 분류로 쓴다", () => {
    setup({ categoryCode: null, category: "food" });
    expect(query(".bk-row-quick-category").getAttribute("data-category")).toBe("food");
  });

  it("taxonomy 코드가 있으면 코드를 우선한다", () => {
    setup({ categoryCode: "transport", category: "food" });
    expect(query(".bk-row-quick-category").getAttribute("data-category")).toBe("transport");
  });
});
