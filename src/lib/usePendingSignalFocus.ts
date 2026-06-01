import { useEffect, useState } from "react";

import { useUIStore } from "@/store";

/**
 * 팔레트 시그널 검색(`goToSignal`)이 심은 `pendingSignalId`를 한 번만 소비해 `onFocus`로 넘긴다.
 * 렌더 중 비교(set-state-in-effect 회피) + 소비 후 store clear. 보드에 없는(아카이브/분류됨)
 * 시그널이면 `onFocus`는 무해한 no-op이 되도록 호출자가 구현한다(선택만, 자동 실행 없음 — #1).
 */
export function usePendingSignalFocus(onFocus: (signalId: string) => void) {
  const pendingSignalId = useUIStore((s) => s.pendingSignalId);
  const clearPendingSignal = useUIStore((s) => s.clearPendingSignal);
  const [prev, setPrev] = useState(pendingSignalId);
  if (pendingSignalId !== prev) {
    setPrev(pendingSignalId);
    if (pendingSignalId) onFocus(pendingSignalId);
  }
  useEffect(() => {
    if (pendingSignalId) clearPendingSignal();
  }, [pendingSignalId, clearPendingSignal]);
}
