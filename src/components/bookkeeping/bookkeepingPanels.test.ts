import { describe, expect, it } from "vitest";

import {
  BOOKKEEPING_INPUT_PANEL_DEFAULT_OPEN,
  BOOKKEEPING_INPUT_PANEL_ORDER,
} from "./bookkeepingPanels";

describe("bookkeeping input panels", () => {
  it("keeps manual input above recurring input", () => {
    expect(BOOKKEEPING_INPUT_PANEL_ORDER).toEqual(["manual", "recurring"]);
  });

  it("keeps both input panels visible by default", () => {
    expect(BOOKKEEPING_INPUT_PANEL_DEFAULT_OPEN).toEqual({
      manual: true,
      recurring: true,
    });
  });
});
