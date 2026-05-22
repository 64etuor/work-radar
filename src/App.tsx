import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { CaptureBoard } from "@/components/CaptureBoard";
import { CommandPalette } from "@/components/CommandPalette";
import { JobsView } from "@/components/JobsView";
import { PrRadarView } from "@/components/PrRadarView";
import { RetroView } from "@/components/RetroView";
import { SettingsView } from "@/components/SettingsView";
import { TimelineView } from "@/components/TimelineView";
import { TodayView } from "@/components/TodayView";
import { WeeklyView } from "@/components/WeeklyView";
import { WorktreeView } from "@/components/WorktreeView";
import { useUIStore } from "@/store";

/**
 * 단일 창 셸. 전역 핫키(Alt+Space, Rust)로 토글되고 Esc로 숨긴다.
 * 보드↔설정 네비게이션은 cmdk 팔레트(Cmd+K) / Cmd+, 로 한다 (단일 창 유지).
 */
export default function App() {
  const { view, paletteOpen, setPaletteOpen, goTo } = useUIStore();

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
        // 카드 메뉴가 열려 있으면 그 닫힘을 CaptureBoard에 맡기고 창은 유지한다.
        if (document.querySelector(".cb-card-menu")) return;
        if (
          view === "settings" ||
          view === "today" ||
          view === "timeline" ||
          view === "weekly" ||
          view === "retro" ||
          view === "radar" ||
          view === "worktree" ||
          view === "jobs"
        ) {
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
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-wr-bg">
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
      ) : view === "radar" ? (
        <PrRadarView />
      ) : view === "worktree" ? (
        <WorktreeView />
      ) : view === "jobs" ? (
        <JobsView />
      ) : (
        <CaptureBoard />
      )}
      {paletteOpen && <CommandPalette />}
    </div>
  );
}
