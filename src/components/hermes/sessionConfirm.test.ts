import { describe, expect, it, vi } from "vitest";

import { buildDeleteSessionConfirmMessage, confirmDeleteSession } from "./sessionConfirm";

describe("sessionConfirm", () => {
  it("warns that deleting a Hermes session permanently removes history", () => {
    expect(buildDeleteSessionConfirmMessage({ name: "고색동 미용실" })).toContain(
      "대화 기록이 영구 삭제됩니다",
    );
  });

  it("delegates the destructive delete decision to confirm", () => {
    const confirmFn = vi.fn(() => false);

    expect(confirmDeleteSession({ name: "고색동 미용실" }, confirmFn)).toBe(false);
    expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining("고색동 미용실"));
  });
});
