import { describe, expect, it } from "vitest";

import type { HermesMessageRow } from "@/bindings";

import { autoTitleFrom, messagePreview, relativeTime, rowsToMessages } from "./sessionList";
import type { TabState } from "./useHermesTabs";

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

describe("messagePreview", () => {
  it("returns last user/assistant text trimmed", () => {
    const tab = {
      messages: [
        { id: "1", role: "user", text: "안녕", images: [], ts: 1 },
        {
          id: "2",
          role: "assistant",
          chunks: ["반갑", "습니다"],
          toolCalls: [],
          ts: 2,
          done: true,
        },
      ],
    } as unknown as TabState;
    expect(messagePreview(tab)).toBe("반갑습니다");
  });
  it("empty for no messages", () => {
    expect(messagePreview({ messages: [] } as unknown as TabState)).toBe("");
  });
});

describe("relativeTime", () => {
  it("formats seconds/minutes/hours", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 30_000, now)).toMatch(/방금|초/);
    expect(relativeTime(now - 5 * 60_000, now)).toMatch(/분/);
    expect(relativeTime(now - 3 * 3600_000, now)).toMatch(/시간/);
  });
});
