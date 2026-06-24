import { describe, expect, it } from "vitest";

import { reconciliationTone, signedMinorLabel } from "./reconciliation";

describe("reconciliation helpers", () => {
  it("labels matched and mismatched assertions", () => {
    expect(reconciliationTone(0)).toBe("matched");
    expect(reconciliationTone(1)).toBe("over");
    expect(reconciliationTone(-1)).toBe("under");
  });

  it("formats signed minor-unit labels", () => {
    expect(signedMinorLabel(0)).toBe("0");
    expect(signedMinorLabel(1200)).toBe("+1,200");
    expect(signedMinorLabel(-1200)).toBe("-1,200");
  });
});
