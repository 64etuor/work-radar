import { describe, expect, it } from "vitest";

import agentStatusBarSource from "../components/AgentStatusBar.tsx?raw";

describe("Hermes startup keychain guard", () => {
  it("does not let the always-mounted AgentStatusBar initiate Hermes keychain reads", () => {
    // The always-mounted AgentStatusBar must source Hermes panel state from the
    // in-memory zustand store (useHermesTabsStore) — which never touches the
    // keychain or issues IPC reads at bar mount. Guard the store-based approach.
    expect(agentStatusBarSource).toContain("useHermesTabsStore");
  });
});
