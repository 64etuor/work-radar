import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { PanelLeft, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { commands, type HermesPanelState } from "@/bindings";
import { Button } from "@/components/ui/button";
import { unwrap } from "@/lib/query/client";

import { clampToViewport, defaultBounds } from "./clampToViewport";
import { DEFAULT_PANEL_STATE, useHermesPanelState } from "./useHermesPanelState";

// useHermesPanelState 와 반드시 동일한 키.
const PANEL_QUERY_KEY = ["hermes-panel-state"] as const;

export function HermesPanel({
  children,
  onRestart,
  isStreaming,
  showHeaderTitle,
  sidebarOpen,
  onToggleSidebar,
  headerExtra,
}: {
  children: React.ReactNode;
  onRestart?: () => void;
  isStreaming?: boolean;
  /** 헤더 우측 버튼 그룹 앞에 끼워 넣을 추가 컨트롤(예: 세션 프로젝트 바인딩 선택). */
  headerExtra?: React.ReactNode;
  /** false면 헤더 'Hermes' 타이틀 숨김(빈 상태 중앙 워드마크와 중복 방지). true로 전환되면 블러인. */
  showHeaderTitle?: boolean;
  /** 좌측 세션 사이드바 표시 여부(상단 토글 버튼이 제어). undefined면 토글 버튼 숨김. */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
}) {
  const { state, setOpen, setBounds, isLoading } = useHermesPanelState();
  const qc = useQueryClient();

  // 초기 배치: 좌표/크기 중 하나라도 null 이면 defaultBounds 로 초기화.
  // (백엔드 Option<f64> 설계와 일치 — shape-equality 휴리스틱 회피)
  useEffect(() => {
    if (isLoading) return;
    if (state.x == null || state.y == null || state.w == null || state.h == null) {
      setBounds(defaultBounds(window.innerWidth, window.innerHeight));
    }
  }, [isLoading, state.x, state.y, state.w, state.h, setBounds]);

  // 마운트 1회만 구독 — qc.getQueryData 로 최신 상태를 읽어 stale closure 없이
  // 토글/오픈. cancelled 가드로 listen() 비동기 등록과 cleanup 경쟁 차단.
  // hermes:toggle — 현재 open 상태를 반전.
  // hermes:open   — 항상 open: true (이미 열려 있으면 no-op).
  useEffect(() => {
    let unlistenToggle: (() => void) | undefined;
    let unlistenOpen: (() => void) | undefined;
    let cancelled = false;

    void listen("hermes:toggle", () => {
      const current = qc.getQueryData<HermesPanelState>(PANEL_QUERY_KEY);
      const next: HermesPanelState = {
        ...(current ?? DEFAULT_PANEL_STATE),
        open: !(current?.open ?? false),
      };
      qc.setQueryData(PANEL_QUERY_KEY, next);
      void unwrap(commands.hermesPanelStateSet(next));
    }).then((u) => {
      if (cancelled) u();
      else unlistenToggle = u;
    });

    void listen("hermes:open", () => {
      const current = qc.getQueryData<HermesPanelState>(PANEL_QUERY_KEY);
      if (current?.open) return; // idempotent
      const next: HermesPanelState = {
        ...(current ?? DEFAULT_PANEL_STATE),
        open: true,
      };
      qc.setQueryData(PANEL_QUERY_KEY, next);
      void unwrap(commands.hermesPanelStateSet(next));
    }).then((u) => {
      if (cancelled) u();
      else unlistenOpen = u;
    });

    return () => {
      cancelled = true;
      unlistenToggle?.();
      unlistenOpen?.();
    };
  }, [qc]);

  // 패널 열림 시에만 Esc 리스너 등록 — 닫힌 상태에서 글로벌 키 가로채지 않도록.
  useEffect(() => {
    if (!state.open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.open, setOpen]);

  // 뷰포트 리사이즈 시 패널이 영역을 벗어나면 즉시 클램프.
  useEffect(() => {
    const onResize = () => {
      if (state.x == null || state.y == null || state.w == null || state.h == null) return;
      const clamped = clampToViewport(
        { x: state.x, y: state.y, w: state.w, h: state.h },
        window.innerWidth,
        window.innerHeight,
      );
      if (
        clamped.x !== state.x ||
        clamped.y !== state.y ||
        clamped.w !== state.w ||
        clamped.h !== state.h
      ) {
        setBounds(clamped);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [state.x, state.y, state.w, state.h, setBounds]);

  // 마운트 컨트롤러: 닫힘 시 즉시 언마운트하지 않고 fade-out 동안 노드를 유지한다.
  // open=true → 즉시 마운트(파생, setState 불필요) + data-state="open"(fade-in).
  // open=false → data-state="closed"(fade-out). isClosing 동안 노드 유지 →
  //   animationend(또는 폴백 타임아웃)에 isClosing 해제 → 언마운트.
  // (reduced-motion 은 animation:none → animationend 미발생 → 타임아웃이 언마운트한다.)
  const [isClosing, setIsClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // open 직전 값 — true→false 전이에서만 fade-out 을 시작한다.
  const prevOpenRef = useRef(state.open);

  useEffect(() => {
    const prevOpen = prevOpenRef.current;
    prevOpenRef.current = state.open;
    if (state.open) {
      // 열림(혹은 닫는 중 재오픈): 진행 중 fade-out 타임아웃 취소.
      // isClosing 은 render 가 state.open OR isClosing 으로 마운트를 결정하므로
      // 굳이 여기서 끄지 않아도 무해하다(다음 닫힘 사이클이 재설정). setState-in-effect 회피.
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      return;
    }
    // 막 닫힌 경우에만 fade-out 시작(이미 닫혀 있던 마운트엔 no-op).
    if (!prevOpen) return;
    setIsClosing(true);
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    // wr-motion-panel(0.22s) + 여유. animationend 가 먼저 오면 그쪽에서 정리한다.
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setIsClosing(false);
    }, 280);
    return () => {
      if (closeTimerRef.current !== null) {
        clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [state.open]);

  // 패널을 "열 때마다" 화면 중앙 + 기본(세로로 긴) 크기로 재배치한다(사용자 요청:
  // 처음 열면 가운데, 세로로 길게). 열려 있는 동안의 드래그/리사이즈는 유지되지만
  // 닫았다 다시 열면 중앙 기본으로 돌아온다. closed→open 전이에서만 1회 동작.
  const prevOpenForCenterRef = useRef(state.open);
  useEffect(() => {
    const was = prevOpenForCenterRef.current;
    prevOpenForCenterRef.current = state.open;
    if (state.open && !was) {
      setBounds(defaultBounds(window.innerWidth, window.innerHeight));
    }
  }, [state.open, setBounds]);

  if (!state.open && !isClosing) return null;

  const x = state.x ?? 0;
  const y = state.y ?? 0;
  // bounds 로드 전 일시 fallback. defaultBounds(720×780, 세로로 김)와 맞춰 open 시 600→780 깜빡임 방지.
  const w = state.w ?? 720;
  const h = state.h ?? 780;

  return (
    <section
      aria-label="Hermes"
      data-state={state.open ? "open" : "closed"}
      onAnimationEnd={(e) => {
        // fade-out 종료 시 즉시 언마운트(타임아웃보다 우선). 자식 애니메이션은 무시.
        if (e.target !== e.currentTarget) return;
        if (!state.open) {
          if (closeTimerRef.current !== null) {
            clearTimeout(closeTimerRef.current);
            closeTimerRef.current = null;
          }
          setIsClosing(false);
        }
      }}
      style={{
        transform: `translate3d(${x}px, ${y}px, 0)`,
        width: w,
        height: h,
      }}
      className="hermes-panel-root bg-background border-border fixed z-50 flex flex-col overflow-hidden rounded-lg border font-sans shadow-lg"
    >
      {/* 스트리밍 중에만 — 패널 4변을 시계방향으로 돌며 흐르는 light beam.
       * root가 rounded-lg + overflow-hidden 이라 코너서 자연 클립. */}
      {isStreaming && (
        <div
          aria-hidden
          className="hermes-border-light pointer-events-none absolute inset-0 z-10 overflow-hidden rounded-lg"
        >
          <span className="hbl-top" />
          <span className="hbl-right" />
          <span className="hbl-bottom" />
          <span className="hbl-left" />
        </div>
      )}
      <PanelHeader
        x={x}
        y={y}
        w={w}
        h={h}
        onBoundsChange={setBounds}
        onClose={() => setOpen(false)}
        onRestart={onRestart}
        isStreaming={isStreaming}
        showHeaderTitle={showHeaderTitle}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
        headerExtra={headerExtra}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      <ResizeGrip x={x} y={y} w={w} h={h} onBoundsChange={setBounds} />
    </section>
  );
}

// ── 내부 컴포넌트 ──────────────────────────────────────────────────────────

interface BoundsProps {
  x: number;
  y: number;
  w: number;
  h: number;
  onBoundsChange: (b: Partial<{ x: number; y: number; w: number; h: number }>) => void;
}

function PanelHeader({
  x,
  y,
  w,
  h,
  onBoundsChange,
  onClose,
  onRestart,
  isStreaming,
  showHeaderTitle,
  sidebarOpen,
  onToggleSidebar,
  headerExtra,
}: BoundsProps & {
  onClose: () => void;
  onRestart?: () => void;
  isStreaming?: boolean;
  showHeaderTitle?: boolean;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  headerExtra?: React.ReactNode;
}) {
  const dragRef = useRef<{
    startPx: number;
    startPy: number;
    startX: number;
    startY: number;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startPx: e.clientX, startPy: e.clientY, startX: x, startY: y };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startPx;
    const dy = e.clientY - dragRef.current.startPy;
    const next = clampToViewport(
      { x: dragRef.current.startX + dx, y: dragRef.current.startY + dy, w, h },
      window.innerWidth,
      window.innerHeight,
    );
    onBoundsChange({ x: next.x, y: next.y });
  };

  // pointercancel 도 동일 핸들러로 드래그 상태 정리.
  const onPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div
      className="relative flex shrink-0 cursor-grab items-center px-2.5 py-1.5 select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {onToggleSidebar && (
        <Button
          data-no-drag
          variant="ghost"
          className="hover:bg-muted/60 mr-1 size-7 shrink-0 p-0"
          onClick={onToggleSidebar}
          aria-label={sidebarOpen ? "세션 목록 숨기기" : "세션 목록 보기"}
          aria-pressed={sidebarOpen}
          title={sidebarOpen ? "세션 목록 숨기기" : "세션 목록 보기"}
        >
          <PanelLeft className="size-3.5" />
        </Button>
      )}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        {/* 첫 메시지 이후에만 노출(중앙 워드마크 exit → 약간의 딜레이 후 블러인). */}
        {showHeaderTitle && (
          <span className="hermes-header-title ml-1.5 font-mono text-sm font-medium tracking-tight">
            Hermes
          </span>
        )}
      </span>
      {isStreaming && (
        // 작성 중 표시는 헤더 가운데에 고정(좌측 타이틀/우측 버튼과 무관) — 아우라와 시각 정렬.
        <span
          className="text-muted-foreground pointer-events-none absolute left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 text-xs"
          aria-live="polite"
        >
          <span className="inline-flex gap-0.5" aria-hidden>
            <span className="size-1 animate-[hermesDot_1.2s_ease-in-out_infinite] rounded-full bg-current" />
            <span className="size-1 animate-[hermesDot_1.2s_ease-in-out_infinite] rounded-full bg-current [animation-delay:0.15s]" />
            <span className="size-1 animate-[hermesDot_1.2s_ease-in-out_infinite] rounded-full bg-current [animation-delay:0.3s]" />
          </span>
          작성 중
        </span>
      )}
      <div className="flex items-center gap-1" data-no-drag>
        {headerExtra}
        {onRestart && (
          <Button
            data-no-drag
            variant="ghost"
            className="hover:bg-muted/60 size-7 p-0"
            onClick={() => void onRestart()}
            aria-label="에이전트 재시작"
            title="에이전트 재시작 (대화 유지)"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        )}
        <Button
          data-no-drag
          variant="ghost"
          onClick={onClose}
          aria-label="닫기"
          className="hover:bg-muted/60 size-7 p-0"
        >
          <X className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ResizeGrip({ x, y, w, h, onBoundsChange }: BoundsProps) {
  const resizeRef = useRef<{
    startPx: number;
    startPy: number;
    startW: number;
    startH: number;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    resizeRef.current = { startPx: e.clientX, startPy: e.clientY, startW: w, startH: h };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return;
    const dw = e.clientX - resizeRef.current.startPx;
    const dh = e.clientY - resizeRef.current.startPy;
    const next = clampToViewport(
      { x, y, w: resizeRef.current.startW + dw, h: resizeRef.current.startH + dh },
      window.innerWidth,
      window.innerHeight,
    );
    onBoundsChange({ w: next.w, h: next.h });
  };

  // pointercancel 도 동일 핸들러로 리사이즈 상태 정리.
  const onPointerUp = () => {
    resizeRef.current = null;
  };

  return (
    <div
      className="absolute right-0 bottom-0 size-4 cursor-se-resize"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      aria-hidden
    />
  );
}
