import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { RotateCcw, X } from "lucide-react";
import { useEffect, useRef } from "react";

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
}: {
  children: React.ReactNode;
  onRestart?: () => void;
  isStreaming?: boolean;
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
  // 토글. cancelled 가드로 listen() 비동기 등록과 cleanup 경쟁 차단.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
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
      else unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
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

  if (!state.open) return null;

  const x = state.x ?? 0;
  const y = state.y ?? 0;
  const w = state.w ?? 460;
  const h = state.h ?? 600;

  return (
    // TODO(a11y): focus trap + restore
    <div
      role="dialog"
      aria-label="Hermes"
      aria-modal="false"
      style={{
        transform: `translate3d(${x}px, ${y}px, 0)`,
        width: w,
        height: h,
      }}
      className="bg-background border-border fixed z-50 flex flex-col overflow-hidden rounded-lg border font-sans shadow-lg"
    >
      <PanelHeader
        x={x}
        y={y}
        w={w}
        h={h}
        onBoundsChange={setBounds}
        onClose={() => setOpen(false)}
        onRestart={onRestart}
        isStreaming={isStreaming}
      />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      <ResizeGrip x={x} y={y} w={w} h={h} onBoundsChange={setBounds} />
    </div>
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
}: BoundsProps & { onClose: () => void; onRestart?: () => void; isStreaming?: boolean }) {
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
      className="flex shrink-0 cursor-grab items-center px-2.5 py-1.5 select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="text-sm font-medium tracking-tight">Hermes</span>
        {isStreaming && (
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
            <span className="inline-flex gap-0.5" aria-hidden>
              <span className="size-1 animate-[hermesDot_1.2s_ease-in-out_infinite] rounded-full bg-current" />
              <span className="size-1 animate-[hermesDot_1.2s_ease-in-out_infinite] rounded-full bg-current [animation-delay:0.15s]" />
              <span className="size-1 animate-[hermesDot_1.2s_ease-in-out_infinite] rounded-full bg-current [animation-delay:0.3s]" />
            </span>
            작성 중
          </span>
        )}
      </span>
      <div className="flex items-center gap-1" data-no-drag>
        {onRestart && (
          <Button
            data-no-drag
            variant="ghost"
            className="hover:bg-muted/60 h-7 w-7 p-0"
            onClick={onRestart}
            aria-label="새 세션"
            title="새 세션 시작"
          >
            <RotateCcw className="size-3.5" />
          </Button>
        )}
        <Button
          data-no-drag
          variant="ghost"
          onClick={onClose}
          aria-label="닫기"
          className="hover:bg-muted/60 h-7 w-7 p-0"
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
