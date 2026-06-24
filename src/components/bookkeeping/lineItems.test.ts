import { describe, expect, it } from "vitest";

import type { BookkeepingLineItem } from "@/bindings";

import {
  blankLineItemDraft,
  lineItemDraftsFromServer,
  lineItemSumState,
  toLineItemInputs,
} from "./lineItems";

function serverItem(over: Partial<BookkeepingLineItem>): BookkeepingLineItem {
  return {
    id: "li-1",
    transactionId: "tx-1",
    name: "항목",
    amountMinor: 1000,
    quantity: 1,
    categoryCode: null,
    sortOrder: 0,
    createdAt: "2026-06-24T00:00:00Z",
    ...over,
  };
}

describe("lineItemSumState", () => {
  it("reports no mismatch when there are no meaningful items", () => {
    const state = lineItemSumState([], 5000);
    expect(state.hasItems).toBe(false);
    expect(state.matches).toBe(true);
    expect(state.sum).toBe(0);
  });

  it("matches when the item amounts sum to the transaction amount", () => {
    const drafts = [
      { key: "a", name: "커피", amount: "3000", quantity: "", categoryCode: "" },
      { key: "b", name: "디저트", amount: "2000", quantity: "", categoryCode: "" },
    ];
    const state = lineItemSumState(drafts, 5000);
    expect(state.hasItems).toBe(true);
    expect(state.sum).toBe(5000);
    expect(state.matches).toBe(true);
    expect(state.diff).toBe(0);
  });

  it("flags a mismatch and reports the signed difference", () => {
    const drafts = [{ key: "a", name: "커피", amount: "3000", quantity: "", categoryCode: "" }];
    const state = lineItemSumState(drafts, 5000);
    expect(state.matches).toBe(false);
    expect(state.diff).toBe(-2000); // sum - amount
  });

  it("ignores blank rows when computing presence and sum", () => {
    const drafts = [
      { key: "a", name: "커피", amount: "5000", quantity: "", categoryCode: "" },
      { key: "b", name: "", amount: "", quantity: "", categoryCode: "" },
    ];
    const state = lineItemSumState(drafts, 5000);
    expect(state.hasItems).toBe(true);
    expect(state.sum).toBe(5000);
    expect(state.matches).toBe(true);
  });

  it("multiplies amount by quantity to mirror the server's sum", () => {
    const drafts = [{ key: "a", name: "커피", amount: "1000", quantity: "3", categoryCode: "" }];
    const state = lineItemSumState(drafts, 3000);
    expect(state.sum).toBe(3000);
    expect(state.matches).toBe(true);
  });

  it("treats a blank or non-numeric quantity as 1 (server default)", () => {
    const blank = lineItemSumState(
      [{ key: "a", name: "커피", amount: "1000", quantity: "", categoryCode: "" }],
      1000,
    );
    const invalid = lineItemSumState(
      [{ key: "b", name: "커피", amount: "1000", quantity: "x", categoryCode: "" }],
      1000,
    );
    expect(blank.sum).toBe(1000);
    expect(invalid.sum).toBe(1000);
  });
});

describe("lineItemDraftsFromServer", () => {
  it("maps server rows to editable string drafts with stable keys", () => {
    const drafts = lineItemDraftsFromServer([
      serverItem({
        id: "li-9",
        name: "커피",
        amountMinor: 3000,
        quantity: 2,
        categoryCode: "food",
      }),
    ]);
    expect(drafts).toEqual([
      { key: "li-9", name: "커피", amount: "3000", quantity: "2", categoryCode: "food" },
    ]);
  });

  it("renders a null categoryCode as an empty string", () => {
    const [draft] = lineItemDraftsFromServer([serverItem({ categoryCode: null })]);
    expect(draft.categoryCode).toBe("");
  });
});

describe("toLineItemInputs", () => {
  it("parses amounts/quantities and normalizes empty optionals to null", () => {
    const inputs = toLineItemInputs([
      { key: "a", name: "커피", amount: "3000", quantity: "2", categoryCode: "food" },
      { key: "b", name: "디저트", amount: "2000", quantity: "", categoryCode: "" },
    ]);
    expect(inputs).toEqual([
      { name: "커피", amountMinor: 3000, quantity: 2, categoryCode: "food" },
      { name: "디저트", amountMinor: 2000, quantity: null, categoryCode: null },
    ]);
  });

  it("drops rows without a name (cannot persist a nameless item)", () => {
    const inputs = toLineItemInputs([
      { key: "a", name: "  ", amount: "1000", quantity: "", categoryCode: "" },
      { key: "b", name: "커피", amount: "3000", quantity: "", categoryCode: "" },
    ]);
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.name).toBe("커피");
  });
});

describe("blankLineItemDraft", () => {
  it("creates an empty draft with a unique key from the sequence", () => {
    expect(blankLineItemDraft(3)).toEqual({
      key: "new-3",
      name: "",
      amount: "",
      quantity: "",
      categoryCode: "",
    });
  });
});
