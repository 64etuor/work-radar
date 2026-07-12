import { useState } from "react";

/**
 * 삭제 커밋 대기 중 카드의 **표시 필터** 상태. 캐시 조작 대신 렌더에서 걸러낸다 —
 * 커밋 전 다른 뮤테이션의 invalidate가 서버 상태(아직 미삭제)를 다시 가져와도 카드가
 * 부활하지 않고, 되돌리기는 필터 해제만이라 연속 삭제끼리 간섭하지 않는다.
 * 지연 커밋 타이머/토스트는 호출부(CaptureBoard 삭제 undo 계약)가 소유한다.
 */
export function usePendingDeletes() {
  const [pendingDeleteIds, setPendingDeleteIds] = useState<ReadonlySet<string>>(() => new Set());
  const markPendingDelete = (id: string) => setPendingDeleteIds((prev) => new Set(prev).add(id));
  const unmarkPendingDelete = (id: string) =>
    setPendingDeleteIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  return { pendingDeleteIds, markPendingDelete, unmarkPendingDelete };
}
