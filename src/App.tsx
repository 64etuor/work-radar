import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { AgentStatusBar } from "@/components/AgentStatusBar";
import { isOverlayOpen } from "@/components/ui/overlay-stack";
import { CalendarDrawer } from "@/components/board/CalendarDrawer";
import { EnrichReviewPanel } from "@/components/board/EnrichReviewPanel";
import { CaptureBoard } from "@/components/CaptureBoard";
import { NewsTicker } from "@/components/news/NewsTicker";
import { ToastHost } from "@/components/ToastHost";
import { CommandPalette } from "@/components/CommandPalette";
import { InboxView } from "@/components/InboxView";
import { JobsView } from "@/components/jobs/JobsView";
import { PrRadarView } from "@/components/PrRadarView";
import { RetroView } from "@/components/RetroView";
import { RoutineTrackingView } from "@/components/RoutineTrackingView";
import { SettingsView } from "@/components/SettingsView";
import { SkillsView } from "@/components/SkillsView";
import { TodayView } from "@/components/TodayView";
import { WeeklyView } from "@/components/WeeklyView";
import { WorktreeView } from "@/components/WorktreeView";
import { adjacentView } from "@/lib/nav";
import { useNavKeymap } from "@/lib/query";
import { useViewShortcuts } from "@/lib/useViewShortcuts";
import { useUIStore, type View } from "@/store";

type ViewMotion = "forward" | "back" | "neutral";
type ViewTransitionHandle = { finished: Promise<void> };
type ViewTransitionDocument = Document & {
  startViewTransition?: (updateCallback: () => void) => ViewTransitionHandle;
};

/**
 * 단일 창 셸. 전역 핫키(기본 Ctrl+Space, Rust·사용자 설정 가능)로 토글되고 Esc로 숨긴다.
 * 네비게이션 = cmdk 팔레트(Cmd+K) / Cmd+, / per-view 단축키(keymap, 입력 비포커스 시).
 * 뷰 전환은 View Transitions API 기반 workspace slide + CSS fallback(styles/motion.css).
 */
export default function App() {
  const {
    view,
    paletteOpen,
    setPaletteOpen,
    goTo,
    theme,
    calendarOpen,
    setCalendarOpen,
    enrichAllRunId,
    setEnrichAllRunId,
    setEnrichAllGenerating,
  } = useUIStore();
  const [viewMotion, setViewMotion] = useState<ViewMotion>("neutral");
  const viewMotionIdRef = useRef(0);
  const navigateView = useCallback(
    (target: View, motion: ViewMotion = "neutral") => {
      const update = () => {
        setViewMotion(motion);
        goTo(target);
      };

      if (motion === "neutral") {
        update();
        return;
      }

      const root = document.documentElement;
      const motionId = String(++viewMotionIdRef.current);
      root.dataset.viewMotion = motion;
      root.dataset.viewMotionId = motionId;
      const transition = (document as ViewTransitionDocument).startViewTransition?.(() => {
        flushSync(update);
      });

      if (!transition) {
        update();
        if (root.dataset.viewMotionId === motionId) {
          delete root.dataset.viewMotion;
          delete root.dataset.viewMotionId;
        }
        return;
      }

      void transition.finished.finally(() => {
        if (root.dataset.viewMotionId === motionId) {
          delete root.dataset.viewMotion;
          delete root.dataset.viewMotionId;
        }
      });
    },
    [goTo],
  );

  // per-view 단축키 (Phase 18 #7) — 입력 비포커스 + 팔레트 닫힘일 때만 활성.
  // Cmd+←/→ → NAV_ITEMS 순서 기준 인접 뷰 전환(P3).
  const keymap = useNavKeymap();
  useViewShortcuts(
    keymap.data,
    !paletteOpen,
    (action) => {
      if (action === "calendar") setCalendarOpen(!calendarOpen);
      else navigateView(action as View, "neutral");
    },
    (dir) => {
      const motion = dir > 0 ? "forward" : "back";
      navigateView(adjacentView(view, dir), motion);
    },
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
      // 설정(Cmd+,)·캘린더(Cmd+Shift+C) 등은 이제 per-view keymap(useViewShortcuts)이 처리 —
      // 설정에서 변경 가능. 여기선 팔레트 토글(Cmd+K)과 Esc만 하드코딩.
      if (e.key === "Escape") {
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        // 오버레이(shadcn Dialog/DropdownMenu/Select + CardMenu)가 열려 있으면 overlay-stack에
        // 등록돼 있으므로 셸은 창을 숨기지 않고 양보한다 — 각 오버레이가 Esc 닫기·포커스 복원 전담
        // (plan §0.6 상호작용 계약). CardMenu도 overlay-stack 계약을 채택했다.
        if (isOverlayOpen()) return;
        // board 외 뷰는 Esc로 보드 복귀, board에서 Esc는 창 숨김.
        if (view !== "board") {
          navigateView("board", "neutral");
          return;
        }
        void getCurrentWindow().hide();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, paletteOpen, setPaletteOpen, navigateView]);

  return (
    <div
      className={`${theme === "dark" ? "dark " : ""}flex h-screen w-screen flex-col overflow-hidden bg-wr-bg`}
    >
      {/* 글로벌 에이전트 상태 바 (Phase 20 #16) — 모든 뷰 위에 상주, 클릭 → Jobs. */}
      <AgentStatusBar />
      {/* view 키로 remount → View Transition 지원 시 old/new slide, 미지원 시 subtle enter fallback. */}
      <div key={view} className={`view-shell view-shell-${viewMotion}`}>
        {view === "settings" ? (
          <SettingsView />
        ) : view === "today" ? (
          <TodayView />
        ) : view === "inbox" ? (
          <InboxView />
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
        ) : view === "skills" ? (
          <SkillsView />
        ) : (
          <CaptureBoard />
        )}
      </div>
      {/* 글로벌 뉴스 티커 — CaptureBoard 전용 콘텐츠가 아니라 모든 뷰 하단에 상주. */}
      <div className="news-ticker-slot" aria-label="전역 뉴스 배너">
        <NewsTicker />
      </div>
      {paletteOpen && <CommandPalette />}
      {/* 전역 캘린더 드로어 — 에이전트 바 우측 아이콘 / ⌘⇧C 로 토글, 모든 뷰 위에 슬라이드. */}
      <CalendarDrawer open={calendarOpen} onClose={() => setCalendarOpen(false)} />
      {enrichAllRunId && (
        <EnrichReviewPanel
          runId={enrichAllRunId}
          onClose={() => {
            setEnrichAllRunId(null);
            setEnrichAllGenerating(false);
          }}
          onRunningChange={setEnrichAllGenerating}
        />
      )}
      {/* 전역 토스트 스택 (A7) — 모든 뷰 위에 상주, 화면 우하단 고정. */}
      <ToastHost />
    </div>
  );
}
