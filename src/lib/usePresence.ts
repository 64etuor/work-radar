/**
 * 오버레이 지연 언마운트(presence) 컨트롤러.
 *
 * radix가 소유하지 않는 표면(CommandPalette, ToastHost …)은 Presence가 없어서 닫힘이
 * 하드 컷이 된다. 이 훅은 `open=false` 직후에도 노드를 `exitMs` 동안 유지해 exit
 * 애니메이션이 재생될 시간을 준다.
 *
 * `HermesPanel.tsx`가 같은 일을 인라인으로 한다(+animationend 조기 언마운트). 다만 그쪽은
 * `isClosing`을 effect에서 켜므로 닫힘 첫 커밋에 서브트리가 한 번 언마운트됐다 되살아난다 —
 * 이 훅은 전이를 렌더 중에 반영해 그 깜빡임이 없다. Hermes 이관은 별건(그쪽은 열 때
 * 중앙 재배치가 open 전이에 묶여 있다).
 *
 * 계약:
 * - `open=true`  → 즉시 mounted, `state="open"`.
 * - `open=false` → `state="closed"`로 exit 재생, `exitMs` 후 언마운트.
 * - 닫히는 도중 재오픈하면 타이머를 취소하고 그대로 `state="open"`으로 되돌아온다.
 *
 * 호출부 의무(전부 지켜야 안전하다):
 * - closed 상태는 반드시 `pointer-events: none` — exit 중인 전면 오버레이가 닫힘 직후의
 *   빠른 클릭을 삼키면 click-shield가 된다.
 * - closed 상태는 포커스도 놓아야 한다(`inert`) — 아니면 exit 동안 사라진 표면이
 *   키 입력을 계속 먹는다.
 * - reduced-motion(`animation: none`)에서는 exit이 즉시 끝나지 않고 `exitMs` 동안 *보이는 채로*
 *   남는다. closed에 `opacity: 0`을 함께 줘야 잔상이 없다.
 *
 * `exitMs`는 호출부 상수여야 한다(런타임 변경 미지원 — 값을 ref로 고정해 재예약하지 않는다).
 */
import { useEffect, useRef, useState } from "react";

export type PresenceState = "open" | "closed";

export interface Presence {
  /** 렌더 게이트 — false면 호출부가 노드를 렌더하지 않는다. */
  mounted: boolean;
  /** `data-state` 로 그대로 내보내 CSS enter/exit을 선택한다. */
  state: PresenceState;
  /**
   * 열림마다 증가하는 세대 번호. 자식에 `key`로 걸어야 한다.
   *
   * exit 유예 동안엔 노드가 살아 있으므로, 그 사이에 다시 열면 자식이 **언마운트되지 않는다** —
   * `autoFocus` 같은 마운트 전용 효과가 다시 안 돌고, 입력값 등 내부 state도 그대로 남는다.
   * 이 키가 바뀌면 React가 새로 마운트해 "열 때마다 초기 상태" 계약을 되돌린다.
   * (exit 중에는 키가 그대로라 애니메이션이 끊기지 않는다.)
   */
  openKey: number;
}

export function usePresence(open: boolean, exitMs: number): Presence {
  const [closing, setClosing] = useState(false);
  const [openKey, setOpenKey] = useState(0);
  const [seenOpen, setSeenOpen] = useState(open);

  // exitMs를 아래 effect의 deps에 넣으면, 닫혀 있는 동안 값이 바뀔 때 cleanup이 타이머를
  // 지우고 재실행이 아무 것도 재예약하지 않아 closing이 영구히 true로 남는다.
  const exitMsRef = useRef(exitMs);
  useEffect(() => {
    exitMsRef.current = exitMs;
  }, [exitMs]);

  // 전이는 **렌더 중에** 반영한다(React 공식 "prop 변화에 state 맞추기" 패턴).
  // effect로 미루면 open=false인 첫 커밋에서 mounted가 잠깐 false가 되어 서브트리가
  // 통째로 언마운트됐다 되살아난다 — exit이 새 노드에서 다시 시작되고 한 프레임 깜빡인다.
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) {
      // 닫는 중 재오픈: exit 취소(effect cleanup이 타이머를 지운다) + 자식 재마운트.
      setClosing(false);
      setOpenKey((n) => n + 1);
    } else {
      setClosing(true);
    }
  }

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setClosing(false), exitMsRef.current);
    return () => clearTimeout(timer);
  }, [closing]);

  return { mounted: open || closing, state: open ? "open" : "closed", openKey };
}
