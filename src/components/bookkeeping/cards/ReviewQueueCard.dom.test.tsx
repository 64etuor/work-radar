// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { BookkeepingTransaction } from "@/bindings";
import { installRadixHappyDomShim } from "@/lib/test-support/radixHappyDom";

import type { TransactionEditDraft } from "../bookkeepingDrafts";
import { ReviewQueueCard } from "./ReviewQueueCard";

// react-query 훅 격리 — 검토 큐의 collapse/expand 경계만 검증한다.
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

/** merchant 이름으로 read-row 요소를 찾는다. */
function readRowOf(merchant: string): HTMLElement {
  const row = [...(container?.querySelectorAll<HTMLElement>(".bk-review-read") ?? [])].find((el) =>
    el.textContent?.includes(merchant),
  );
  if (!row) throw new Error(`read row not found: ${merchant}`);
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

const SUSPICIOUS = makeTx({
  reviewReasonsJson: JSON.stringify([{ code: "low_confidence" }]),
});
const NORMAL = makeTx({ id: "tx-2", merchant: "스타벅스", amountMinor: 6300 });
const ROWS = [SUSPICIOUS, NORMAL];

describe("ReviewQueueCard collapse/expand", () => {
  it("renders compact read rows by default — no edit form inputs in the DOM", () => {
    setup(ROWS);
    expect(container?.querySelectorAll(".bk-review-read")).toHaveLength(2);
    expect(container?.querySelector(".bk-edit-form")).toBeNull();
    expect(container?.querySelector('[id^="bk-edit-"]')).toBeNull();
  });

  it("expands exactly one edit form via 편집, and opening another collapses the previous", () => {
    setup(ROWS);
    click(buttonIn(readRowOf("김밥천국"), "편집"));
    expect(container?.querySelectorAll(".bk-edit-form")).toHaveLength(1);
    expect(container?.querySelector("#bk-edit-tx-1-merchant")).not.toBeNull();

    click(buttonIn(readRowOf("스타벅스"), "편집"));
    expect(container?.querySelectorAll(".bk-edit-form")).toHaveLength(1);
    expect(container?.querySelector("#bk-edit-tx-1-merchant")).toBeNull();
    expect(container?.querySelector("#bk-edit-tx-2-merchant")).not.toBeNull();
  });

  it("expands the edit form when the row body is clicked", () => {
    setup(ROWS);
    const merchant = readRowOf("김밥천국").querySelector(".bk-review-read-merchant");
    if (!merchant) throw new Error("merchant cell not found");
    click(merchant);
    expect(container?.querySelector("#bk-edit-tx-1-merchant")).not.toBeNull();
  });

  it("toggles the collapsed 상세 section inside the edit form", () => {
    setup(ROWS);
    click(buttonIn(readRowOf("김밥천국"), "편집"));
    const form = container?.querySelector(".bk-edit-form");
    if (!form) throw new Error("edit form not found");
    // 기본 접힘 — 상세 필드(주문번호)는 DOM에 없다.
    expect(container?.querySelector("#bk-edit-tx-1-order-no")).toBeNull();
    const toggle = buttonIn(form, "상세");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(container?.querySelector("#bk-edit-tx-1-order-no")).not.toBeNull();
    click(toggle);
    expect(container?.querySelector("#bk-edit-tx-1-order-no")).toBeNull();
  });

  it("collapses the edit form via 접기", () => {
    setup(ROWS);
    click(buttonIn(readRowOf("김밥천국"), "편집"));
    const form = container?.querySelector(".bk-transaction-edit");
    if (!form) throw new Error("edit form not found");
    click(buttonIn(form, "접기"));
    expect(container?.querySelector(".bk-edit-form")).toBeNull();
    expect(container?.querySelectorAll(".bk-review-read")).toHaveLength(2);
  });

  it("collapses after a successful save, keeps the form mounted after a failed save", async () => {
    let ok = false;
    const { onSave } = setup(ROWS, () => Promise.resolve(ok));
    click(buttonIn(readRowOf("김밥천국"), "편집"));
    const form = container?.querySelector(".bk-edit-form");
    if (!form) throw new Error("edit form not found");

    // 실패 저장 — 폼이 그대로 남는다(draft 보존).
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(container?.querySelector(".bk-edit-form")).not.toBeNull();

    // 성공 저장 — 접힌다.
    ok = true;
    await act(async () =>
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(container?.querySelector(".bk-edit-form")).toBeNull();
  });

  it("fires delete directly from the read row without expanding", () => {
    const { onDelete } = setup(ROWS);
    click(buttonIn(readRowOf("스타벅스"), "삭제"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0]?.[0]?.id).toBe("tx-2");
    expect(container?.querySelector(".bk-edit-form")).toBeNull();
  });

  it("keeps the bulk-select checkbox working (toggling shows the bulk bar)", () => {
    setup(ROWS);
    const checkbox = container?.querySelector('[aria-label="김밥천국 선택"]');
    if (!checkbox) throw new Error("checkbox not found");
    click(checkbox);
    expect(container?.querySelector(".bk-bulk-bar")?.textContent).toContain("1건 선택");
    // 체크박스 클릭이 편집을 열지 않는다.
    expect(container?.querySelector(".bk-edit-form")).toBeNull();
    click(checkbox);
    expect(container?.querySelector(".bk-bulk-bar")).toBeNull();
  });

  it("truncates review-reason chips to +N on the read row", () => {
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
    const reasons = container?.querySelector(".bk-review-read-reasons");
    expect(reasons?.textContent).toContain("low_confidence");
    expect(reasons?.textContent).toContain("+2");
  });
});

describe("ReviewQueueCard suspicious/normal grouping", () => {
  it("renders 의심 group first with per-row 확정, 정상 group without it", () => {
    const { onApprove } = setup(ROWS);
    const heads = [...(container?.querySelectorAll(".bk-review-group-head") ?? [])];
    expect(heads.map((h) => h.textContent ?? "")).toEqual([
      expect.stringContaining("의심 1건"),
      expect.stringContaining("정상 1건"),
    ]);
    // 의심 행(low_confidence)이 정상 행보다 먼저 렌더된다.
    const rows = [...(container?.querySelectorAll(".bk-review-read") ?? [])];
    expect(rows[0]?.textContent).toContain("김밥천국");
    expect(rows[1]?.textContent).toContain("스타벅스");
    // 의심 행에만 확정 버튼.
    click(buttonIn(readRowOf("김밥천국"), "확정"));
    expect(onApprove.mock.calls[0]?.[0]?.id).toBe("tx-1");
    expect(maybeButtonIn(readRowOf("스타벅스"), "확정")).toBeUndefined();
  });

  it("bulk-approves exactly the normal ids from the group header", () => {
    const normal2 = makeTx({ id: "tx-3", merchant: "이마트", amountMinor: 42000 });
    const { onBulkReview } = setup([SUSPICIOUS, NORMAL, normal2]);
    const head = [...(container?.querySelectorAll(".bk-review-group-head") ?? [])].find((h) =>
      h.textContent?.includes("정상"),
    );
    if (!head) throw new Error("normal group head not found");
    click(buttonIn(head, "일괄 확정"));
    expect(onBulkReview).toHaveBeenCalledTimes(1);
    expect(onBulkReview.mock.calls[0]?.[0]).toEqual(["tx-2", "tx-3"]);
    expect(onBulkReview.mock.calls[0]?.[1]).toBe("approved");
  });

  it("hides empty group headers", () => {
    setup([NORMAL]);
    const heads = [...(container?.querySelectorAll(".bk-review-group-head") ?? [])];
    expect(heads).toHaveLength(1);
    expect(heads[0]?.textContent).toContain("정상 1건");
  });
});

describe("ReviewQueueCard inline note edit", () => {
  it("saves a note from the read row without opening the full form", async () => {
    const { onSave } = setup(ROWS);
    const row = readRowOf("스타벅스");
    click(buttonIn(row, "메모 추가"));
    // 메모 클릭이 행 확장을 트리거하지 않는다.
    expect(container?.querySelector(".bk-edit-form")).toBeNull();

    const input = row.querySelector<HTMLInputElement>('[aria-label="스타벅스 메모 편집"]');
    if (!input) throw new Error("note input not found");
    typeInto(input, "회식");
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]?.id).toBe("tx-2");
    expect(onSave.mock.calls[0]?.[1]?.note).toBe("회식");
    // 저장 성공 → 인라인 입력이 닫히고 전체 폼은 끝까지 열리지 않는다.
    expect(container?.querySelector('[aria-label="스타벅스 메모 편집"]')).toBeNull();
    expect(container?.querySelector(".bk-edit-form")).toBeNull();
  });

  it("cancels the note draft with Escape (no save)", async () => {
    const { onSave } = setup(ROWS);
    const row = readRowOf("스타벅스");
    click(buttonIn(row, "메모 추가"));
    const input = row.querySelector<HTMLInputElement>('[aria-label="스타벅스 메모 편집"]');
    if (!input) throw new Error("note input not found");
    typeInto(input, "버릴 메모");
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(onSave).not.toHaveBeenCalled();
    expect(container?.querySelector('[aria-label="스타벅스 메모 편집"]')).toBeNull();
  });

  it("skips the save entirely when the note did not change", async () => {
    const { onSave } = setup([makeTx({ id: "tx-9", merchant: "쿠팡", note: "정기결제" })]);
    const row = readRowOf("쿠팡");
    click(buttonIn(row, "메모 수정"));
    const input = row.querySelector<HTMLInputElement>('[aria-label="쿠팡 메모 편집"]');
    if (!input) throw new Error("note input not found");
    await act(async () =>
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(onSave).not.toHaveBeenCalled();
    expect(container?.querySelector('[aria-label="쿠팡 메모 편집"]')).toBeNull();
  });
});
