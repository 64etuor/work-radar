import "./CmdPageMenu.css";

import { useLayoutEffect, useRef, useState } from "react";

import { clampMenuPosition, type MenuPosition } from "@/lib/cmdPageMenuPosition";
import { NAV_ITEMS } from "@/lib/nav";
import { useUIStore } from "@/store";

const MARGIN = 8;
const CLEARANCE = 78; // 레버 베이스(124px)의 반경 + 여유 — 메뉴가 레버를 가리지 않게

/**
 * Cmd-hold 세션에서 레버와 함께 뜨는 가로 페이지 메뉴(설계 2026-06-07).
 * 모든 NAV_ITEMS를 아이콘+라벨 칩으로 펼치고, 클릭 시 goTo로 즉시 점프한다.
 * 자체 dismiss 상태 없음 — CmdKnob의 visible(=Cmd release/blur)에 종속해 함께 닫힌다.
 * 위치는 clampMenuPosition으로 origin 중앙 정렬 + 뷰포트 clamp/flip(마운트 후 실측 1회).
 */
export function CmdPageMenu({ origin }: { origin: { x: number; y: number } }) {
  const view = useUIStore((s) => s.view);
  const goTo = useUIStore((s) => s.goTo);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<MenuPosition | null>(null);

  // 마운트 후 메뉴 실측 크기로 위치 1회 계산(첫 프레임 flash 방지 위해 layout 단계에서 동기 측정→배치).
  // origin은 세션당 고정이라 origin당 1회만 set.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos(
      clampMenuPosition(
        origin,
        { w: window.innerWidth, h: window.innerHeight },
        { w: rect.width, h: rect.height },
        MARGIN,
        CLEARANCE,
      ),
    );
  }, [origin]);

  return (
    <div
      ref={ref}
      className="cmd-page-menu"
      data-placement={pos?.placement}
      style={
        pos
          ? { left: pos.left, top: pos.top, visibility: "visible" }
          : { left: 0, top: 0, visibility: "hidden" }
      }
      role="menu"
      aria-label="페이지 바로가기"
    >
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const active = item.view === view;
        return (
          <button
            key={item.view}
            type="button"
            role="menuitem"
            className="cmd-page-menu-chip"
            data-active={active || undefined}
            aria-current={active ? "page" : undefined}
            aria-label={item.label}
            onClick={() => goTo(item.view)}
          >
            <Icon className="size-4" aria-hidden />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
