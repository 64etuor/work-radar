import { describe, expect, it } from "vitest";

import { reduceBookkeepingTriageState, triageCommandForKey } from "./triageKeys";

describe("triageCommandForKey", () => {
  it("maps review queue keys to commands", () => {
    expect(triageCommandForKey("j")).toBe("move_next");
    expect(triageCommandForKey("k")).toBe("move_previous");
    expect(triageCommandForKey("e")).toBe("approve");
    expect(triageCommandForKey("x")).toBe("delete");
    expect(triageCommandForKey("/")).toBe("focus_search");
    expect(triageCommandForKey("c")).toBe("focus_category");
    expect(triageCommandForKey("?")).toBe("toggle_help");
  });

  it("ignores unrelated keys", () => {
    expect(triageCommandForKey("a")).toBeNull();
  });
});

describe("reduceBookkeepingTriageState", () => {
  it("moves within row bounds", () => {
    let state = { activeIndex: 0, helpOpen: false };
    state = reduceBookkeepingTriageState(state, "move_next", 2);
    expect(state.activeIndex).toBe(1);
    state = reduceBookkeepingTriageState(state, "move_next", 2);
    expect(state.activeIndex).toBe(1);
    state = reduceBookkeepingTriageState(state, "move_previous", 2);
    expect(state.activeIndex).toBe(0);
  });

  it("toggles help without changing selection", () => {
    const state = reduceBookkeepingTriageState(
      { activeIndex: 1, helpOpen: false },
      "toggle_help",
      3,
    );
    expect(state).toEqual({ activeIndex: 1, helpOpen: true });
  });

  it("uses -1 when there are no rows", () => {
    const state = reduceBookkeepingTriageState({ activeIndex: 1, helpOpen: false }, "move_next", 0);
    expect(state.activeIndex).toBe(-1);
  });

  it("starts at the first row when rows arrive after an empty queue", () => {
    const state = reduceBookkeepingTriageState(
      { activeIndex: -1, helpOpen: false },
      "move_next",
      3,
    );
    expect(state.activeIndex).toBe(0);
  });
});
