import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the generated bindings BEFORE importing the store (hoisted by vitest).
// vi.fn<T> takes the full function type as its single type argument (vitest 4.x).
type RespondFn = (
  tabId: string,
  requestId: string,
  optionId: string,
  cancelled: boolean,
) => Promise<{ status: "ok"; data: null }>;
const hermesAskUserRespond = vi.fn<RespondFn>(() =>
  Promise.resolve({ status: "ok" as const, data: null }),
);

vi.mock("@/bindings", () => ({
  commands: {
    hermesAskUserRespond: (
      tabId: string,
      requestId: string,
      optionId: string,
      cancelled: boolean,
    ) => hermesAskUserRespond(tabId, requestId, optionId, cancelled),
    // openTab path may run during default-tab logic in other tests; stub the rest as no-ops.
    hermesAgentOpenTab: () => Promise.resolve({ status: "ok", data: null }),
    hermesAgentCloseTab: () => Promise.resolve({ status: "ok", data: null }),
    hermesAgentCap: () => Promise.resolve({ status: "ok", data: 3 }),
  },
}));

// Mock @tauri-apps/api/event — imported at module load by useHermesTabsStore; not needed
// in the thunk tests but must be resolvable in node env.
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { EMPTY_TABS_STATE } from "./useHermesTabs";
import { useHermesTabsStore } from "./useHermesTabsStore";

describe("respondAsk thunk", () => {
  beforeEach(() => {
    hermesAskUserRespond.mockClear();
    // Reset the singleton store to a clean state (fresh Map) so tabs from other
    // tests/files can't leak in and make these assertions order-dependent.
    useHermesTabsStore.setState({ ...EMPTY_TABS_STATE, tabs: new Map() });
    // seed a tab + an ask message
    const d = useHermesTabsStore.getState()._dispatch;
    d({ type: "open-tab", tabId: "a", defaultName: "A" });
    d({ type: "ask-user", tabId: "a", requestId: "7", options: [{ id: "allow", label: "Allow" }] });
  });

  it("calls the command with (tabId, requestId, optionId, cancelled) and marks resolved", async () => {
    await useHermesTabsStore.getState().respondAsk("a", "7", "allow", false);
    expect(hermesAskUserRespond).toHaveBeenCalledWith("a", "7", "allow", false);
    const card = useHermesTabsStore
      .getState()
      .tabs.get("a")!
      .messages.find((m) => m.role === "ask");
    expect(card && card.role === "ask" && card.resolved).toBe("allow");
  });

  it("cancelled dismiss records resolved='cancelled'", async () => {
    await useHermesTabsStore.getState().respondAsk("a", "7", "", true);
    expect(hermesAskUserRespond).toHaveBeenCalledWith("a", "7", "", true);
    const card = useHermesTabsStore
      .getState()
      .tabs.get("a")!
      .messages.find((m) => m.role === "ask");
    expect(card && card.role === "ask" && card.resolved).toBe("cancelled");
  });
});
