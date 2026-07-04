import { describe, expect, it } from "vitest";

import { paymentAssetSummary } from "./cardHelpers";

// .mmbak 정합성(2026-07-04): 자산은 DB `account`로만 저장되고 payment_method_kind는 unknown —
// 셀 요약은 payment와 자산을 통합해 자산 정보가 "미확인" 뒤에 숨지 않게 한다.
describe("paymentAssetSummary", () => {
  it("mmbak 행(kind=unknown, 자산만) → 자산이 그대로 보인다", () => {
    expect(paymentAssetSummary("unknown", null, null, "하나카드")).toBe("하나카드");
  });

  it("payment 정보가 있으면 kind 라벨 · 표시명 · 끝자리 · 자산 순으로 합친다", () => {
    expect(paymentAssetSummary("card", "신한", "1234", "생활비 통장")).toBe(
      "카드 · 신한 · 끝 1234 · 생활비 통장",
    );
  });

  it("자산이 표시명과 같으면 중복 표기하지 않는다", () => {
    expect(paymentAssetSummary("card", "하나카드", null, "하나카드")).toBe("카드 · 하나카드");
  });

  it("아무 정보도 없으면 em dash", () => {
    expect(paymentAssetSummary("unknown", null, null, null)).toBe("—");
  });
});
