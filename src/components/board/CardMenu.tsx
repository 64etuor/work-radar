import "./CardMenu.css";

import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { registerOverlay } from "@/components/ui/overlay-stack";

export type CardMenuAction =
  | "today"
  | "edit"
  | "backlog"
  | "agenda"
  | "calendar"
  | "snooze"
  | "done"
  | "archive"
  | "delete";

export type CardMenuState = {
  signalId: string;
  anchor: HTMLElement;
};

type Props = {
  state: CardMenuState | null;
  onAct: (action: CardMenuAction, signalId: string) => void;
  onClose: () => void;
};

/** 카드 ⋯ 액션 메뉴. anchor 기준 fixed 위치, 바깥 클릭/Esc로 닫힘. */
export function CardMenu({ state, onAct, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });

  // anchor 기준 위치 계산 (메뉴가 그려진 뒤 크기 측정).
  useLayoutEffect(() => {
    if (!state || !menuRef.current) return;
    const r = state.anchor.getBoundingClientRect();
    const mw = menuRef.current.offsetWidth || 172;
    const mh = menuRef.current.offsetHeight || 230;
    setPos({
      left: Math.min(r.right - mw, window.innerWidth - mw - 8),
      top: Math.min(r.bottom + 6, window.innerHeight - mh - 8),
    });
  }, [state]);

  const handleOutsideClose = useEffectEvent(() => onClose());
  // 바깥 클릭으로 닫기.
  useEffect(() => {
    if (!state) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".cb-card-menu") && !t.closest(".menu-btn")) handleOutsideClose();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [state]);

  // 상호작용 계약(plan §0.6): 열린 동안 overlay-stack에 등록 → App 셸 Esc가 `isOverlayOpen()`으로
  // 양보(창 숨김 안 함). 셸은 메뉴를 닫지 않으므로 여기서 Esc로 닫고 트리거(anchor) 포커스를 복원한다
  // (radix DropdownMenu 동등 동작 — 이 메뉴는 싱글톤 anchor 구조라 래퍼 대신 계약만 채택).
  const handleEscClose = useEffectEvent(() => onClose());
  useEffect(() => {
    if (!state) return;
    const unregister = registerOverlay();
    const anchor = state.anchor;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleEscClose();
        anchor.focus?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      unregister();
      window.removeEventListener("keydown", onKey);
    };
  }, [state]);

  if (!state) return null;

  const act = (a: CardMenuAction) => {
    onAct(a, state.signalId);
    onClose();
  };

  return (
    <div
      ref={menuRef}
      className="cb-card-menu"
      style={{ left: pos.left, top: pos.top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button type="button" onClick={() => act("today")}>
        Today 추가<small>T</small>
      </button>
      <button type="button" onClick={() => act("edit")}>
        제목 편집<small>수정</small>
      </button>
      <div className="sep" />
      <button type="button" onClick={() => act("backlog")}>
        백로그 등록<small>Notion</small>
      </button>
      <button type="button" onClick={() => act("agenda")}>
        안건 승격<small>Notion</small>
      </button>
      <button type="button" onClick={() => act("calendar")}>
        캘린더 등록<small>일정</small>
      </button>
      <div className="sep" />
      <button type="button" onClick={() => act("snooze")}>
        미루기<small>S</small>
      </button>
      <button type="button" onClick={() => act("done")}>
        완료<small>D</small>
      </button>
      <button type="button" onClick={() => act("archive")}>
        보관<small>E</small>
      </button>
      <button type="button" className="danger" onClick={() => act("delete")}>
        삭제<small>영구</small>
      </button>
    </div>
  );
}
