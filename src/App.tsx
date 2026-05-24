import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { AgentStatusBar } from "@/components/AgentStatusBar";
import { isOverlayOpen } from "@/components/ui/overlay-stack";
import { CaptureBoard } from "@/components/CaptureBoard";
import { ToastHost } from "@/components/ToastHost";
import { CommandPalette } from "@/components/CommandPalette";
import { HermesView } from "@/components/HermesView";
import { JobsView } from "@/components/JobsView";
import { PrRadarView } from "@/components/PrRadarView";
import { RetroView } from "@/components/RetroView";
import { RoutineTrackingView } from "@/components/RoutineTrackingView";
import { SettingsView } from "@/components/SettingsView";
import { SkillsView } from "@/components/SkillsView";
import { TimelineView } from "@/components/TimelineView";
import { TodayView } from "@/components/TodayView";
import { WeeklyView } from "@/components/WeeklyView";
import { WorktreeView } from "@/components/WorktreeView";
import { adjacentView } from "@/lib/nav";
import { useNavKeymap } from "@/lib/query";
import { useViewShortcuts } from "@/lib/useViewShortcuts";
import { useUIStore } from "@/store";

/**
 * 단일 창 셸. 전역 핫키(기본 Ctrl+Space, Rust·사용자 설정 가능)로 토글되고 Esc로 숨긴다.
 * 네비게이션 = cmdk 팔레트(Cmd+K) / Cmd+, / per-view 단축키(keymap, 입력 비포커스 시).
 * 뷰 전환은 view 키 기반 subtle CSS 트랜지션(styles.css .view-shell).
 */
export default function App() {
  const { view, paletteOpen, setPaletteOpen, goTo, theme } = useUIStore();

  // per-view 단축키 (Phase 18 #7) — 입력 비포커스 + 팔레트 닫힘일 때만 활성.
  // Cmd+←/→ → NAV_ITEMS 순서 기준 인접 뷰 전환(P3).
  const keymap = useNavKeymap();
  useViewShortcuts(
    keymap.data,
    !paletteOpen,
    (v) => goTo(v),
    (dir) => goTo(adjacentView(view, dir)),
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      // Cmd/Ctrl+K → 명령 팔레트 토글.
      if (meta && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(!paletteOpen);
        return;
      }
      // Cmd/Ctrl+, → 설정 바로 열기.
      if (meta && e.key === ",") {
        e.preventDefault();
        goTo("settings", "open");
        return;
      }
      if (e.key === "Escape") {
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        // shadcn 오버레이(Dialog/DropdownMenu/Select)가 열려 있으면 radix가 Esc로 최상위 레이어를
        // 닫고 포커스를 복원한다 — 셸은 창을 숨기지 않고 양보한다(plan §0.6 상호작용 계약).
        if (isOverlayOpen()) return;
        // (레거시) 커스텀 카드 메뉴가 열려 있으면 그 닫힘을 CaptureBoard에 맡기고 창은 유지한다.
        if (document.querySelector(".cb-card-menu")) return;
        // board 외 뷰는 Esc로 보드 복귀, board에서 Esc는 창 숨김.
        if (view !== "board") {
          goTo("board");
          return;
        }
        void getCurrentWindow().hide();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, paletteOpen, setPaletteOpen, goTo]);

  return (
    <div
      className={`${theme === "dark" ? "dark " : ""}flex h-screen w-screen flex-col overflow-hidden bg-wr-bg`}
    >
      {/* 글로벌 에이전트 상태 바 (Phase 20 #16) — 모든 뷰 위에 상주, 클릭 → Jobs. */}
      <AgentStatusBar />
      {/* view 키로 remount → subtle enter 트랜지션(styles.css .view-shell). 과한 모션 금지(상주 유틸). */}
      <div key={view} className="view-shell">
        {view === "settings" ? (
          <SettingsView />
        ) : view === "today" ? (
          <TodayView />
        ) : view === "timeline" ? (
          <TimelineView />
        ) : view === "weekly" ? (
          <WeeklyView />
        ) : view === "retro" ? (
          <RetroView />
        ) : view === "routines" ? (
          <RoutineTrackingView />
        ) : view === "radar" ? (
          <PrRadarView />
        ) : view === "worktree" ? (
          <WorktreeView />
        ) : view === "jobs" ? (
          <JobsView />
        ) : view === "hermes" ? (
          <HermesView />
        ) : view === "skills" ? (
          <SkillsView />
        ) : (
          <CaptureBoard />
        )}
      </div>
      {paletteOpen && <CommandPalette />}
      {/* 전역 토스트 스택 (A7) — 모든 뷰 위에 상주, 화면 우하단 고정. */}
      <ToastHost />
    </div>
  );
}
