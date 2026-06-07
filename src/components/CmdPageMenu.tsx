import "./CmdPageMenu.css";

import { useLayoutEffect, useRef, useState } from "react";

import { clampMenuPosition, type MenuPosition } from "@/lib/cmdPageMenuPosition";
import { NAV_ITEMS, type ViewMotion, viewMotionBetween } from "@/lib/nav";
import type { View } from "@/store";
import { useUIStore } from "@/store";

const MARGIN = 8;
const CLEARANCE = 78; // 레버 베이스(124px)의 반경 + 여유 — 메뉴가 레버를 가리지 않게

/**
 * Cmd-hold 세션에서 레버와 함께 뜨는 가로 페이지 메뉴(설계 2026-06-07).
 * 모든 NAV_ITEMS를 아이콘+라벨 칩으로 펼치고, 클릭 시 onNavigate로 점프한다 —
 * NAV 순서 기준 forward/back 슬라이드(레버 ←/→ 전환과 동일 효과)를 함께 준다.
 * 자체 dismiss 상태 없음 — CmdKnob의 visible(=Cmd release/blur)에 종속해 함께 닫힌다.
 * 위치는 clampMenuPosition으로 origin 중앙 정렬 + 뷰포트 clamp/flip(마운트 후 실측 1회).
 */
export function CmdPageMenu({
  origin,
  onNavigate,
}: {
  origin: { x: number; y: number };
  onNavigate: (view: View, motion: ViewMotion) => void;
}) {
  const view = useUIStore((s) => s.view);
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
        // left = 메뉴 가로 중심(origin.x clamp). 실제 중앙 정렬은 CSS translateX(-50%)가
        // 렌더 폭 기준으로 수행 → 측정 오차와 무관하게 레버 중심에 정확히 맞춰진다.
        pos
          ? { left: pos.centerX, top: pos.top, visibility: "visible" }
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
            onClick={() => onNavigate(item.view, viewMotionBetween(view, item.view))}
          >
            <Icon className="size-4" aria-hidden />
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
