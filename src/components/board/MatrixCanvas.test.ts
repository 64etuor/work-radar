import { describe, expect, it } from "vitest";

import { normalizeTitleEdit } from "@/components/board/matrixCanvasUtils";

describe("normalizeTitleEdit", () => {
  it("트림된 새 제목을 반환한다", () => {
    expect(normalizeTitleEdit("  새 제목  ", "옛 제목")).toBe("새 제목");
  });

  it("트림 후 빈 값이면 null (저장 안 함)", () => {
    expect(normalizeTitleEdit("   ", "옛 제목")).toBeNull();
    expect(normalizeTitleEdit("", "옛 제목")).toBeNull();
  });

  it("원본과 동일하면 null (무변경)", () => {
    expect(normalizeTitleEdit("같음", "같음")).toBeNull();
    expect(normalizeTitleEdit("  같음  ", "같음")).toBeNull();
    expect(normalizeTitleEdit("같음", "  같음  ")).toBeNull();
  });
});
