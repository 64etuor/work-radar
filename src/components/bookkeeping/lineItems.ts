import type { BookkeepingLineItem, CreateBookkeepingLineItemInput } from "@/bindings";

/**  거래 분할(line item) 편집용 초안 행. 금액/수량은 입력 문자열 그대로 들고, 저장 시 파싱한다. */
export type LineItemDraft = {
  key: string;
  name: string;
  amount: string;
  quantity: string;
  categoryCode: string;
};

function parseAmountMinor(value: string): number {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

/**  이름이 있거나 금액이 0이 아니면 "의미 있는" 행으로 본다(빈 행은 합계/존재 판정에서 제외). */
function isMeaningful(draft: LineItemDraft): boolean {
  return draft.name.trim() !== "" || parseAmountMinor(draft.amount) !== 0;
}

export function blankLineItemDraft(seq: number): LineItemDraft {
  return { key: `new-${seq}`, name: "", amount: "", quantity: "", categoryCode: "" };
}

export function lineItemDraftsFromServer(items: BookkeepingLineItem[]): LineItemDraft[] {
  return items.map((item) => ({
    key: item.id,
    name: item.name,
    amount: String(item.amountMinor),
    quantity: String(item.quantity),
    categoryCode: item.categoryCode ?? "",
  }));
}

/**
 *  분할 합계가 거래 금액과 맞는지 라이브로 계산한다. 서버의 `line_item_sum_mismatch`
 *  리뷰 사유(하드 에러 아님)를 그대로 반영한다 — 의미 있는 행이 없으면 불일치로 보지 않는다.
 */
export function lineItemSumState(
  drafts: LineItemDraft[],
  amountMinor: number,
): { sum: number; hasItems: boolean; matches: boolean; diff: number } {
  const meaningful = drafts.filter(isMeaningful);
  const sum = meaningful.reduce((acc, draft) => acc + parseAmountMinor(draft.amount), 0);
  const hasItems = meaningful.length > 0;
  const diff = sum - amountMinor;
  return { sum, hasItems, matches: !hasItems || diff === 0, diff };
}

export function toLineItemInputs(drafts: LineItemDraft[]): CreateBookkeepingLineItemInput[] {
  return drafts
    .filter((draft) => draft.name.trim() !== "")
    .map((draft) => {
      const quantityTrimmed = draft.quantity.trim();
      const quantityParsed = quantityTrimmed === "" ? null : Number(quantityTrimmed);
      const categoryCode = draft.categoryCode.trim();
      return {
        name: draft.name.trim(),
        amountMinor: parseAmountMinor(draft.amount),
        quantity: quantityParsed != null && Number.isFinite(quantityParsed) ? quantityParsed : null,
        categoryCode: categoryCode === "" ? null : categoryCode,
      };
    });
}
