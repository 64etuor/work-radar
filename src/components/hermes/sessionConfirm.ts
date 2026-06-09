import type { TabState } from "./useHermesTabs";

type ConfirmSession = Pick<TabState, "name"> | null | undefined;

function sessionName(tab: ConfirmSession): string {
  return tab?.name?.trim() || "이 세션";
}

export function buildDeleteSessionConfirmMessage(tab: ConfirmSession): string {
  return `"${sessionName(tab)}" 세션을 삭제할까요?\n대화 기록이 영구 삭제됩니다. 되돌릴 수 없습니다.`;
}

export function confirmDeleteSession(
  tab: ConfirmSession,
  confirmFn: (message: string) => boolean = window.confirm,
): boolean {
  return confirmFn(buildDeleteSessionConfirmMessage(tab));
}
