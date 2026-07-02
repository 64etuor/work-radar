// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import { effectiveCategoryCode } from "./bookkeepingDrafts";
import {
  buildInlineCategoryOverride,
  INLINE_CATEGORY_OVERRIDE_REASON,
  isInteractiveTarget,
} from "./rowActivation";

describe("isInteractiveTarget", () => {
  it("returns false for null and plain elements", () => {
    expect(isInteractiveTarget(null)).toBe(false);
    const div = document.createElement("div");
    expect(isInteractiveTarget(div)).toBe(false);
  });

  it("detects a button target", () => {
    const button = document.createElement("button");
    expect(isInteractiveTarget(button)).toBe(true);
  });

  it("detects a descendant of an interactive element", () => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.appendChild(icon);
    expect(isInteractiveTarget(icon)).toBe(true);
  });

  it("detects role-based interactive elements (radix select trigger)", () => {
    const trigger = document.createElement("div");
    trigger.setAttribute("role", "combobox");
    const inner = document.createElement("span");
    trigger.appendChild(inner);
    expect(isInteractiveTarget(inner)).toBe(true);
  });

  it("does not flag a row wrapper containing buttons when clicking outside them", () => {
    const row = document.createElement("article");
    row.appendChild(document.createElement("button"));
    const text = document.createElement("strong");
    row.appendChild(text);
    expect(isInteractiveTarget(text)).toBe(false);
  });
});

describe("effectiveCategoryCode", () => {
  it("prefers the taxonomy code when present", () => {
    expect(effectiveCategoryCode({ categoryCode: "transport", category: "food" })).toBe(
      "transport",
    );
  });

  it("falls back to the legacy category label when the code is null", () => {
    expect(effectiveCategoryCode({ categoryCode: null, category: "food" })).toBe("food");
  });
});

describe("buildInlineCategoryOverride", () => {
  const tx = { id: "tx-1", categoryCode: "meals", category: "식비" };

  it("builds an override input with reset subcategory and audit reason", () => {
    expect(buildInlineCategoryOverride(tx, "transport")).toEqual({
      transactionId: "tx-1",
      categoryCode: "transport",
      subcategoryCode: null,
      reason: INLINE_CATEGORY_OVERRIDE_REASON,
    });
  });

  it("returns null when the category is unchanged", () => {
    expect(buildInlineCategoryOverride(tx, "meals")).toBeNull();
  });

  it("returns null for an empty next category", () => {
    expect(buildInlineCategoryOverride(tx, "")).toBeNull();
  });

  it("treats a legacy row's fallback category as the current value (no-op override)", () => {
    // 레거시 행: categoryCode=null, category="food" → 표시값 "food"를 그대로 다시
    // 고르는 클릭이 오해를 부르는 override/audit 행을 만들면 안 된다.
    const legacy = { id: "tx-2", categoryCode: null, category: "food" };
    expect(buildInlineCategoryOverride(legacy, "food")).toBeNull();
  });

  it("builds an override for a legacy row when a different category is picked", () => {
    const legacy = { id: "tx-2", categoryCode: null, category: "food" };
    expect(buildInlineCategoryOverride(legacy, "transport")).toEqual({
      transactionId: "tx-2",
      categoryCode: "transport",
      subcategoryCode: null,
      reason: INLINE_CATEGORY_OVERRIDE_REASON,
    });
  });
});
