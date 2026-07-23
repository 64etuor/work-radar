import { describe, expect, it } from "vitest";

import {
  BOOKKEEPING_INPUT_PANEL_DEFAULT_OPEN,
  BOOKKEEPING_INPUT_PANEL_ORDER,
} from "./bookkeepingPanels";

describe("bookkeeping input panels", () => {
  it("manual 입력 패널만 남는다 — 고정비는 MoneyManager 미러 전용이라 입력 폼이 없다", () => {
    expect(BOOKKEEPING_INPUT_PANEL_ORDER).toEqual(["manual"]);
  });

  it("manual 패널은 기본으로 열려 있다", () => {
    expect(BOOKKEEPING_INPUT_PANEL_DEFAULT_OPEN).toEqual({
      manual: true,
    });
  });
});
