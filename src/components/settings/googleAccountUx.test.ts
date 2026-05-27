import { describe, expect, it } from "vitest";

import { googleAccountOauthViewState } from "./googleAccountUx";

describe("googleAccountOauthViewState", () => {
  it("keeps a cancelled OAuth attempt retryable without waiting for the backend timeout", () => {
    const state = googleAccountOauthViewState({
      hasClient: true,
      connected: false,
      waiting: false,
      elapsedMs: 12_000,
    });

    expect(state.primaryLabel).toBe("연결");
    expect(state.primaryDisabled).toBe(false);
    expect(state.showWaitingPanel).toBe(false);
    expect(state.showCancel).toBe(false);
  });

  it("shows a recoverable waiting state while the browser consent flow is open", () => {
    const state = googleAccountOauthViewState({
      hasClient: true,
      connected: false,
      waiting: true,
      elapsedMs: 8_400,
    });

    expect(state.primaryLabel).toBe("동의 대기 중");
    expect(state.primaryDisabled).toBe(true);
    expect(state.showWaitingPanel).toBe(true);
    expect(state.showCancel).toBe(true);
    expect(state.elapsedLabel).toBe("8초");
  });

  it("warns after a long wait that the browser was probably closed", () => {
    const state = googleAccountOauthViewState({
      hasClient: true,
      connected: false,
      waiting: true,
      elapsedMs: 75_000,
    });

    expect(state.waitingTone).toBe("stale");
    expect(state.waitingMessage).toContain("창을 닫았거나");
  });
});
