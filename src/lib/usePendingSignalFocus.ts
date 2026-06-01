import { usePendingFocus } from "@/lib/usePendingFocus";
import { useUIStore } from "@/store";

/**
 * 팔레트 시그널 검색(`goToSignal`)이 심은 `pendingSignalId`를 한 번만 소비해 `onFocus`로 넘긴다.
 * 마운트-타이밍/소비 로직은 공유 훅 [[usePendingFocus]]에 있다(skill 딥링크와 동일 패턴 — 드리프트 방지).
 * 보드에 없는(아카이브/분류됨) 시그널이면 `onFocus`는 무해한 no-op이 되도록 호출자가 구현한다
 * (선택만, 자동 실행 없음 — INVARIANT #1).
 */
export function usePendingSignalFocus(onFocus: (signalId: string) => void) {
  const pendingSignalId = useUIStore((s) => s.pendingSignalId);
  const clearPendingSignal = useUIStore((s) => s.clearPendingSignal);
  usePendingFocus(pendingSignalId, clearPendingSignal, onFocus);
}
