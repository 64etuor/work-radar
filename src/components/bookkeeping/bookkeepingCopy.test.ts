import { describe, expect, it } from "vitest";

import { BOOKKEEPING_GMAIL_PERMISSION_COPY } from "./bookkeepingCopy";

describe("bookkeeping copy", () => {
  it("keeps Gmail reconnect ownership in Settings", () => {
    expect(BOOKKEEPING_GMAIL_PERMISSION_COPY).toContain("설정");
    expect(BOOKKEEPING_GMAIL_PERMISSION_COPY).not.toContain("권한 다시 연결");
    expect(BOOKKEEPING_GMAIL_PERMISSION_COPY).not.toContain("재동의");
  });
});
