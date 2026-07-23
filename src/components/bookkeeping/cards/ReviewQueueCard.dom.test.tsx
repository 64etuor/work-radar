// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { BookkeepingTransaction } from "@/bindings";
import { installRadixHappyDomShim } from "@/lib/test-support/radixHappyDom";

import type { TransactionEditDraft } from "../bookkeepingDrafts";
import { ReviewQueueCard } from "./ReviewQueueCard";

// react-query 훅 격리 — 검토 큐의 행/Sheet 경계만 검증한다.
// LineItemEditor는 isPending으로 얕게 멈추고, 중복 후보는 빈 목록으로 응답한다.
vi.mock("@/lib/query", () => ({
  useBookkeepingTaxonomy: () => ({
    data: [
      { code: "food", label: "식비", parentCode: null },
      { code: "transport", label: "교통", parentCode: null },
    ],
  }),
  useBookkeepingLineItems: () => ({ isPending: true, data: undefined }),
  useFindBookkeepingDuplicateCandidates: () => ({ isPending: false, data: [] }),
  useMarkBookkeepingDuplicate: () => ({ isPending: false, mutate: () => {} }),
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
    source: "gmail",
    sourceRef: null,
    merchant: "김밥천국",
    description: null,
    amountMinor: 9000,
    currency: "KRW",
    spentAt: "2026-07-01",
    category: "food",
    reviewStatus: "needs_review",
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

type SaveFn = (tx: BookkeepingTransaction, draft: TransactionEditDraft) => Promise<boolean>;

function setup(rows: BookkeepingTransaction[], saveImpl?: SaveFn) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const onApprove = vi.fn();
  const onDelete = vi.fn();
  const onBulkReview = vi.fn();
  const onSave = vi.fn<SaveFn>(saveImpl ?? (() => Promise.resolve(true)));
  act(() =>
    root?.render(
      <ReviewQueueCard
        rows={rows}
        order="default"
        disabled={false}
        bulkPending={false}
        onApprove={onApprove}
        onBulkReview={onBulkReview}
        onBulkCategory={vi.fn()}
        onBulkDelete={vi.fn()}
        onDelete={onDelete}
        onSave={onSave}
        onOrderChange={vi.fn()}
      />,
    ),
  );
  return { onApprove, onDelete, onSave, onBulkReview };
}

function click(el: Element) {
  act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
}

/** merchant 이름으로 테이블 행(tr)을 찾는다. */
function rowOf(merchant: string): HTMLElement {
  const row = [...(container?.querySelectorAll<HTMLElement>(".bk-review-tr") ?? [])].find((el) =>
    el.textContent?.includes(merchant),
  );
  if (!row) throw new Error(`review row not found: ${merchant}`);
  return row;
}

function buttonIn(scope: Element, label: string): HTMLButtonElement {
  const el = maybeButtonIn(scope, label);
  if (!el) throw new Error(`button not found: ${label}`);
  return el;
}

function maybeButtonIn(scope: Element, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find(
    (b) => b.textContent?.includes(label) || b.getAttribute("aria-label")?.includes(label),
  );
}

/** 컨트롤드 Input에 값 입력 — 네이티브 setter + input 이벤트로 React onChange를 태운다. */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Sheet는 radix portal(body)로 렌더된다 — 전체 편집 폼 존재 여부는 document에서 본다. */
function sheetForm(): Element | null {
  return document.querySelector(".bk-edit-sheet .bk-edit-form");
}

const SUSPICIOUS = makeTx({
  reviewReasonsJson: JSON.stringify([{ code: "low_confidence" }]),
});
const NORMAL = makeTx({ id: "tx-2", merchant: "스타벅스", amountMinor: 6300 });
const ROWS = [SUSPICIOUS, NORMAL];

describe("ReviewQueueCard 테이블 + Sheet", () => {
  it("구분 열에서 수입/지출을 명시적으로 표시한다", () => {
    setup([
      makeTx({ id: "tx-income", merchant: "급여", direction: "income" }),
      makeTx({ id: "tx-expense", merchant: "김밥", direction: "expense" }),
    ]);
    const headers = [...(container?.querySelectorAll("thead th") ?? [])].map(
      (head) => head.textContent,
    );
    expect(headers).toContain("구분");
    expect(rowOf("급여").querySelector(".bk-td-direction")?.textContent).toBe("수입");
    expect(rowOf("김밥").querySelector(".bk-td-direction")?.textContent).toBe("지출");
  });

  it("기본은 인라인 셀 행만 — 전체 편집 폼은 DOM에 없다", () => {
    setup(ROWS);
    expect(container?.querySelectorAll(".bk-review-tr")).toHaveLength(2);
    expect(sheetForm()).toBeNull();
  });

  it("상세 편집 버튼이 우측 Sheet를 열고, 닫기로 닫힌다", () => {
    setup(ROWS);
    click(buttonIn(rowOf("김밥천국"), "상세 편집"));
    expect(sheetForm()).not.toBeNull();
    expect(document.querySelector("#bk-edit-tx-1-merchant")).not.toBeNull();
    const form = sheetForm();
    if (!form) throw new Error("sheet form not found");
    click(buttonIn(form, "닫기"));
    expect(sheetForm()).toBeNull();
  });

  it("Sheet 저장 성공 시 닫히고, 실패 시 열린 채 draft를 보존한다", async () => {
    let ok = false;
    const { onSave } = setup(ROWS, () => Promise.resolve(ok));
    click(buttonIn(rowOf("김밥천국"), "상세 편집"));
    const form = sheetForm();
    if (!form) throw new Error("sheet form not found");

    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(sheetForm()).not.toBeNull();

    ok = true;
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(sheetForm()).toBeNull();
  });

  it("Sheet 안 상세 섹션 토글이 동작한다(기본 접힘)", () => {
    setup(ROWS);
    click(buttonIn(rowOf("김밥천국"), "상세 편집"));
    const form = sheetForm();
    if (!form) throw new Error("sheet form not found");
    expect(document.querySelector("#bk-edit-tx-1-order-no")).toBeNull();
    const toggle = buttonIn(form, "상세");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    click(toggle);
    expect(document.querySelector("#bk-edit-tx-1-order-no")).not.toBeNull();
  });

  it("가맹점 셀 인라인 편집이 onSave(merchant patch)로 커밋된다 — Sheet 없이", async () => {
    const { onSave } = setup(ROWS);
    click(buttonIn(rowOf("스타벅스"), "가맹점 변경"));
    const input = container?.querySelector<HTMLInputElement>('[aria-label="스타벅스 가맹점 변경"]');
    if (!input) throw new Error("merchant input not found");
    typeInto(input, "스타벅스 성수점");
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]?.id).toBe("tx-2");
    expect(onSave.mock.calls[0]?.[1]?.merchant).toBe("스타벅스 성수점");
    expect(sheetForm()).toBeNull();
  });

  it("삭제는 행에서 즉시 실행된다", () => {
    const { onDelete } = setup(ROWS);
    click(buttonIn(rowOf("스타벅스"), "삭제"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0]?.[0]?.id).toBe("tx-2");
  });

  it("일괄 선택 체크박스가 bulk bar를 띄운다", () => {
    setup(ROWS);
    const checkbox = container?.querySelector('[aria-label="김밥천국 선택"]');
    if (!checkbox) throw new Error("checkbox not found");
    click(checkbox);
    expect(container?.querySelector(".bk-bulk-bar")?.textContent).toContain("1건 선택");
    click(checkbox);
    expect(container?.querySelector(".bk-bulk-bar")).toBeNull();
  });

  it("사유 칩은 +N으로 잘린다", () => {
    setup([
      makeTx({
        reviewReasonsJson: JSON.stringify([
          { code: "low_confidence" },
          { code: "possible_duplicate" },
          { code: "cancellation_notice" },
          { code: "source_deleted" },
          { code: "line_item_sum_mismatch" },
        ]),
      }),
    ]);
    const reasons = container?.querySelector(".bk-td-reasons");
    expect(reasons?.textContent).toContain("low_confidence");
    expect(reasons?.textContent).toContain("+2");
  });
});

describe("ReviewQueueCard 의심/정상 그룹", () => {
  it("의심 그룹이 먼저, 행별 확정은 의심 그룹에만", () => {
    const { onApprove } = setup(ROWS);
    const heads = [...(container?.querySelectorAll(".bk-group-td") ?? [])];
    expect(heads.map((h) => h.textContent ?? "")).toEqual([
      expect.stringContaining("의심 1건"),
      expect.stringContaining("정상 1건"),
    ]);
    const rows = [...(container?.querySelectorAll(".bk-review-tr") ?? [])];
    expect(rows[0]?.textContent).toContain("김밥천국");
    expect(rows[1]?.textContent).toContain("스타벅스");
    click(buttonIn(rowOf("김밥천국"), "확정"));
    expect(onApprove.mock.calls[0]?.[0]?.id).toBe("tx-1");
    expect(maybeButtonIn(rowOf("스타벅스"), "확정")).toBeUndefined();
  });

  it("정상 그룹 헤더의 일괄 확정은 정확히 정상 id들만 보낸다", () => {
    const normal2 = makeTx({ id: "tx-3", merchant: "이마트", amountMinor: 42000 });
    const { onBulkReview } = setup([SUSPICIOUS, NORMAL, normal2]);
    const head = [...(container?.querySelectorAll(".bk-group-td") ?? [])].find((h) =>
      h.textContent?.includes("정상"),
    );
    if (!head) throw new Error("normal group head not found");
    click(buttonIn(head, "일괄 확정"));
    expect(onBulkReview).toHaveBeenCalledTimes(1);
    expect(onBulkReview.mock.calls[0]?.[0]).toEqual(["tx-2", "tx-3"]);
    expect(onBulkReview.mock.calls[0]?.[1]).toBe("approved");
  });

  it("빈 그룹 헤더는 숨긴다", () => {
    setup([NORMAL]);
    const heads = [...(container?.querySelectorAll(".bk-group-td") ?? [])];
    expect(heads).toHaveLength(1);
    expect(heads[0]?.textContent).toContain("정상 1건");
  });
});

describe("ReviewQueueCard 내용(note) 셀 인라인 편집", () => {
  it("내용 셀에서 note를 저장한다 — 전체 폼 없이", async () => {
    const { onSave } = setup(ROWS);
    const row = rowOf("스타벅스");
    click(buttonIn(row, "내용 변경"));
    expect(sheetForm()).toBeNull();

    const input = row.querySelector<HTMLInputElement>('input[aria-label="스타벅스 내용 변경"]');
    if (!input) throw new Error("note input not found");
    typeInto(input, "회식");
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]?.id).toBe("tx-2");
    expect(onSave.mock.calls[0]?.[1]?.note).toBe("회식");
    expect(container?.querySelector('input[aria-label="스타벅스 내용 변경"]')).toBeNull();
    expect(sheetForm()).toBeNull();
  });

  it("Escape는 저장 없이 취소한다", async () => {
    const { onSave } = setup(ROWS);
    const row = rowOf("스타벅스");
    click(buttonIn(row, "내용 변경"));
    const input = row.querySelector<HTMLInputElement>('input[aria-label="스타벅스 내용 변경"]');
    if (!input) throw new Error("note input not found");
    typeInto(input, "버릴 내용");
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(onSave).not.toHaveBeenCalled();
    expect(container?.querySelector('input[aria-label="스타벅스 내용 변경"]')).toBeNull();
  });

  it("행 인라인 분류 변경은 draft 저장 경로(onSave)로 커밋된다 — override 아님", async () => {
    const { onSave } = setup(ROWS);
    const trigger = document.getElementById("bk-review-tx-2-category");
    if (!trigger) throw new Error("category select trigger not found");
    // radix Select를 열고 항목을 고른다(portal은 body에 뜬다).
    act(() => {
      trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    const item = [...document.querySelectorAll('[role="option"]')].find((o) =>
      o.textContent?.includes("교통"),
    );
    if (!item) throw new Error("category option not found");
    await act(async () => {
      item.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]?.id).toBe("tx-2");
    expect(onSave.mock.calls[0]?.[1]?.categoryCode).toBe("transport");
    expect(onSave.mock.calls[0]?.[1]?.subcategoryCode).toBe("");
  });

  it("내용이 그대로면 저장을 건너뛴다", async () => {
    const { onSave } = setup([makeTx({ id: "tx-9", merchant: "쿠팡", note: "정기결제" })]);
    const row = rowOf("쿠팡");
    click(buttonIn(row, "내용 변경"));
    const input = row.querySelector<HTMLInputElement>('input[aria-label="쿠팡 내용 변경"]');
    if (!input) throw new Error("note input not found");
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSave).not.toHaveBeenCalled();
    expect(container?.querySelector('input[aria-label="쿠팡 내용 변경"]')).toBeNull();
  });
});
