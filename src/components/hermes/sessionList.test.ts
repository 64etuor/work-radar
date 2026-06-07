import { describe, expect, it } from "vitest";

import type { HermesMessageRow } from "@/bindings";

import { autoTitleFrom, rowsToMessages } from "./sessionList";

describe("autoTitleFrom", () => {
  it("trims and truncates first user message", () => {
    expect(autoTitleFrom("   크롤러 고쳐줘  ")).toBe("크롤러 고쳐줘");
    const long = "a".repeat(80);
    expect(autoTitleFrom(long).length).toBeLessThanOrEqual(40);
  });
  it("falls back for empty", () => {
    expect(autoTitleFrom("   ")).toBe("새 세션");
  });
});

describe("rowsToMessages", () => {
  it("maps user/assistant rows to reducer message shapes", () => {
    const rows: HermesMessageRow[] = [
      { id: 1, sessionId: "s", seq: 0, role: "user", content: "hi", toolJson: null, createdAt: "" },
      {
        id: 2,
        sessionId: "s",
        seq: 1,
        role: "assistant",
        content: "yo",
        toolJson: null,
        createdAt: "",
      },
    ];
    const msgs = rowsToMessages(rows);
    expect(msgs[0]).toMatchObject({ role: "user", text: "hi" });
    expect(msgs[1]).toMatchObject({ role: "assistant", done: true });
  });
});
