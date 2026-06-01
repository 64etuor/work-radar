import { useEffect, useState } from "react";

/**
 * 팔레트 딥링크(`goToSignal`/`goToSkill`)가 심은 `pendingId`를 한 번만 소비해 `onFocus`로 넘긴다.
 *
 * `goTo*`는 `view`와 `pendingId`를 한 번의 store `set()`으로 함께 심는다. 대상 뷰
 * (CaptureBoard/SkillsView)는 조건부 마운트(App `renderView` + `key={view}` remount)라
 * **그 시점에 처음 마운트**되므로, 마운트 시 `pendingId`가 이미 세팅돼 있다. 따라서 `seen`을
 * `pendingId`로 초기화하면 첫 비교가 같아져 포커스가 무음 실패한다 → `seen`을 `null`로 초기화해
 * 첫 non-null `pendingId`가 반드시 적용되게 한다.
 *
 * 포커스 판정은 render-phase 비교(set-state-in-effect 회피)로, store clear는 진짜 side-effect라
 * effect로 둔다. `onFocus`는 호출자 자신의 상태만 갱신한다(선택만 — 자동 실행 없음, INVARIANT #1).
 */
export function usePendingFocus(
  pendingId: string | null,
  clear: () => void,
  onFocus: (id: string) => void,
): void {
  const [seen, setSeen] = useState<string | null>(null);
  if (pendingId !== seen) {
    setSeen(pendingId);
    if (pendingId) onFocus(pendingId);
  }
  useEffect(() => {
    if (pendingId) clear();
  }, [pendingId, clear]);
}
