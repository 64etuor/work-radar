import { describe, expect, it } from "vitest";

import { EMPTY_TABS_STATE, tabsReducer, type TabsState } from "./useHermesTabs";

describe("tabsReducer", () => {
  it("openTab adds a new tab with given id and default name", () => {
    const s = tabsReducer(EMPTY_TABS_STATE, {
      type: "open-tab",
      tabId: "t1",
      defaultName: "Hermes 1",
    });
    expect(s.tabs.get("t1")?.name).toBe("Hermes 1");
    expect(s.activeTabId).toBe("t1"); // first tab → active
  });

  it("openTab is idempotent on existing id", () => {
    const a = tabsReducer(EMPTY_TABS_STATE, {
      type: "open-tab",
      tabId: "t1",
      defaultName: "X",
    });
    const b = tabsReducer(a, {
      type: "open-tab",
      tabId: "t1",
      defaultName: "Y",
    });
    expect(b.tabs.size).toBe(1);
    expect(b.tabs.get("t1")?.name).toBe("X");
  });

  it("closeTab removes tab and re-elects active when needed", () => {
    let s: TabsState = EMPTY_TABS_STATE;
    s = tabsReducer(s, { type: "open-tab", tabId: "a", defaultName: "A" });
    s = tabsReducer(s, { type: "open-tab", tabId: "b", defaultName: "B" });
    s = tabsReducer(s, { type: "set-active", tabId: "b" });
    s = tabsReducer(s, { type: "close-tab", tabId: "b" });
    expect(s.tabs.has("b")).toBe(false);
    expect(s.activeTabId).toBe("a");
  });

  it("chunk action appends to matching tab only", () => {
    let s = tabsReducer(EMPTY_TABS_STATE, {
      type: "open-tab",
      tabId: "a",
      defaultName: "A",
    });
    s = tabsReducer(s, { type: "open-tab", tabId: "b", defaultName: "B" });
    s = tabsReducer(s, {
      type: "agent-chunk",
      tabId: "a",
      text: "hello",
    });
    const a = s.tabs.get("a");
    const b = s.tabs.get("b");
    expect(a?.messages.length).toBe(1);
    expect(b?.messages.length).toBe(0);
  });

  it("user action records on target tab", () => {
    let s = tabsReducer(EMPTY_TABS_STATE, {
      type: "open-tab",
      tabId: "a",
      defaultName: "A",
    });
    s = tabsReducer(s, {
      type: "user",
      tabId: "a",
      text: "hi",
      images: [],
    });
    const msgs = s.tabs.get("a")?.messages ?? [];
    expect(msgs[msgs.length - 1]?.role).toBe("user");
  });

  it("rename updates name only", () => {
    let s = tabsReducer(EMPTY_TABS_STATE, {
      type: "open-tab",
      tabId: "a",
      defaultName: "A",
    });
    s = tabsReducer(s, { type: "rename", tabId: "a", name: "custom" });
    expect(s.tabs.get("a")?.name).toBe("custom");
  });

  it("cap enforcement is the hook caller's responsibility — reducer accepts > cap", () => {
    // Intentional: cap is checked at the call site. Reducer is pure data transformation.
    let s = EMPTY_TABS_STATE;
    for (const id of ["a", "b", "c", "d"]) {
      s = tabsReducer(s, { type: "open-tab", tabId: id, defaultName: id });
    }
    expect(s.tabs.size).toBe(4);
  });
});
