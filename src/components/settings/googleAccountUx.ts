export type GoogleAccountOauthWaitingTone = "active" | "stale";

export type GoogleAccountOauthViewInput = {
  hasClient: boolean;
  connected: boolean;
  waiting: boolean;
  elapsedMs: number;
};

export type GoogleAccountOauthViewState = {
  primaryLabel: string;
  primaryDisabled: boolean;
  showWaitingPanel: boolean;
  showCancel: boolean;
  elapsedLabel: string;
  waitingTone: GoogleAccountOauthWaitingTone;
  waitingMessage: string;
};

const STALE_WAIT_MS = 60_000;

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}초`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}분` : `${minutes}분 ${seconds}초`;
}

export function googleAccountOauthViewState(
  input: GoogleAccountOauthViewInput,
): GoogleAccountOauthViewState {
  const waitingTone: GoogleAccountOauthWaitingTone =
    input.waiting && input.elapsedMs >= STALE_WAIT_MS ? "stale" : "active";
  const waitingMessage =
    waitingTone === "stale"
      ? "동의 창을 닫았거나 완료하지 못했다면 취소 후 다시 연결하세요."
      : "브라우저에서 Google 계정 동의를 완료하면 이 카드가 자동으로 갱신됩니다.";

  return {
    primaryLabel: input.waiting ? "동의 대기 중" : input.connected ? "다시 연결" : "연결",
    primaryDisabled: !input.hasClient || input.waiting,
    showWaitingPanel: input.waiting,
    showCancel: input.waiting,
    elapsedLabel: formatElapsed(input.elapsedMs),
    waitingTone,
    waitingMessage,
  };
}
