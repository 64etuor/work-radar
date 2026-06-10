import { describe, expect, it } from "vitest";

import { resolveHermesShortcut } from "./keyboardShortcuts";
import type { TabState } from "./useHermesTabs";

function tab(id: string): TabState {
  return {
    id,
    name: id,
    status: "idle",
    messages: [],
    pendingOutbound: [],
    commandsList: [],
    projectId: null,
  };
}

function event(key: string, overrides: Partial<KeyboardEvent> = {}) {
  return {
    key,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    target: null,
    ...overrides,
  } as KeyboardEvent;
}

describe("resolveHermesShortcut", () => {
  it("maps Cmd+W to hiding the window, not closing a session", () => {
    const action = resolveHermesShortcut(event("w"), {
      panelOpen: true,
      tabs: [tab("a")],
    });

    expect(action).toEqual({ type: "hide-window" });
  });

  it("maps Cmd+N to creating a new tab while the panel is open", () => {
    expect(
      resolveHermesShortcut(event("n"), {
        panelOpen: true,
        tabs: [tab("a")],
      }),
    ).toEqual({ type: "new-tab" });
  });

  it("maps Cmd+number to the matching visible tab", () => {
    expect(
      resolveHermesShortcut(event("2"), {
        panelOpen: true,
        tabs: [tab("a"), tab("b")],
      }),
    ).toEqual({ type: "select-tab", tabId: "b" });
  });

  it("ignores Hermes shortcuts while the panel is closed", () => {
    expect(
      resolveHermesShortcut(event("w"), {
        panelOpen: false,
        tabs: [tab("a")],
      }),
    ).toBeNull();
  });

  it("ignores modified variants so OS and app text shortcuts stay available", () => {
    expect(
      resolveHermesShortcut(event("w", { shiftKey: true }), {
        panelOpen: true,
        tabs: [tab("a")],
      }),
    ).toBeNull();
  });
});
