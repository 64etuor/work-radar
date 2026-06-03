import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { AgentRunModal } from "@/components/agents/AgentRunModal";
import { AgentStatusBar } from "@/components/AgentStatusBar";
import { CalendarDrawer } from "@/components/board/CalendarDrawer";
import { CaptureBoard } from "@/components/CaptureBoard";
import { CmdKnob } from "@/components/CmdKnob";
import { CommandPalette } from "@/components/CommandPalette";
import ControlRoomView from "@/components/control-room/ControlRoomView";
import { useHermesTabsBootstrap } from "@/components/hermes/useHermesTabsStore";
import HermesView from "@/components/HermesView";
import { InboxView } from "@/components/InboxView";
import { JobsView } from "@/components/jobs/JobsView";
import { NewsTicker } from "@/components/news/NewsTicker";
import { PrRadarView } from "@/components/PrRadarView";
import { RetroView } from "@/components/RetroView";
import { RoutineTrackingView } from "@/components/RoutineTrackingView";
import { SettingsView } from "@/components/SettingsView";
import { SkillsView } from "@/components/SkillsView";
import { ToastHost } from "@/components/ToastHost";
import { TodayView } from "@/components/TodayView";
import { cn } from "@/components/ui/cn";
import { isOverlayOpen } from "@/components/ui/overlay-stack";
import { WeeklyView } from "@/components/WeeklyView";
import { WorktreeView } from "@/components/WorktreeView";
import { fontFamilyFor } from "@/lib/fontPresets";
import { adjacentView } from "@/lib/nav";
import { useNavKeymap } from "@/lib/query";
import { useViewShortcuts } from "@/lib/useViewShortcuts";
import { useUIStore, type View } from "@/store";

type ViewMotion = "forward" | "back";
type ViewSnapshot = {
  id: number;
  motion: ViewMotion;
  html: string;
};
const VIEW_SLIDE_CLEANUP_MS = 460;

// 뷰 라우팅 스위치 — 모듈 스코프로 두어 매 렌더마다 새 closure가 생기지 않게 한다
// (react-doctor/no-render-in-render). App 상태에 의존하지 않는 순수 매핑.
function renderView(renderedView: View) {
  if (renderedView === "settings") return <SettingsView />;
  if (renderedView === "today") return <TodayView />;
  if (renderedView === "inbox") return <InboxView />;
  if (renderedView === "weekly") return <WeeklyView />;
  if (renderedView === "retro") return <RetroView />;
  if (renderedView === "routines") return <RoutineTrackingView />;
  if (renderedView === "radar") return <PrRadarView />;
  if (renderedView === "worktree") return <WorktreeView />;
  if (renderedView === "jobs") return <JobsView />;
  if (renderedView === "skills") return <SkillsView />;
  if (renderedView === "control-room") return <ControlRoomView />;
  return <CaptureBoard />;
}

/**
 * 단일 창 셸. 전역 핫키(기본 Ctrl+Space, Rust·사용자 설정 가능)로 토글되고 Esc로 숨긴다.
 * 네비게이션 = cmdk 팔레트(Cmd+K) / Cmd+, / per-view 단축키(keymap, 입력 비포커스 시).
 * Cmd+←/→ 뷰 전환은 현재 셸 DOM snapshot을 직접 띄워 WebView 지원 차이 없이 workspace slide를 만든다.
 */
export default function App() {
  // Bootstrap Hermes multi-session store (registers event listeners + fetches cap).
  // Must be called exactly once — mounted here so both AgentStatusBar and HermesView
  // share the same store state without duplicate listener registrations.
  useHermesTabsBootstrap();

  const { view, paletteOpen, setPaletteOpen, goTo, theme, font, calendarOpen, setCalendarOpen } =
    useUIStore();
  const [viewSnapshot, setViewSnapshot] = useState<ViewSnapshot | null>(null);
  const viewSnapshotIdRef = useRef(0);
  const transitionRunningRef = useRef(false);
  const transitionTimerRef = useRef<number | null>(null);
  const navigateView = useCallback(
    (target: View, motion: ViewMotion | "neutral" = "neutral") => {
      if (motion === "neutral" || target === view) {
        setViewSnapshot(null);
        goTo(target);
        return;
      }

      if (transitionRunningRef.current) return;

      const shell = document.querySelector<HTMLElement>(".view-shell");
      const motionId = ++viewSnapshotIdRef.current;
      transitionRunningRef.current = true;

      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
        transitionTimerRef.current = null;
      }

      flushSync(() => {
        setViewSnapshot({
          id: motionId,
          motion,
          html: shell?.innerHTML ?? "",
        });
        goTo(target);
      });

      transitionTimerRef.current = window.setTimeout(() => {
        transitionRunningRef.current = false;
        transitionTimerRef.current = null;
        setViewSnapshot((snapshot) => (snapshot?.id === motionId ? null : snapshot));
      }, VIEW_SLIDE_CLEANUP_MS);
    },
    [goTo, view],
  );

  useEffect(
    () => () => {
      if (transitionTimerRef.current !== null) {
        window.clearTimeout(transitionTimerRef.current);
      }
    },
    [],
  );

  // 본문 폰트 프리셋 → `--font-sans` 토큰 덮어쓰기. 타이틀/모노는 손대지 않는다.
  useEffect(() => {
    document.documentElement.style.setProperty("--font-sans", fontFamilyFor(font));
  }, [font]);

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
      className={cn(
        theme === "dark" && "dark",
        "bg-wr-bg flex h-screen w-screen flex-col overflow-hidden",
      )}
    >
      {/* 글로벌 에이전트 상태 바 (Phase 20 #16) — 모든 뷰 위에 상주, 클릭 → Jobs. */}
      <AgentStatusBar />
      <div className="view-stage" data-slide-motion={viewSnapshot?.motion}>
        <div className="view-shell">
          <div key={view} className="view-content">
            {renderView(view)}
          </div>
        </div>
        {viewSnapshot && (
          <div
            key={viewSnapshot.id}
            className="view-snapshot"
            aria-hidden
            dangerouslySetInnerHTML={{ __html: viewSnapshot.html }}
          />
        )}
      </div>
      {/* 글로벌 뉴스 티커 — CaptureBoard 전용 콘텐츠가 아니라 모든 뷰 하단에 상주. */}
      <div className="news-ticker-slot" aria-label="전역 뉴스 배너">
        <NewsTicker />
      </div>
      {paletteOpen && <CommandPalette />}
      {/* 전역 캘린더 드로어 — 에이전트 바 우측 아이콘 / ⌘⇧C 로 토글, 모든 뷰 위에 슬라이드. */}
      <CalendarDrawer open={calendarOpen} onClose={() => setCalendarOpen(false)} />
      {/* 글로벌 에이전트 결과 모달 — 에이전트 바 박스 클릭으로만 열림(자동 오픈 없음). */}
      <AgentRunModal />
      {/* Hermes 플로팅 패널 — 전역 1회 마운트, state.open=false 시 null 렌더. */}
      <HermesView />
      {/* 전역 토스트 스택 (A7) — 모든 뷰 위에 상주, 화면 우하단 고정. */}
      <ToastHost />
      {/* 전역 오락실 조이스틱 — 트리거 hold 시 커서 위치에 등장(useCmdKnob). */}
      <CmdKnob />
    </div>
  );
}
