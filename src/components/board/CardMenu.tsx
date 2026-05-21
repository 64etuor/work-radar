import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type CardMenuAction =
  | "today"
  | "enrich"
  | "backlog"
  | "agenda"
  | "calendar"
  | "snooze"
  | "done"
  | "archive";

export type CardMenuState = {
  signalId: string;
  anchor: HTMLElement;
};

type Props = {
  state: CardMenuState | null;
  onAct: (action: CardMenuAction, signalId: string) => void;
  onClose: () => void;
  /** codex 가용 여부 (enrich 제안 액션 활성/비활성 — graceful degrade). */
  codexReady: boolean;
};

/** 카드 ⋯ 액션 메뉴. anchor 기준 fixed 위치, 바깥 클릭/Esc로 닫힘. */
export function CardMenu({ state, onAct, onClose, codexReady }: Props) {
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

  // 바깥 클릭으로 닫기.
  useEffect(() => {
    if (!state) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".cb-card-menu") && !t.closest(".menu-btn")) onClose();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [state, onClose]);

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
      <button
        type="button"
        disabled={!codexReady}
        title={codexReady ? "codex로 영역/사분면 제안 (Jobs에서 검토·accept)" : "codex 미가용 — 설치·로그인 후 사용"}
        onClick={() => act("enrich")}
      >
        AI 제안<small>영역·사분면</small>
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
    </div>
  );
}
