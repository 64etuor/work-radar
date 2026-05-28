import { describe, expect, it } from "vitest";

import agentStatusBarSource from "../components/AgentStatusBar.tsx?raw";

describe("Hermes startup keychain guard", () => {
  it("does not let the always-mounted AgentStatusBar initiate Hermes keychain reads", () => {
    // Phase 3: AgentStatusBar switched from useHermesBridgeStatus (keychain-backed query)
    // to useHermesTabsStore (in-memory zustand store). The store never touches the keychain.
    // Guard: ensure the keychain-initiating hook is NOT imported here.
    expect(agentStatusBarSource).not.toContain("useHermesBridgeStatus");
    // And the store-based approach IS used (no keychain, no IPC reads at bar mount).
    expect(agentStatusBarSource).toContain("useHermesTabsStore");
  });
});
