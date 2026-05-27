import { describe, expect, it } from "vitest";

import agentStatusBarSource from "../components/AgentStatusBar.tsx?raw";

describe("Hermes startup keychain guard", () => {
  it("does not let the always-mounted AgentStatusBar initiate Hermes keychain reads", () => {
    expect(agentStatusBarSource).toContain("useHermesBridgeStatus({ enabled: false })");
  });
});
